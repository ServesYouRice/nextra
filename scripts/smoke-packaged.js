'use strict';

// Portable replacement for scripts/smoke-packaged.ps1 (retired once
// windows-package CI is green on this script -- see
// implementation/tasks/T22-portable-smoke.md). Runs the identical assertion
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
const CLOUDFLARED_PATTERN = /(^|[\\/])cloudflared(\.exe)?(\s|$)/i;
const PROCESS_LIST_MAX_BUFFER = 8 * 1024 * 1024;

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// Process enumeration -- one helper, branched per platform, both returning
// { pid, command } records so matching and cleanup below stay platform-agnostic.
// ---------------------------------------------------------------------------

function listProcesses() {
    if (process.platform === 'win32') {
        // Same Win32_Process query the PowerShell smoke used. CommandLine,
        // ExecutablePath, and Name are folded into one searchable string per
        // record so the platform-agnostic matchers below need only `command`.
        const result = spawnSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | '
            + 'Select-Object ProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress',
        ], { encoding: 'utf8', windowsHide: true, maxBuffer: PROCESS_LIST_MAX_BUFFER });
        if (result.status !== 0 || !result.stdout) return [];
        let rows;
        try {
            rows = JSON.parse(result.stdout);
        } catch {
            return [];
        }
        if (!Array.isArray(rows)) rows = [rows];
        return rows
            .filter((row) => row && Number.isInteger(row.ProcessId))
            .map((row) => ({
                pid: row.ProcessId,
                command: [row.CommandLine, row.ExecutablePath, row.Name].filter(Boolean).join(' '),
            }));
    }

    const result = spawnSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8', maxBuffer: PROCESS_LIST_MAX_BUFFER });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const match = line.match(/^(\d+)\s+(.*)$/);
            return match ? { pid: Number(match[1]), command: match[2] } : null;
        })
        .filter(Boolean);
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

async function waitReady(attempts = 60) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        await sleep(500);
        try {
            const response = await fetchWithTimeout(`${baseUrl}/readyz`, {}, 2000);
            const body = await response.json();
            if (isReadyBody(body)) return body;
        } catch {
            // keep polling, matches PS1's catch {}
        }
    }
    throw new Error('Packaged executable did not become ready.');
}

async function checkStaticShell() {
    const response = await fetchWithTimeout(`${baseUrl}/`, {}, 5000);
    const body = await response.text();
    if (response.status !== 200 || !body.includes('<div id="root"')) {
        throw new Error('Packaged static application shell was not served.');
    }
}

async function checkSocketHandshake() {
    const response = await fetchWithTimeout(`${baseUrl}/socket.io/?EIO=4&transport=polling`, {}, 5000);
    const body = await response.text();
    if (response.status !== 200 || !body.startsWith('0{')) {
        throw new Error('Socket.IO handshake failed.');
    }
}

async function checkPackageInfo() {
    const response = await fetchWithTimeout(`${baseUrl}/api/package-info`, {}, 5000);
    const body = await response.json();
    for (const required of ['license', 'notices', 'sourceInstructions', 'sbom']) {
        if (!body?.artifacts?.[required]) throw new Error(`Packaged artifact is missing ${required}.`);
    }
}

async function checkMediaWorkerReplacement() {
    const beforeRestartResponse = await fetchWithTimeout(`${baseUrl}/api/metrics`, {}, 5000);
    const beforeRestart = await beforeRestartResponse.json();

    const restartResponse = await fetchWithTimeout(`${baseUrl}/api/test/kill-media-worker`, { method: 'POST' }, 5000);
    const restart = await restartResponse.json();
    if (restart.status !== 'terminating' || restart.workerPid !== beforeRestart.mediaWorker.pid) {
        throw new Error('Packaged media-worker replacement was not accepted.');
    }

    const deadline = Date.now() + 60_000;
    let replacementReady = false;
    while (Date.now() < deadline) {
        await sleep(250);
        try {
            const metricsResponse = await fetchWithTimeout(`${baseUrl}/api/metrics`, {}, 1000);
            const readinessResponse = await fetchWithTimeout(`${baseUrl}/readyz`, {}, 1000);
            const metrics = await metricsResponse.json();
            const readiness = await readinessResponse.json();
            if (readiness.status === 'ready'
                && metrics.process.pid !== beforeRestart.process.pid
                && metrics.mediaWorker.pid !== beforeRestart.mediaWorker.pid) {
                replacementReady = true;
                break;
            }
        } catch {
            // keep polling, matches PS1's catch {}
        }
    }
    if (!replacementReady) throw new Error('Packaged executable did not replace the failed media worker.');
}

function runPackagedPlaywright() {
    const result = spawnSync('npx', [
        'playwright', 'test',
        '--config=playwright.packaged.config.mjs',
        '--project=chromium',
    ], {
        cwd: projectRoot,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: { ...process.env, NEXTRA_PACKAGED_BASE_URL: baseUrl },
    });
    if (result.status !== 0) {
        throw new Error(`Packaged decoded-frame flow failed with code ${result.status}.`);
    }
}

async function checkGracefulShutdown() {
    await fetchWithTimeout(`${baseUrl}/api/test/shutdown`, { method: 'POST' }, 5000);
    let stopped = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(500);
        try {
            await fetchWithTimeout(`${baseUrl}/healthz`, {}, 1000);
        } catch {
            stopped = true;
            break;
        }
    }
    if (!stopped) throw new Error('Packaged executable did not shut down gracefully.');
}

async function runStages() {
    await waitReady();
    console.log('Initial packaged readiness passed.');

    await checkStaticShell();
    await checkSocketHandshake();
    await checkPackageInfo();

    await checkMediaWorkerReplacement();
    console.log('Packaged process and mediasoup worker replacement passed.');

    runPackagedPlaywright();
    console.log('Packaged decoded-frame flow passed.');

    await checkGracefulShutdown();
    console.log('Packaged graceful shutdown passed.');
}

// ---------------------------------------------------------------------------
// Cleanup -- always runs, mirrors the PowerShell script's finally block.
// ---------------------------------------------------------------------------

async function cleanup(baselineSmokePids, baselineCloudflaredPids) {
    try {
        await fetchWithTimeout(`${baseUrl}/api/test/shutdown`, { method: 'POST' }, 2000);
    } catch {
        // best-effort, matches PS1's try {} catch {}
    }
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

    const baseline = listProcesses();
    const baselineSmokePids = new Set(baseline.filter(isSmokeExecutable).map((record) => record.pid));
    const baselineCloudflaredPids = new Set(baseline.filter(isCloudflared).map((record) => record.pid));

    console.log(`Starting packaged executable on port ${port}...`);
    const child = spawn(executablePath, [], {
        cwd: projectRoot,
        env: childEnv,
        stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', (err) => {
        console.error(`Packaged executable failed to start: ${err.message}`);
    });

    let stageError = null;
    try {
        await runStages();
    } catch (err) {
        stageError = err;
    }

    const cleanupError = await cleanup(baselineSmokePids, baselineCloudflaredPids);

    if (stageError || cleanupError) {
        if (stageError) console.error(stageError.stack || String(stageError));
        if (cleanupError) console.error(cleanupError.stack || String(cleanupError));
        process.exitCode = 1;
        return;
    }
    console.log('Packaged smoke passed.');
}

main().catch((err) => {
    console.error(err.stack || String(err));
    process.exitCode = 1;
});
