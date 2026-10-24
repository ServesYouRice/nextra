const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io: createSocketClient } = require('socket.io-client');
const { claimServerPorts } = require('./serverPorts');

const projectRoot = path.resolve(__dirname, '..');

async function waitForJson(url, predicate, timeoutMs = 25_000, getOutput = () => '') {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                const body = await response.json();
                if (predicate(body)) return body;
            }
        } catch (err) {
            lastError = err;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'condition not met'}\n${getOutput()}`);
}

test('a killed real mediasoup subprocess is replaced with a ready process', {
    concurrency: false,
    timeout: 45_000,
}, async (t) => {
    // The replacement process the server spawns binds the same two ports; the
    // claim holds them for it until this file's process exits.
    const { port, rtcPort } = await claimServerPorts();
    const baseUrl = `http://127.0.0.1:${port}`;
    const testDistDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nextra-worker-dist-'));
    await fs.writeFile(path.join(testDistDir, 'index.html'), '<!doctype html><div id="root"></div>');
    let output = '';
    let replacementStarted = false;
    let hostSocket = null;

    const child = spawn(process.execPath, ['server.js'], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(port),
            BIND_HOST: '127.0.0.1',
            LAN_IP: '127.0.0.1',
            RTC_LISTEN_IP: '127.0.0.1',
            RTC_MIN_PORT: String(rtcPort),
            RTC_MAX_PORT: String(rtcPort),
            LOCAL_HTTPS: 'false',
            OPEN_BROWSER: 'false',
            AUTO_DETECT_PUBLIC_IP: 'false',
            AUTO_PUBLIC_TUNNEL: 'false',
            WHIP_ENABLED: 'false',
            WHEP_ENABLED: 'false',
            NEXTRA_SMOKE_TEST: '1',
            NEXTRA_TEST_DIST_DIR: testDistDir,
            WORKER_RECOVERY_MIN_UPTIME_SECONDS: '0',
            LOG_LEVEL: 'warn',
        },
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });

    t.after(async () => {
        hostSocket?.close();
        try { await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' }); } catch {}
        if (!replacementStarted && child.exitCode === null) child.kill();
        await fs.rm(testDistDir, { recursive: true, force: true });
    });

    await waitForJson(`${baseUrl}/readyz`, (body) => body.status === 'ready', 25_000, () => output);
    const before = await (await fetch(`${baseUrl}/api/metrics`)).json();
    assert.ok(Number.isInteger(before.process.pid));
    assert.ok(Number.isInteger(before.mediaWorker.pid));

    hostSocket = createSocketClient(baseUrl, {
        transports: ['websocket'],
        reconnection: false,
    });
    await new Promise((resolve, reject) => {
        hostSocket.once('connect', resolve);
        hostSocket.once('connect_error', reject);
    });
    const created = await new Promise((resolve) => {
        hostSocket.emit('create-room', { ingestMode: 'browser' }, resolve);
    });
    assert.equal(created.success, true);
    const roomEnded = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('room-ended event timed out')), 5_000);
        hostSocket.once('room-ended', (payload) => {
            clearTimeout(timeout);
            resolve(payload);
        });
    });

    const killed = await fetch(`${baseUrl}/api/test/kill-media-worker`, { method: 'POST' });
    assert.equal(killed.status, 202);
    assert.equal((await killed.json()).workerPid, before.mediaWorker.pid);
    assert.deepEqual(await roomEnded, {
        code: 'media-worker-fatal',
        reason: 'The media engine restarted. This room ended; create or join a new room.',
        recoverable: false,
        terminal: true,
    });

    const after = await waitForJson(`${baseUrl}/api/metrics`, (body) => (
        body.process?.pid !== before.process.pid
        && body.mediaWorker?.pid !== before.mediaWorker.pid
    ), 25_000, () => output);
    replacementStarted = true;
    assert.notEqual(after.process.pid, before.process.pid);
    assert.notEqual(after.mediaWorker.pid, before.mediaWorker.pid);
    await waitForJson(`${baseUrl}/readyz`, (body) => body.status === 'ready', 25_000, () => output);

    const shutdown = await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' });
    assert.equal(shutdown.status, 202, output);
});

// The two tests below start the real server the same way and differ only in whether
// the operator declared a supervisor.
async function startRecoveryServer(t, extraEnv = {}) {
    // The replacement process, when there is one, binds the same two ports; the
    // claim holds them for it until this file's process exits.
    const { port, rtcPort } = await claimServerPorts();
    const baseUrl = `http://127.0.0.1:${port}`;
    const testDistDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nextra-worker-dist-'));
    await fs.writeFile(path.join(testDistDir, 'index.html'), '<!doctype html><div id="root"></div>');
    const state = { output: '', hostSocket: null };

    const child = spawn(process.execPath, ['server.js'], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(port),
            BIND_HOST: '127.0.0.1',
            LAN_IP: '127.0.0.1',
            RTC_LISTEN_IP: '127.0.0.1',
            RTC_MIN_PORT: String(rtcPort),
            RTC_MAX_PORT: String(rtcPort),
            LOCAL_HTTPS: 'false',
            OPEN_BROWSER: 'false',
            AUTO_DETECT_PUBLIC_IP: 'false',
            AUTO_PUBLIC_TUNNEL: 'false',
            WHIP_ENABLED: 'false',
            WHEP_ENABLED: 'false',
            NEXTRA_SMOKE_TEST: '1',
            NEXTRA_TEST_DIST_DIR: testDistDir,
            WORKER_RECOVERY_MIN_UPTIME_SECONDS: '0',
            LOG_LEVEL: 'warn',
            ...extraEnv,
        },
    });
    child.stdout.on('data', (chunk) => { state.output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { state.output += chunk.toString(); });
    const exited = new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    t.after(async () => {
        state.hostSocket?.close();
        // Ends whichever process still answers on the port (the original or a
        // replacement), then the original itself if it is still there.
        try { await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' }); } catch {}
        if (child.exitCode === null) {
            await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
        }
        if (child.exitCode === null) child.kill();
        await fs.rm(testDistDir, { recursive: true, force: true });
    });

    await waitForJson(`${baseUrl}/readyz`, (body) => body.status === 'ready', 25_000, () => state.output);
    return { child, baseUrl, state, exited };
}

// Opens a room, so there is something to end, and returns the promise of what the
// host is told when it ends.
async function openRoom(baseUrl, state) {
    state.hostSocket = createSocketClient(baseUrl, {
        transports: ['websocket'],
        reconnection: false,
    });
    await new Promise((resolve, reject) => {
        state.hostSocket.once('connect', resolve);
        state.hostSocket.once('connect_error', reject);
    });
    const created = await new Promise((resolve) => {
        state.hostSocket.emit('create-room', { ingestMode: 'browser' }, resolve);
    });
    assert.equal(created.success, true);
    const roomEnded = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('room-ended event timed out')), 5_000);
        state.hostSocket.once('room-ended', (payload) => {
            clearTimeout(timeout);
            resolve(payload);
        });
    });
    return { roomEnded };
}

const MEDIA_WORKER_FATAL_NOTICE = {
    code: 'media-worker-fatal',
    reason: 'The media engine restarted. This room ended; create or join a new room.',
    recoverable: false,
    terminal: true,
};

function exitWithin(exited, ms) {
    return Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve({ code: 'still running' }), ms)),
    ]);
}

test('worker recovery without a declared supervisor restarts Nextra as a visible child and the original process stays with it', {
    concurrency: false,
    timeout: 60_000,
}, async (t) => {
    const { child, baseUrl, state, exited } = await startRecoveryServer(t, { LOG_LEVEL: 'info' });
    const before = await (await fetch(`${baseUrl}/api/metrics`)).json();
    const { roomEnded } = await openRoom(baseUrl, state);

    const killed = await fetch(`${baseUrl}/api/test/kill-media-worker`, { method: 'POST' });
    assert.equal(killed.status, 202);
    assert.deepEqual(await roomEnded, MEDIA_WORKER_FATAL_NOTICE);

    const after = await waitForJson(`${baseUrl}/api/metrics`, (body) => (
        body.process?.pid !== before.process.pid
        && body.mediaWorker?.pid !== before.mediaWorker.pid
    ), 25_000, () => state.output);
    await waitForJson(`${baseUrl}/readyz`, (body) => body.status === 'ready', 25_000, () => state.output);

    // The original process is still running: a supervisor tracking its PID sees a
    // live process, not a clean exit, and a console Ctrl+C still reaches the pair.
    assert.equal(child.exitCode, null, `the original process exited early\n${state.output}`);

    // The replacement writes to the original's stdout instead of being discarded:
    // its startup line is in the output, next to the original's own.
    const workerLines = state.output.match(/Mediasoup Worker PID: \d+/g) || [];
    assert.equal(workerLines.length, 2, `the replacement's output did not reach this console\n${state.output}`);
    assert.ok(workerLines[1].endsWith(String(after.mediaWorker.pid)), state.output);
    const started = state.output.match(/\[recovery\] Started replacement Nextra \(PID (\d+)\)/);
    assert.ok(started, `the replacement's PID was not logged\n${state.output}`);
    assert.equal(Number(started[1]), after.process.pid);

    // The original ends with the replacement's own exit code.
    const shutdown = await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' });
    assert.equal(shutdown.status, 202, state.output);
    const result = await exitWithin(exited, 15_000);
    assert.equal(result.code, 0, state.output);
});

test('worker recovery with a declared supervisor ends the rooms, exits 1 and starts no replacement', {
    concurrency: false,
    timeout: 60_000,
}, async (t) => {
    const { baseUrl, state, exited } = await startRecoveryServer(t, { EXTERNAL_SUPERVISOR: 'true', LOG_LEVEL: 'info' });
    const { roomEnded } = await openRoom(baseUrl, state);

    const killed = await fetch(`${baseUrl}/api/test/kill-media-worker`, { method: 'POST' });
    assert.equal(killed.status, 202);
    assert.deepEqual(await roomEnded, MEDIA_WORKER_FATAL_NOTICE);

    const result = await exitWithin(exited, 15_000);
    assert.equal(result.code, 1, `the process must exit 1 for the supervisor\n${state.output}`);
    assert.match(state.output, /external supervisor must restart Nextra/);

    // Nothing took its place: the port stays closed and no replacement was logged.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await assert.rejects(fetch(`${baseUrl}/healthz`), 'a replacement is serving on the port');
    assert.doesNotMatch(state.output, /Started replacement/);
    assert.equal((state.output.match(/Mediasoup Worker PID: \d+/g) || []).length, 1, state.output);
});
