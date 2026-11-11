'use strict';

// Portable replacement for the retired scripts/smoke-packaged.ps1. Runs the identical assertion
// set against a packaged executable on both Windows and macOS: readiness, the
// static shell, the Socket.IO handshake, compliance artifacts, the
// mediasoup-worker-kill recovery path, the decoded-frame Playwright flow,
// graceful shutdown (the launched executable exits with code 0 and leaves no
// process behind), and a cleanup that kills only the processes this run owns:
// never one that ran before the launch, nor another instance started meanwhile.
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
    // The recovery and shutdown stages test Nextra's own recovery, whose replacement runs as a
    // child of the original server, inside the tree this run owns. A runner environment that
    // declares a supervisor would make the worker kill end the server with code 1 instead.
    EXTERNAL_SUPERVISOR: 'false',
};

// caxa unpacks a packaged executable under a "caxa/applications/nextra-<id>/<attempt>" cache
// directory and runs it from there on both platforms. The server the caxa stub starts and the
// replacement that server spawns from process.execPath both run from it.
const CAXA_APPLICATION_DIRECTORY_PATTERN = /[\\/]caxa[\\/]applications[\\/](nextra-[^\\/\s"']+)(?:[\\/](\d+))?/i;
const CLOUDFLARED_PATTERN = /(^|[\\/])cloudflared(\.exe)?(\s|$)/i;
// A list cut off at this size is an error (ENOBUFS), never a shorter list.
const PROCESS_LIST_MAX_BUFFER = 64 * 1024 * 1024;
// How long cleanup waits for the launched child to exit after SIGKILL.
const CHILD_KILL_TIMEOUT_MS = 5000;

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

// Whether a failed fetch failed only for one of these socket error codes. undici puts the
// socket error in `cause`, and a connection tried on several addresses in `cause.errors`.
function causedOnlyBy(err, codes) {
    const cause = err?.cause ?? err;
    const errors = Array.isArray(cause?.errors) && cause.errors.length > 0 ? cause.errors : [cause];
    return errors.every((inner) => codes.includes(inner?.code));
}

function isConnectionRefused(err) {
    return causedOnlyBy(err, ['ECONNREFUSED']);
}

// A server may close the connection of the shutdown request as it exits: with a reset, or by
// closing it without an answer ("other side closed").
function isClosedByServer(err) {
    return causedOnlyBy(err, ['ECONNRESET', 'UND_ERR_SOCKET']);
}

// What a failed /healthz probe after the shutdown request says: 'down' only for a refused or
// reset connection. Anything else, a timeout above all, is no proof that the server stopped:
// a server that is alive but does not answer would otherwise count as stopped.
function classifyShutdownProbeError(err) {
    return causedOnlyBy(err, ['ECONNREFUSED']) || causedOnlyBy(err, ['ECONNRESET']) ? 'down' : 'unknown';
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

// The records in a process query's spawnSync result. Anything that shows the query did not run
// to the end throws: an empty list would let every leftover-process check pass without checking
// anything, and an empty baseline would protect nothing.
function readProcessList(result, query, parse) {
    if (result.error) {
        throw new Error(`Process enumeration failed: ${query} did not run to the end `
            + `(${result.error.code || result.error.message}).`, { cause: result.error });
    }
    if (result.status !== 0) {
        const how = result.status === null || result.status === undefined
            ? `was ended by ${result.signal || 'a signal'}`
            : `exited with status ${result.status}`;
        const stderr = String(result.stderr || '').trim();
        throw new Error(`Process enumeration failed: ${query} ${how}${stderr ? `: ${stderr.slice(0, 500)}` : ''}.`);
    }
    if (!String(result.stdout || '').trim()) {
        throw new Error(`Process enumeration failed: ${query} printed no output.`);
    }
    let records;
    try {
        records = parse(result.stdout);
    } catch (err) {
        throw new Error(`Process enumeration failed: the output of ${query} could not be parsed (${err.message}).`, { cause: err });
    }
    // The query runs while it lists, so a list that was read in full is never empty.
    if (records.length === 0) {
        throw new Error(`Process enumeration failed: the output of ${query} held no process records.`);
    }
    return records;
}

// Every process on the machine, or an error; never an empty list in place of one.
function listProcesses({ platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
    if (platform === 'win32') {
        // Same Win32_Process query the PowerShell smoke used. CommandLine,
        // ExecutablePath, and Name are folded into one searchable string per
        // record so the platform-agnostic matchers below need only `command`.
        const result = spawnSyncImpl('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | '
            + 'Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress',
        ], { encoding: 'utf8', windowsHide: true, maxBuffer: PROCESS_LIST_MAX_BUFFER });
        return readProcessList(result, 'powershell.exe (Get-CimInstance Win32_Process)', parseWindowsProcessList);
    }

    const result = spawnSyncImpl('ps', ['-Ao', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: PROCESS_LIST_MAX_BUFFER });
    return readProcessList(result, 'ps -Ao pid=,ppid=,args=', parsePsProcessList);
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
// The run's process tree -- the shutdown check and cleanup look only at processes this run
// owns, never at what a process looks like: another instance of the same build runs from the
// same caxa extraction.
// ---------------------------------------------------------------------------

// The records that belong to the run: the owned PIDs (the launched child, the server verified
// at readiness, an adopted replacement), every process seen in the run's tree before
// (knownProcesses, PID -> command line), and the current descendants of both. A PID stands for
// the same process only while it runs the command line it had, so these are never the run's:
// - a process that was running before the launch (same PID and command line as in the
//   baseline). The baseline protects processes, not numbers, so an owned process that got the
//   PID of a baseline process that has ended is still the run's;
// - a known PID that now runs another command line (the PID was reused);
// - a process holding the PID of the launched child after its exit was observed (exitedPids).
// Their PIDs link nothing either: by parent PID, their children may belong to the new holder.
// A PID nobody holds any more still links its children, because on Windows a process keeps
// the PID of a parent that has exited (on POSIX it is reparented, and only knownProcesses keeps it).
function selectCleanupTargets({
    records = [], ownedPids = new Set(), knownProcesses = new Map(), baseline = new Map(), exitedPids = [],
} = {}) {
    const exited = new Set(exitedPids);
    const isForeign = (record) => baseline.get(record.pid) === record.command
        || (knownProcesses.has(record.pid) && knownProcesses.get(record.pid) !== record.command)
        || exited.has(record.pid);
    const blocked = new Set(records.filter(isForeign).map((record) => record.pid));
    const children = new Map();
    for (const record of records) {
        if (blocked.has(record.pid)) continue;
        if (!children.has(record.ppid)) children.set(record.ppid, []);
        children.get(record.ppid).push(record.pid);
    }
    const tree = new Set();
    const queue = [...ownedPids, ...knownProcesses.keys()].filter((pid) => Number.isInteger(pid) && !blocked.has(pid));
    while (queue.length > 0) {
        const pid = queue.shift();
        if (tree.has(pid)) continue;
        tree.add(pid);
        queue.push(...(children.get(pid) || []));
    }
    return records.filter((record) => tree.has(record.pid) && !blocked.has(record.pid));
}

// The run's live tree in these records, each process remembered with its command line so that
// it stays known once it is reparented or its parent's PID is reused.
function ownedProcessTree(run, records) {
    const tree = selectCleanupTargets({
        records,
        ownedPids: run.ownedPids,
        knownProcesses: run.knownProcesses,
        baseline: run.baseline,
        exitedPids: run.monitor.record && Number.isInteger(run.child.pid) ? [run.child.pid] : [],
    }).filter((record) => record.pid !== process.pid);
    for (const record of tree) run.knownProcesses.set(record.pid, record.command);
    return tree;
}

function describeProcesses(records) {
    return records
        .map((record) => {
            const command = String(record.command || '');
            return `${record.pid} (${command.length > 160 ? `${command.slice(0, 157)}...` : command})`;
        })
        .join(', ');
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
// run owns (seeded with the child's), the processes seen in its tree, what ownership has been
// observed on the port, and the pre-launch baseline (PID -> command line).
function createRunContext({
    child,
    baseUrl: runBaseUrl = baseUrl,
    listProcesses: listRunProcesses = listProcesses,
    killProcess: killRunProcess = killProcess,
    runPlaywright = runPackagedPlaywright,
    baseline = new Map(),
    readyAttempts = 60,
    readyIntervalMs = 500,
    pollIntervalMs = 250,
    recoveryTimeoutMs = 60_000,
    // Covers the server's own 5 s forced exit, the exit of the processes around it, and the
    // process listings that check them.
    shutdownTimeoutMs = 15_000,
    cleanupGraceMs = 500,
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
        knownProcesses: new Map(),
        baseline,
        servingPid: null,
        ownership: { caxaDirectory: null, portObservedUnowned: false },
        // Set once the shutdown stage sends its request: from then on, anything of the run
        // still alive in cleanup survived the graceful shutdown.
        shutdownRequested: false,
        listProcesses: listRunProcesses,
        killProcess: killRunProcess,
        runPlaywright,
        readyAttempts,
        readyIntervalMs,
        pollIntervalMs,
        recoveryTimeoutMs,
        shutdownTimeoutMs,
        cleanupGraceMs,
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
    ownedProcessTree(run, records);
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
            const records = Number.isInteger(servingPid) ? run.listProcesses() : [];
            const decision = decideReplacementAdoption({
                pid: servingPid,
                ownedPids,
                records,
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
            ownedProcessTree(run, records);
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

// The verdict on a graceful shutdown, from what the shutdown stage observed:
// - postResult: { status } of the shutdown request, or { error } when it failed. Only a 2xx
//   answer is accepted, or a connection the server closed as it exited, and that one only
//   when the exit of the run's processes was then observed (the deadline did not expire).
// - childExit: the exit monitor's record. Code 0 without a signal in the 'shutdown' phase
//   passes, any other code or a signal fails. An exit recorded earlier, in 'recovery' or
//   'post-recovery', is a handover: the replacement that served since is not the harness's
//   child, so its exit code cannot be observed, and only the owned processes count.
// - survivingOwnedPids: processes of the run still alive at the end. Any one fails.
// - deadlineExpired: the wait ended at the deadline instead of on success.
// - portDown: false when the smoke port never refused connections (or reset them).
// Returns { passed, failures, notes }.
function evaluateShutdown({
    childExit = null, survivingOwnedPids = [], postResult = {}, deadlineExpired = false, portDown = null,
} = {}) {
    const failures = [];
    const notes = [];
    if (postResult.error) {
        if (!isClosedByServer(postResult.error)) {
            failures.push(`the shutdown request failed: ${describeError(postResult.error)}`);
        } else if (deadlineExpired || survivingOwnedPids.length > 0 || !childExit) {
            failures.push('the connection of the shutdown request was reset or closed without an answer, '
                + 'and no exit of the processes this run owns followed it');
        } else {
            notes.push('the server reset or closed the connection of the shutdown request as it exited');
        }
    } else if (!Number.isInteger(postResult.status) || postResult.status < 200 || postResult.status > 299) {
        failures.push(`the shutdown request was answered with HTTP ${postResult.status ?? 'none'}, not 2xx`);
    }

    if (!childExit) {
        failures.push('the launched executable did not exit');
    } else if (childExit.error) {
        failures.push(`the launched executable failed: ${childExit.error}`);
    } else if (childExit.phase === 'shutdown' || childExit.phase === 'cleanup') {
        const exitStatus = `launched executable exited (${formatExitStatus(childExit)}) in phase '${childExit.phase}'`;
        if (childExit.code === 0 && !childExit.signal) notes.push(exitStatus);
        else failures.push(`the ${exitStatus}`);
    } else if (childExit.phase === 'recovery' || childExit.phase === 'post-recovery') {
        notes.push(`the launched executable already exited (${formatExitStatus(childExit)}) in phase '${childExit.phase}', `
            + 'a handover during recovery; replacement exit code not observable');
    } else {
        failures.push(`the launched executable exited (${formatExitStatus(childExit)}) in phase '${childExit.phase}', before the shutdown`);
    }

    if (survivingOwnedPids.length > 0) {
        failures.push(`processes survived graceful shutdown: ${survivingOwnedPids.join(', ')}`);
    }
    if (portDown === false) failures.push('the smoke port did not refuse connections by the deadline');
    if (deadlineExpired && failures.length === 0) failures.push('the shutdown did not complete within the deadline');
    return { passed: failures.length === 0, failures, notes };
}

// Settles with the promise, or after ms, whichever comes first, and leaves no timer behind.
function waitAtMost(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function probeSmokePort(run) {
    try {
        await fetchWithTimeout(`${run.baseUrl}/healthz`, {}, 1000, 'none');
        return 'up';
    } catch (err) {
        return classifyShutdownProbeError(err);
    }
}

// Waits, within one deadline, until the launched child has exited (unless it already did during
// recovery), the port is down, and no process of the run is alive. Plain timers, not the run's
// abort signal: nothing in this wait can end as a stop by accident.
async function waitForShutdown(run, awaitChildExit) {
    const deadline = Date.now() + run.shutdownTimeoutMs;
    for (;;) {
        const childDone = !awaitChildExit || run.monitor.record !== null;
        let portDown = childDone ? (await probeSmokePort(run)) === 'down' : null;
        const expired = Date.now() >= deadline;
        if ((childDone && portDown) || expired) {
            if (portDown === null) portDown = (await probeSmokePort(run)) === 'down';
            const survivors = ownedProcessTree(run, run.listProcesses());
            if (childDone && portDown && survivors.length === 0) return { deadlineExpired: false, portDown, survivors };
            if (expired) return { deadlineExpired: true, portDown, survivors };
        }
        const wait = Math.min(run.pollIntervalMs, Math.max(0, deadline - Date.now()));
        if (childDone) await sleep(wait);
        else await waitAtMost(run.monitor.exited, wait);
    }
}

// The requested exit is this stage's success condition. The phase is 'shutdown' before the
// request goes out, so the monitor counts the exit as expected, and the stage is never raced
// against the monitor's unexpected-exit promise.
async function checkGracefulShutdown(run) {
    const { monitor } = run;
    const { body: metrics } = await fetchWithTimeout(`${run.baseUrl}/api/metrics`, { signal: run.signal }, 5000, 'json');
    assertServingPidOwned(run, metrics?.process?.pid, 'the shutdown request');
    // The run's tree right before the shutdown, so a process that is reparented while it lingers
    // is still recognised. A process list that cannot be read stops the stage here.
    ownedProcessTree(run, run.listProcesses());

    // A launched child that handed over during recovery has no exit left to wait for.
    const awaitChildExit = monitor.record === null;
    monitor.setPhase('shutdown');
    run.shutdownRequested = true;
    let postResult;
    try {
        const { status } = await fetchWithTimeout(`${run.baseUrl}/api/test/shutdown`, { method: 'POST' }, 5000, 'none');
        postResult = { status };
    } catch (err) {
        postResult = { error: err };
    }
    const accepted = postResult.error
        ? isClosedByServer(postResult.error)
        : postResult.status >= 200 && postResult.status <= 299;
    const observed = accepted
        ? await waitForShutdown(run, awaitChildExit)
        : { deadlineExpired: false, portDown: null, survivors: [] };

    const evaluation = evaluateShutdown({
        childExit: monitor.record,
        survivingOwnedPids: observed.survivors.map((record) => record.pid),
        postResult,
        deadlineExpired: observed.deadlineExpired,
        portDown: observed.portDown,
    });
    for (const note of evaluation.notes) console.log(`Graceful shutdown: ${note}.`);
    if (!evaluation.passed) {
        throw new Error(`Packaged executable did not shut down gracefully: ${evaluation.failures.join('; ')}.`);
    }
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

    // Not raced against the monitor: the exit this stage requests is its success condition.
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
    let owned = Number.isInteger(pid) && run.ownedPids.has(pid);
    if (!owned && Number.isInteger(pid)) {
        try {
            owned = isDescendant(pid, run.child.pid, run.listProcesses());
        } catch (err) {
            console.log(`Skipping the cleanup shutdown request: PID ${pid} cannot be tied to this run. ${err.message}`);
            return false;
        }
    }
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

// Kills what is left of the run, and only that: the launched child through its handle, and the
// other processes of its tree (selectCleanupTargets) by PID. Returns an Error naming every
// problem, or null. Once the shutdown stage has sent its request, anything of the run still
// alive here survived the graceful shutdown: that is recorded as a failure before it is killed.
// A process list that cannot be read is a failure too, and the child is killed all the same,
// so the smoke can end.
async function cleanup(run) {
    const { child, monitor } = run;
    monitor.setPhase('cleanup');
    const failures = [];
    if (await requestCleanupShutdown(run)) await sleep(run.cleanupGraceMs);

    let targets = [];
    let listed = false;
    try {
        const records = run.listProcesses();
        listed = true;
        targets = ownedProcessTree(run, records);
        // The run's own cloudflared, and any other that was not running before the launch.
        const lingeringCloudflared = records
            .filter((record) => isCloudflared(record) && run.baseline.get(record.pid) !== record.command);
        if (lingeringCloudflared.length > 0) {
            failures.push(`Child cloudflared process remained after shutdown (PID ${lingeringCloudflared.map((record) => record.pid).join(', ')}).`);
        }
    } catch (err) {
        failures.push(`${err.message} The processes of this run could not be checked or killed.`);
    }

    if (targets.length > 0) {
        if (run.shutdownRequested) {
            failures.push(`Cleanup found processes that survived graceful shutdown: ${describeProcesses(targets)}. They were killed.`);
        } else {
            console.log(`Killing the processes of this run: ${describeProcesses(targets)}.`);
        }
    }

    const childRunning = monitor.record === null && Number.isInteger(child.pid);
    if (childRunning) {
        try {
            child.kill('SIGKILL');
        } catch (err) {
            failures.push(`The launched executable (PID ${child.pid}) could not be killed: ${err.message}`);
        }
    }
    for (const record of targets) {
        if (record.pid !== child.pid) run.killProcess(record.pid);
    }
    if (childRunning) {
        await waitAtMost(monitor.exited, CHILD_KILL_TIMEOUT_MS);
        if (monitor.record === null) {
            failures.push(`The launched executable (PID ${child.pid}) did not exit after SIGKILL.`);
            // Its handle would keep the smoke from ever ending.
            child.unref?.();
        }
    }

    if (listed && targets.length > 0) {
        await sleep(run.cleanupGraceMs);
        try {
            const stale = ownedProcessTree(run, run.listProcesses());
            if (stale.length > 0) {
                failures.push(`Packaged smoke left stale processes after the forced kill: ${describeProcesses(stale)}.`);
            }
        } catch (err) {
            failures.push(`${err.message} Whether the forced kill worked could not be checked.`);
        }
    }

    return failures.length > 0 ? new Error(failures.join('\n')) : null;
}

// The processes running before the launch, as PID -> command line. Cleanup never kills one of
// them, and a cloudflared among them is not reported. Without a baseline nothing is launched.
function takeProcessBaseline(listRunProcesses = listProcesses) {
    let records;
    try {
        records = listRunProcesses();
    } catch (err) {
        throw new Error(`Could not take the pre-launch process baseline, so the packaged executable was not launched. ${err.message}`, { cause: err });
    }
    return new Map(records.map((record) => [record.pid, record.command]));
}

function launchPackagedExecutable(executable) {
    return spawn(executable, [], {
        cwd: projectRoot,
        env: childEnv,
        stdio: ['ignore', 'inherit', 'inherit'],
    });
}

// Resolves with the smoke's exit code: 0 only when every stage and the cleanup passed.
async function main({
    executable = executablePath,
    listProcesses: listRunProcesses = listProcesses,
    launch = launchPackagedExecutable,
    runOptions = {},
} = {}) {
    if (!fs.existsSync(executable)) {
        throw new Error(`Packaged executable not found: ${executable}`);
    }
    await assertSmokePortFree(baseUrl);
    const baseline = takeProcessBaseline(listRunProcesses);

    console.log(`Starting packaged executable on port ${port}...`);
    const child = launch(executable);
    const run = createRunContext({ child, listProcesses: listRunProcesses, baseline, ...runOptions });
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

    const cleanupError = await cleanup(run);

    if (stageError) console.error(stageError.stack || String(stageError));
    if (cleanupError) console.error(cleanupError.stack || String(cleanupError));
    if (stageError || cleanupError) return 1;
    console.log('Packaged smoke passed.');
    return 0;
}

// Only `node scripts/smoke-packaged.js` runs the smoke; tests require() the helpers below.
if (require.main === module) {
    main().then((code) => {
        process.exitCode = code;
    }, (err) => {
        console.error(err.stack || String(err));
        process.exitCode = 1;
    });
}

module.exports = {
    CHILD_PHASES,
    fetchWithTimeout,
    isConnectionRefused,
    classifyShutdownProbeError,
    assertSmokePortFree,
    parseWindowsProcessList,
    parsePsProcessList,
    listProcesses,
    isDescendant,
    caxaApplicationDirectory,
    decideReplacementAdoption,
    selectCleanupTargets,
    evaluateShutdown,
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
    takeProcessBaseline,
    main,
};
