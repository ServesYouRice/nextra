'use strict';

// Portable replacement for the retired scripts/smoke-packaged.ps1. Runs the identical assertion
// set against a packaged executable on both Windows and macOS: readiness, the
// static shell, the Socket.IO handshake, compliance artifacts, the
// mediasoup-worker-kill recovery path, the decoded-frame Playwright flow,
// graceful shutdown, and leftover-process cleanup compared to a pre-launch
// baseline so unrelated pre-existing processes never fail the run.
//
// Invoked by .github/workflows/ci.yml (windows-package) and
// .github/workflows/release.yml (package-smoke).
//
// Usage: node scripts/smoke-packaged.js [executablePath]
//   executablePath defaults to Nextra.exe (win32) or Nextra-macos-<arch>
//   (darwin), resolved against the repository root -- the same names
//   scripts/package-app.js writes.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

const projectRoot = path.resolve(__dirname, '..');
const port = 31847;
const baseUrl = `http://127.0.0.1:${port}`;

const defaultExecutableName = process.platform === 'win32' ? 'Nextra.exe' : `Nextra-macos-${process.arch}`;
const executablePath = path.resolve(projectRoot, process.argv[2] || defaultExecutableName);

const childEnv = {
    ...process.env,
    AUTO_PUBLIC_TUNNEL: 'false',
    OPEN_BROWSER: 'false',
    PORT: String(port),
    NEXTRA_SMOKE_TEST: '1',
    LOCAL_HTTPS: 'false',
    BIND_HOST: '127.0.0.1',
    WORKER_RECOVERY_MIN_UPTIME_SECONDS: '0',
};

// caxa unpacks a packaged executable under a "caxa/applications/nextra-<id>"
// cache directory and runs it from there on both platforms.
const CAXA_PATTERN = /[\\/]caxa[\\/]applications[\\/]nextra-/;
// The extraction itself, <tmp>/caxa/applications/nextra-<id>/<attempt>. The server the caxa
// stub starts and the replacement that server spawns from process.execPath both run from it.
const CAXA_APPLICATION_DIRECTORY_PATTERN = /[\\/]caxa[\\/]applications[\\/](nextra-[^\\/\s"']+)(?:[\\/](\d+))?/i;
const CLOUDFLARED_PATTERN = /(^|[\\/])cloudflared(\.exe)?(\s|$)/i;
const PROCESS_LIST_MAX_BUFFER = 8 * 1024 * 1024;

// One HTTP call, bounded by timeoutMs from the request to the end of the body. fetch() resolves
// as soon as the response headers arrive, so the body is read (read = 'json' | 'text') or
// dropped (read = 'none') before the abort timer is cleared; a server that sends headers and
// then stalls makes the read reject with an AbortError instead of hanging a stage. Callers get
// { status, ok, body } and never touch the Response, so they cannot read a body unbounded.
// A caller's options.signal (the run's, aborted when the stages stop) ends the call early too.
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000, read = 'none') {
    if (read !== 'json' && read !== 'text' && read !== 'none') {
        throw new TypeError(`Unknown response read mode: ${read}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    try {
        const response = await fetch(url, { ...options, signal });
        let body = null;
        if (read === 'json') {
            body = await response.json();
        } else if (read === 'text') {
            body = await response.text();
        } else {
            // Not needed, but an unread body keeps its connection busy until the process ends.
            await response.body?.cancel();
        }
        return { status: response.status, ok: response.ok, body };
    } finally {
        clearTimeout(timer);
    }
}

function isConnectionRefused(err) {
    const cause = err?.cause ?? err;
    if (Array.isArray(cause?.errors) && cause.errors.length > 0) {
        return cause.errors.every((inner) => inner?.code === 'ECONNREFUSED');
    }
    return cause?.code === 'ECONNREFUSED';
}

function describeError(err) {
    const code = err?.cause?.code || err?.code;
    return `${err?.name || 'Error'}${code ? ` (${code})` : ''}: ${err?.message || String(err)}`;
}

// Runs before the launch. A server already answering the smoke port would receive every
// check, the worker kill and the shutdown meant for the executable under test, so any HTTP
// answer means the port is taken; only a refused connection lets the run go on.
async function assertSmokePortFree(url = baseUrl, timeoutMs = 1000) {
    const smokePort = new URL(url).port;
    let answer;
    try {
        answer = await fetchWithTimeout(`${url}/healthz`, {}, timeoutMs, 'none');
    } catch (err) {
        if (isConnectionRefused(err)) return;
        throw new Error(`Smoke port ${smokePort} is not free: probing ${url}/healthz ended in ${describeError(err)} `
            + 'instead of a refused connection. Stop whatever holds the port before running the packaged smoke.', { cause: err });
    }
    throw new Error(`Smoke port ${smokePort} is occupied: ${url}/healthz answered HTTP ${answer.status} before the `
        + 'packaged executable was launched. Stop the server holding the port before running the packaged smoke.');
}

// ---------------------------------------------------------------------------
// Process enumeration -- one helper, branched per platform, both returning
// { pid, ppid, command } records so matching and cleanup below stay platform-agnostic.
// ---------------------------------------------------------------------------

function parseWindowsProcessList(stdout) {
    let rows = JSON.parse(stdout);
    if (!Array.isArray(rows)) rows = [rows];
    return rows
        .filter((row) => row && Number.isInteger(row.ProcessId))
        .map((row) => ({
            pid: row.ProcessId,
            ppid: Number.isInteger(row.ParentProcessId) ? row.ParentProcessId : null,
            command: [row.CommandLine, row.ExecutablePath, row.Name].filter(Boolean).join(' '),
        }));
}

function parsePsProcessList(stdout) {
    return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const match = line.match(/^(\d+)\s+(\d+)(?:\s+(.*))?$/);
            return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] || '' } : null;
        })
        .filter(Boolean);
}

function listProcesses() {
    if (process.platform === 'win32') {
        // Same Win32_Process query the PowerShell smoke used. CommandLine,
        // ExecutablePath, and Name are folded into one searchable string per
        // record so the platform-agnostic matchers below need only `command`.
        const result = spawnSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | '
            + 'Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress',
        ], { encoding: 'utf8', windowsHide: true, maxBuffer: PROCESS_LIST_MAX_BUFFER });
        if (result.status !== 0 || !result.stdout) return [];
        try {
            return parseWindowsProcessList(result.stdout);
        } catch {
            return [];
        }
    }

    const result = spawnSync('ps', ['-Ao', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: PROCESS_LIST_MAX_BUFFER });
    if (result.status !== 0 || !result.stdout) return [];
    return parsePsProcessList(result.stdout);
}

function isSmokeExecutable(record) {
    const command = record.command || '';
    if (CAXA_PATTERN.test(command)) return true;
    return process.platform === 'win32'
        ? command.toLowerCase().includes(executablePath.toLowerCase())
        : command.includes(executablePath);
}

function isCloudflared(record) {
    return CLOUDFLARED_PATTERN.test(record.command || '');
}

function killProcess(pid) {
    try {
        process.kill(pid, 'SIGKILL');
    } catch {
        // Already gone, or not ours to signal -- matches -ErrorAction SilentlyContinue.
    }
}

// ---------------------------------------------------------------------------
// Ownership -- the run checks, kills the worker of and shuts down only a server it launched.
// ---------------------------------------------------------------------------

// True when pid is rootPid itself or descends from it through the records' parent PIDs. A
// walk that leaves the list or loops ends without proof.
function isDescendant(pid, rootPid, records) {
    if (!Number.isInteger(pid) || !Number.isInteger(rootPid)) return false;
    const parents = new Map((records || []).map((record) => [record.pid, record.ppid]));
    const visited = new Set();
    let current = pid;
    while (Number.isInteger(current) && !visited.has(current)) {
        if (current === rootPid) return true;
        visited.add(current);
        current = parents.get(current);
    }
    return false;
}

// "nextra-<id>/<attempt>" for a command running from a caxa extraction, else null. Only that
// part is compared: the temp-dir prefix in front of it can be spelled differently for the same
// directory (the caxa stub joins it with forward slashes, Node's process.execPath uses the
// platform's separators and on macOS resolves /var to /private/var), so separators and case
// are normalized and the prefix is dropped.
function caxaApplicationDirectory(command) {
    const match = typeof command === 'string' ? command.match(CAXA_APPLICATION_DIRECTORY_PATTERN) : null;
    if (!match) return null;
    return [match[1], match[2]].filter(Boolean).join('/').toLowerCase();
}

// Whether the PID answering the port after worker recovery belongs to this run. A replacement
// is adopted only while the port was never answered by a process the run does not own, and
// only when it runs from the same caxa extraction as the server verified at readiness. The
// server runs its replacement as a child of the original process, which stays alive, so the
// replacement must also descend from the launched child: caxa reuses one extraction for every
// instance of a build, so the directory alone cannot tell the replacement from another copy.
// Only once the launched child has exited (a relaunch that hands over and exits 0) can the
// ancestry be gone (reparented on POSIX, a dead parent on Windows), and only then is it not
// required. verdict: 'owned' | 'adopt' | 'unowned'.
function decideReplacementAdoption({
    pid, ownedPids, records, childPid, childExited = false, ownedCaxaDirectory, portObservedUnowned,
}) {
    if (!Number.isInteger(pid)) {
        return { verdict: 'unowned', reason: 'the answer on the port named no process ID' };
    }
    if (ownedPids.has(pid)) return { verdict: 'owned', reason: `PID ${pid} is already owned by this run` };
    if (portObservedUnowned) {
        return { verdict: 'unowned', reason: `the port was already answered by a process this run does not own, so PID ${pid} is not adopted` };
    }
    if (!ownedCaxaDirectory) {
        return { verdict: 'unowned', reason: `the launched server's caxa extraction is unknown, so PID ${pid} cannot be matched to it` };
    }
    const record = (records || []).find((entry) => entry.pid === pid);
    if (!record) return { verdict: 'unowned', reason: `PID ${pid} is not in the process list` };
    if (!childExited && !isDescendant(pid, childPid, records)) {
        return {
            verdict: 'unowned',
            reason: `PID ${pid} does not descend from the launched executable (PID ${childPid ?? 'none'}), which is still running`,
        };
    }
    const directory = caxaApplicationDirectory(record.command);
    if (directory !== ownedCaxaDirectory) {
        const where = directory ? `caxa extraction ${directory}` : 'outside any caxa extraction';
        return { verdict: 'unowned', reason: `PID ${pid} runs from ${where}, not the launched build's ${ownedCaxaDirectory}` };
    }
    return { verdict: 'adopt', reason: `PID ${pid} runs from the launched build's caxa extraction ${ownedCaxaDirectory}` };
}

// ---------------------------------------------------------------------------
// Child exits -- classified by the harness phase in which they happen. The harness itself
// moves the phase, right before the request that may end the child; an observed exit never
// moves it.
// ---------------------------------------------------------------------------

const CHILD_PHASES = Object.freeze(['starting', 'stages', 'recovery', 'post-recovery', 'shutdown', 'cleanup']);

// 'unexpected' | 'tolerated-recovery' | 'expected'. Worker recovery replaces the server
// process. The server keeps the original running as the replacement's parent, so the launched
// caxa stub normally stays up; a relaunch that hands over instead ends the original, and the
// stub, with code 0. From the kill-media-worker request on, that code-0 exit is tolerated
// ('post-recovery' keeps it for an exit delivered late), but it never counts as recovery,
// which needs an adopted replacement. Shutdown and cleanup end the child on purpose.
function classifyChildExit({ phase, code = null, signal = null, error = null } = {}) {
    if (!CHILD_PHASES.includes(phase)) throw new TypeError(`Unknown smoke phase: ${phase}`);
    if (error) return 'unexpected';
    if (phase === 'shutdown' || phase === 'cleanup') return 'expected';
    if ((phase === 'recovery' || phase === 'post-recovery') && code === 0 && !signal) return 'tolerated-recovery';
    return 'unexpected';
}

function formatExitStatus({ code, signal }) {
    return `code ${code ?? 'none'}, ${signal ? `signal ${signal}` : 'no signal'}`;
}

function describeChildExit(record) {
    if (!record) return 'still running';
    const status = record.error ? `failed to start: ${record.error}` : formatExitStatus(record);
    return `exited (${status}) in phase '${record.phase}'`;
}

// Records the child's first exit as { code, signal, phase, at }. `exited` always resolves with
// that record (also when the spawn failed, since no process will ever exit); `unexpected`
// rejects only when the exit, or any 'error' event, is unexpected for the phase it happened in.
function createChildExitMonitor(child) {
    let phase = 'starting';
    let record = null;
    let failure = null;
    let resolveExited;
    let rejectUnexpected;
    const exited = new Promise((resolve) => { resolveExited = resolve; });
    const unexpected = new Promise((_resolve, reject) => { rejectUnexpected = reject; });
    // The stages race this; when it rejects nobody may be racing it.
    unexpected.catch(() => {});

    const fail = (error) => {
        if (failure) return;
        failure = error;
        rejectUnexpected(error);
    };
    const recordExit = (entry) => {
        if (record) return false;
        record = entry;
        resolveExited(entry);
        return true;
    };

    child.on('exit', (code, signal) => {
        const entry = { code, signal, phase, at: Date.now() };
        if (!recordExit(entry)) return;
        if (classifyChildExit(entry) === 'unexpected') {
            const who = Number.isInteger(child.pid) ? ` (PID ${child.pid})` : '';
            fail(new Error(`Packaged executable${who} exited unexpectedly in phase '${entry.phase}' (${formatExitStatus(entry)}).`));
        }
    });
    child.on('error', (error) => {
        if (!Number.isInteger(child.pid)) {
            recordExit({ code: null, signal: null, phase, at: Date.now(), error: error.message });
            fail(new Error(`Packaged executable failed to start: ${error.message}`));
            return;
        }
        fail(new Error(`Packaged executable (PID ${child.pid}) reported an error in phase '${phase}': ${error.message}`));
    });

    return {
        get phase() { return phase; },
        get record() { return record; },
        exited,
        unexpected,
        setPhase(next) {
            const nextIndex = CHILD_PHASES.indexOf(next);
            if (nextIndex < 0) throw new TypeError(`Unknown smoke phase: ${next}`);
            if (nextIndex < CHILD_PHASES.indexOf(phase)) {
                throw new Error(`The smoke phase cannot move backwards from '${phase}' to '${next}'.`);
            }
            phase = next;
        },
    };
}

// Everything the stages share about one launch: the child and its exit monitor, the PIDs the
// run owns (seeded with the child's), and what ownership has been observed on the port.
function createRunContext({
    child,
    baseUrl: runBaseUrl = baseUrl,
    listProcesses: listRunProcesses = listProcesses,
    runPlaywright = runPackagedPlaywright,
    readyAttempts = 60,
    readyIntervalMs = 500,
    pollIntervalMs = 250,
    recoveryTimeoutMs = 60_000,
} = {}) {
    const monitor = createChildExitMonitor(child);
    const controller = new AbortController();
    // An unexpected exit ends every stage's polling at once, not only the race it lost.
    monitor.unexpected.catch(() => controller.abort());
    return {
        baseUrl: runBaseUrl,
        child,
        monitor,
        ownedPids: new Set(Number.isInteger(child.pid) ? [child.pid] : []),
        servingPid: null,
        ownership: { caxaDirectory: null, portObservedUnowned: false },
        listProcesses: listRunProcesses,
        runPlaywright,
        readyAttempts,
        readyIntervalMs,
        pollIntervalMs,
        recoveryTimeoutMs,
        signal: controller.signal,
        stop: () => controller.abort(),
    };
}

// Stages race the monitor's unexpected-exit promise, never the raw exit.
function raceUnexpected(run, stage) {
    return Promise.race([stage, run.monitor.unexpected]);
}

function pause(run, ms) {
    return sleep(ms, undefined, { signal: run.signal });
}

function assertServingPidOwned(run, pid, request) {
    if (!Number.isInteger(pid) || !run.ownedPids.has(pid)) {
        throw new Error(`Refusing to send ${request}: the server on ${run.baseUrl} reports PID ${pid ?? 'none'}, `
            + `which this run does not own (owned: ${[...run.ownedPids].join(', ') || 'none'}).`);
    }
}

// ---------------------------------------------------------------------------
// Behavior checks -- ported 1:1 from scripts/smoke-packaged.ps1.
// ---------------------------------------------------------------------------

function isReadyBody(body) {
    if (!body || typeof body !== 'object') return false;
    const components = body.components && typeof body.components === 'object'
        ? Object.values(body.components)
        : [];
    const requiredNotReady = components.some((component) => component?.required && component.status !== 'ready');
    return body.status === 'ready' && !requiredNotReady;
}

async function waitReady(run) {
    for (let attempt = 0; attempt < run.readyAttempts; attempt += 1) {
        await pause(run, run.readyIntervalMs);
        try {
            const { body } = await fetchWithTimeout(`${run.baseUrl}/readyz`, { signal: run.signal }, 2000, 'json');
            if (isReadyBody(body)) return body;
        } catch {
            // keep polling, matches PS1's catch {}
        }
    }
    throw new Error('Packaged executable did not become ready.');
}

// Readiness shows only that something on the port is ready. It is the launched executable
// when the PID it reports is the child or one of its descendants: that PID joins the owned
// set, and its caxa extraction is what a recovery replacement has to match.
async function verifyLaunchedServer(run) {
    const { body } = await fetchWithTimeout(`${run.baseUrl}/api/metrics`, { signal: run.signal }, 5000, 'json');
    const pid = body?.process?.pid;
    if (!Number.isInteger(pid)) {
        throw new Error(`${run.baseUrl}/api/metrics reported no process ID, so the ready server cannot be tied to the launched executable.`);
    }
    const records = run.listProcesses();
    if (records.length === 0) {
        throw new Error(`The process list came back empty, so the ready server (PID ${pid}) cannot be tied to the launched executable.`);
    }
    if (!isDescendant(pid, run.child.pid, records)) {
        run.ownership.portObservedUnowned = true;
        throw new Error(`The ready server on ${run.baseUrl} is PID ${pid}, which is not the launched executable `
            + `(PID ${run.child.pid ?? 'none'}) or one of its descendants.`);
    }
    run.ownedPids.add(pid);
    run.servingPid = pid;
    run.ownership.caxaDirectory = caxaApplicationDirectory(records.find((record) => record.pid === pid)?.command);
    return pid;
}

async function checkStaticShell(run) {
    const { status, body } = await fetchWithTimeout(`${run.baseUrl}/`, { signal: run.signal }, 5000, 'text');
    if (status !== 200 || !body.includes('<div id="root"')) {
        throw new Error('Packaged static application shell was not served.');
    }
}

async function checkSocketHandshake(run) {
    const { status, body } = await fetchWithTimeout(`${run.baseUrl}/socket.io/?EIO=4&transport=polling`, { signal: run.signal }, 5000, 'text');
    if (status !== 200 || !body.startsWith('0{')) {
        throw new Error('Socket.IO handshake failed.');
    }
}

async function checkPackageInfo(run) {
    const { body } = await fetchWithTimeout(`${run.baseUrl}/api/package-info`, { signal: run.signal }, 5000, 'json');
    for (const required of ['license', 'notices', 'sourceInstructions', 'sbom', 'ffmpeg']) {
        if (!body?.artifacts?.[required]) throw new Error(`Packaged artifact is missing ${required}.`);
    }
}

async function checkMediaWorkerReplacement(run) {
    const { monitor, ownedPids } = run;
    const { body: beforeRestart } = await fetchWithTimeout(`${run.baseUrl}/api/metrics`, { signal: run.signal }, 5000, 'json');
    assertServingPidOwned(run, beforeRestart?.process?.pid, 'kill-media-worker');

    // From this request on the server replaces itself, and a handover may end the launched
    // child with code 0.
    monitor.setPhase('recovery');
    const { body: restart } = await fetchWithTimeout(`${run.baseUrl}/api/test/kill-media-worker`, { method: 'POST', signal: run.signal }, 5000, 'json');
    if (restart?.status !== 'terminating' || !Number.isInteger(restart.workerPid)
        || restart.workerPid !== beforeRestart.mediaWorker?.pid) {
        throw new Error('Packaged media-worker replacement was not accepted.');
    }

    // The child may exit here without anything being wrong; success needs a replacement PID
    // adopted under the ownership rule and ready, never just a quiet child.
    const deadline = Date.now() + run.recoveryTimeoutMs;
    let adoptedPid = null;
    while (Date.now() < deadline) {
        await pause(run, run.pollIntervalMs);
        let metrics;
        try {
            ({ body: metrics } = await fetchWithTimeout(`${run.baseUrl}/api/metrics`, { signal: run.signal }, 1000, 'json'));
        } catch (err) {
            // Refused, reset or timed out during the handover: nobody to attribute yet. A body
            // that is not JSON is an answer, though, and not one from a Nextra server.
            if (!(err instanceof SyntaxError)) continue;
            metrics = null;
        }
        const servingPid = metrics?.process?.pid;
        if (!ownedPids.has(servingPid)) {
            const decision = decideReplacementAdoption({
                pid: servingPid,
                ownedPids,
                records: Number.isInteger(servingPid) ? run.listProcesses() : [],
                childPid: run.child.pid,
                childExited: monitor.record !== null,
                ownedCaxaDirectory: run.ownership.caxaDirectory,
                portObservedUnowned: run.ownership.portObservedUnowned,
            });
            if (decision.verdict !== 'adopt') {
                run.ownership.portObservedUnowned = true;
                throw new Error(`Packaged media-worker recovery left the port to a process this run does not own: ${decision.reason}. `
                    + `Launched child: ${describeChildExit(monitor.record)}.`);
            }
            ownedPids.add(servingPid);
            adoptedPid = servingPid;
            console.log(`Adopted replacement server PID ${servingPid}: ${decision.reason}.`);
        }
        if (servingPid !== adoptedPid) continue; // the original server still answers

        let readiness;
        try {
            ({ body: readiness } = await fetchWithTimeout(`${run.baseUrl}/readyz`, { signal: run.signal }, 1000, 'json'));
        } catch {
            continue; // keep polling, matches PS1's catch {}
        }
        const workerPid = metrics.mediaWorker?.pid;
        if (readiness?.status === 'ready' && Number.isInteger(workerPid) && workerPid !== restart.workerPid) {
            run.servingPid = adoptedPid;
            monitor.setPhase('post-recovery');
            console.log(`Launched executable during recovery: ${describeChildExit(monitor.record)}.`);
            return;
        }
    }
    const adoption = adoptedPid === null
        ? 'no replacement PID was adopted'
        : `replacement PID ${adoptedPid} was adopted but did not become ready with a new media worker`;
    throw new Error(`Packaged executable did not replace the failed media worker: ${adoption}; `
        + `launched child: ${describeChildExit(monitor.record)}.`);
}

function runPackagedPlaywright(run) {
    const result = spawnSync('npx', [
        'playwright', 'test',
        '--config=playwright.packaged.config.mjs',
        '--project=chromium',
    ], {
        cwd: projectRoot,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: { ...process.env, NEXTRA_PACKAGED_BASE_URL: run.baseUrl },
    });
    if (result.status !== 0) {
        throw new Error(`Packaged decoded-frame flow failed with code ${result.status}.`);
    }
}

async function checkGracefulShutdown(run) {
    const { body: metrics } = await fetchWithTimeout(`${run.baseUrl}/api/metrics`, { signal: run.signal }, 5000, 'json');
    assertServingPidOwned(run, metrics?.process?.pid, 'the shutdown request');

    await fetchWithTimeout(`${run.baseUrl}/api/test/shutdown`, { method: 'POST' }, 5000, 'none');
    let stopped = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(500);
        try {
            await fetchWithTimeout(`${run.baseUrl}/healthz`, {}, 1000, 'none');
        } catch {
            stopped = true;
            break;
        }
    }
    if (!stopped) throw new Error('Packaged executable did not shut down gracefully.');
}

async function runStages(run) {
    await raceUnexpected(run, waitReady(run));
    await raceUnexpected(run, verifyLaunchedServer(run));
    run.monitor.setPhase('stages');
    console.log('Initial packaged readiness passed.');

    await raceUnexpected(run, checkStaticShell(run));
    await raceUnexpected(run, checkSocketHandshake(run));
    await raceUnexpected(run, checkPackageInfo(run));

    await raceUnexpected(run, checkMediaWorkerReplacement(run));
    console.log('Packaged process and mediasoup worker replacement passed.');

    // Synchronous; a server lost meanwhile fails the ownership check of the shutdown stage.
    run.runPlaywright(run);
    console.log('Packaged decoded-frame flow passed.');

    await checkGracefulShutdown(run);
    console.log('Packaged graceful shutdown passed.');
}

// ---------------------------------------------------------------------------
// Cleanup -- always runs, mirrors the PowerShell script's finally block.
// ---------------------------------------------------------------------------

// The best-effort shutdown request goes only to a server this run owns: a PID in the owned
// set, or a descendant of the launched child that readiness did not get to verify.
async function requestCleanupShutdown(run) {
    let pid;
    try {
        const { body } = await fetchWithTimeout(`${run.baseUrl}/api/metrics`, {}, 2000, 'json');
        pid = body?.process?.pid;
    } catch {
        return false; // nothing answers as Nextra: nothing to ask
    }
    const owned = Number.isInteger(pid)
        && (run.ownedPids.has(pid) || isDescendant(pid, run.child.pid, run.listProcesses()));
    if (!owned) {
        console.log(`Skipping the cleanup shutdown request: the server on ${run.baseUrl} reports PID ${pid ?? 'none'}, which this run does not own.`);
        return false;
    }
    try {
        await fetchWithTimeout(`${run.baseUrl}/api/test/shutdown`, { method: 'POST' }, 2000, 'none');
        return true;
    } catch {
        return false; // best-effort, matches PS1's try {} catch {}
    }
}

async function cleanup(baselineSmokePids, baselineCloudflaredPids, run) {
    await requestCleanupShutdown(run);
    await sleep(500);

    listProcesses()
        .filter((record) => isSmokeExecutable(record) && !baselineSmokePids.has(record.pid))
        .forEach((record) => killProcess(record.pid));
    await sleep(500);

    const stale = listProcesses()
        .filter((record) => isSmokeExecutable(record) && !baselineSmokePids.has(record.pid));
    if (stale.length > 0) {
        return new Error(`Packaged smoke left stale extraction processes: ${stale.map((record) => record.pid).join(', ')}.`);
    }

    const lingeringCloudflared = listProcesses()
        .filter((record) => isCloudflared(record) && !baselineCloudflaredPids.has(record.pid));
    if (lingeringCloudflared.length > 0) {
        return new Error(`Child cloudflared process remained after shutdown (PID ${lingeringCloudflared[0].pid}).`);
    }

    return null;
}

async function main() {
    if (!fs.existsSync(executablePath)) {
        throw new Error(`Packaged executable not found: ${executablePath}`);
    }
    await assertSmokePortFree(baseUrl);

    const baseline = listProcesses();
    const baselineSmokePids = new Set(baseline.filter(isSmokeExecutable).map((record) => record.pid));
    const baselineCloudflaredPids = new Set(baseline.filter(isCloudflared).map((record) => record.pid));

    console.log(`Starting packaged executable on port ${port}...`);
    const child = spawn(executablePath, [], {
        cwd: projectRoot,
        env: childEnv,
        stdio: ['ignore', 'inherit', 'inherit'],
    });
    const run = createRunContext({ child });
    run.monitor.exited.then((record) => {
        console.log(`Launched executable (PID ${child.pid ?? 'none'}) ${describeChildExit(record)}.`);
    });

    let stageError = null;
    try {
        await runStages(run);
    } catch (err) {
        stageError = err;
    }
    // Ends any polling a failed stage left running, so it cannot outlive the run.
    run.stop();

    const cleanupError = await cleanup(baselineSmokePids, baselineCloudflaredPids, run);

    if (stageError || cleanupError) {
        if (stageError) console.error(stageError.stack || String(stageError));
        if (cleanupError) console.error(cleanupError.stack || String(cleanupError));
        process.exitCode = 1;
        return;
    }
    console.log('Packaged smoke passed.');
}

// Only `node scripts/smoke-packaged.js` runs the smoke; tests require() the helpers below.
if (require.main === module) {
    main().catch((err) => {
        console.error(err.stack || String(err));
        process.exitCode = 1;
    });
}

module.exports = {
    CHILD_PHASES,
    fetchWithTimeout,
    isConnectionRefused,
    assertSmokePortFree,
    parseWindowsProcessList,
    parsePsProcessList,
    listProcesses,
    isDescendant,
    caxaApplicationDirectory,
    decideReplacementAdoption,
    classifyChildExit,
    describeChildExit,
    createChildExitMonitor,
    createRunContext,
    raceUnexpected,
    isReadyBody,
    waitReady,
    verifyLaunchedServer,
    checkStaticShell,
    checkSocketHandshake,
    checkPackageInfo,
    checkMediaWorkerReplacement,
    checkGracefulShutdown,
    runStages,
    requestCleanupShutdown,
    cleanup,
    main,
};
