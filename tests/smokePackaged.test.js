'use strict';

// scripts/smoke-packaged.js talks to a packaged executable over HTTP. Every one of those
// calls must be bounded by its timeout across the response headers AND the body: fetch
// resolves once the headers arrive, so a server that sends headers and then stalls used to
// leave a stage pending forever, and the cleanup after the stages never ran.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const smoke = require('../scripts/smoke-packaged.js');

// The checkout may use CRLF line endings; the source scan below looks for "\n".
const scriptSource = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'smoke-packaged.js'), 'utf8')
    .split('\r\n').join('\n');

// Slack on top of the timeout for a slow, busy machine. A stalled read that is not bounded
// never comes back at all, so the margin only has to be far below "forever".
const MARGIN_MS = 2000;

const sockets = new Set();

const server = http.createServer((req, res) => {
    switch (req.url) {
    case '/ok-json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready' }));
        return;
    case '/missing-json':
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'nope' }));
        return;
    case '/ok-text':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<div id="root"></div>');
        return;
    case '/not-json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('<html>');
        return;
    case '/headers-only-then-stall':
        // Headers go out at once; the body never starts and never ends.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.flushHeaders();
        return;
    case '/partial-body-then-stall':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"status":');
        return;
    case '/no-headers':
        // Not even the headers arrive.
        return;
    default:
        res.writeHead(404);
        res.end();
    }
});
server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
});

let baseUrl;

test.before(async () => {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
});

async function timed(promise) {
    const startedAt = Date.now();
    try {
        return { value: await promise, ms: Date.now() - startedAt };
    } catch (error) {
        return { error, ms: Date.now() - startedAt };
    }
}

test('requiring smoke-packaged.js exports its helpers and does not run the smoke', async () => {
    for (const name of [
        'fetchWithTimeout', 'isReadyBody', 'waitReady', 'checkStaticShell', 'checkSocketHandshake',
        'checkPackageInfo', 'checkMediaWorkerReplacement', 'checkGracefulShutdown', 'runStages', 'cleanup', 'main',
    ]) {
        assert.equal(typeof smoke[name], 'function', name);
    }
    // main() would reject here (there is no packaged executable) and set a failing exit code.
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(process.exitCode, 1);
});

test('fetchWithTimeout returns the status, ok flag and parsed body of a finished response', async () => {
    const json = await smoke.fetchWithTimeout(`${baseUrl}/ok-json`, {}, 2000, 'json');
    assert.deepEqual(json, { status: 200, ok: true, body: { status: 'ready' } });

    const missing = await smoke.fetchWithTimeout(`${baseUrl}/missing-json`, {}, 2000, 'json');
    assert.deepEqual(missing, { status: 404, ok: false, body: { error: 'nope' } });

    const text = await smoke.fetchWithTimeout(`${baseUrl}/ok-text`, {}, 2000, 'text');
    assert.deepEqual(text, { status: 200, ok: true, body: '<div id="root"></div>' });

    const none = await smoke.fetchWithTimeout(`${baseUrl}/ok-json`, {}, 2000, 'none');
    assert.deepEqual(none, { status: 200, ok: true, body: null });

    // The read mode defaults to 'none', and the options (method) still reach fetch.
    const post = await smoke.fetchWithTimeout(`${baseUrl}/ok-json`, { method: 'POST' }, 2000);
    assert.deepEqual(post, { status: 200, ok: true, body: null });
});

test('fetchWithTimeout rejects a body that is not JSON, as response.json() did', async () => {
    await assert.rejects(smoke.fetchWithTimeout(`${baseUrl}/not-json`, {}, 2000, 'json'), SyntaxError);
});

test('fetchWithTimeout rejects an unknown read mode before it sends anything', async () => {
    await assert.rejects(smoke.fetchWithTimeout(`${baseUrl}/ok-json`, {}, 2000, 'blob'), TypeError);
});

test('the JSON read gives up at the timeout when the server sends headers and never ends the body', async () => {
    for (const route of ['headers-only-then-stall', 'partial-body-then-stall']) {
        const { error, ms } = await timed(smoke.fetchWithTimeout(`${baseUrl}/${route}`, {}, 300, 'json'));
        assert.ok(error, `${route}: the read must reject`);
        assert.equal(error.name, 'AbortError', `${route}: ${error.name}: ${error.message}`);
        assert.ok(ms >= 250 && ms < 300 + MARGIN_MS, `${route}: rejected after ${ms} ms`);
    }
});

test('the text read gives up at the timeout when the server sends headers and never ends the body', async () => {
    for (const route of ['headers-only-then-stall', 'partial-body-then-stall']) {
        const { error, ms } = await timed(smoke.fetchWithTimeout(`${baseUrl}/${route}`, {}, 300, 'text'));
        assert.ok(error, `${route}: the read must reject`);
        assert.equal(error.name, 'AbortError', `${route}: ${error.name}: ${error.message}`);
        assert.ok(ms >= 250 && ms < 300 + MARGIN_MS, `${route}: rejected after ${ms} ms`);
    }
});

test('a call that does not read the body returns at the headers and drops a body that never ends', async () => {
    for (const route of ['headers-only-then-stall', 'partial-body-then-stall']) {
        const { value, error, ms } = await timed(smoke.fetchWithTimeout(`${baseUrl}/${route}`, {}, 5000, 'none'));
        assert.equal(error, undefined, route);
        assert.deepEqual(value, { status: 200, ok: true, body: null }, route);
        assert.ok(ms < 5000, `${route}: took ${ms} ms`);
    }
});

test('a server that never sends headers is still cut off at the timeout', async () => {
    const { error, ms } = await timed(smoke.fetchWithTimeout(`${baseUrl}/no-headers`, {}, 300, 'json'));
    assert.ok(error);
    assert.equal(error.name, 'AbortError');
    assert.ok(ms >= 250 && ms < 300 + MARGIN_MS, `rejected after ${ms} ms`);
});

test('an unreachable server is a rejection, not a hang', async () => {
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address();
    await new Promise((resolve) => closed.close(resolve));
    await assert.rejects(smoke.fetchWithTimeout(`http://127.0.0.1:${port}/readyz`, {}, 1000, 'json'));
});

test('isReadyBody accepts a ready body whose required components are all ready', () => {
    assert.equal(smoke.isReadyBody({ status: 'ready' }), true);
    assert.equal(smoke.isReadyBody({ status: 'ready', components: { a: { required: true, status: 'ready' } } }), true);
    assert.equal(smoke.isReadyBody({ status: 'ready', components: { a: { required: false, status: 'starting' } } }), true);
    assert.equal(smoke.isReadyBody({ status: 'ready', components: { a: { required: true, status: 'starting' } } }), false);
    assert.equal(smoke.isReadyBody({ status: 'starting' }), false);
    assert.equal(smoke.isReadyBody(null), false);
});

test('no stage reads a response body outside the bounded fetchWithTimeout helper', () => {
    // Drop the helper's own definition: that is the one place allowed to call these.
    const start = scriptSource.indexOf('async function fetchWithTimeout');
    const end = scriptSource.indexOf('\n}\n', start) + 3;
    assert.ok(start >= 0 && end > start, 'fetchWithTimeout definition found');
    const rest = (scriptSource.slice(0, start) + scriptSource.slice(end))
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');

    assert.doesNotMatch(rest, /\.json\(\)/, 'response.json() outside fetchWithTimeout');
    assert.doesNotMatch(rest, /\.text\(\)/, 'response.text() outside fetchWithTimeout');
    assert.doesNotMatch(rest, /\.arrayBuffer\(\)|\.blob\(\)|\.formData\(\)/);
    // Every network call goes through the helper.
    assert.doesNotMatch(rest, /(?<![\w.])fetch\(/, 'a bare fetch() outside fetchWithTimeout');
});

// ---------------------------------------------------------------------------
// The smoke may check, kill the media worker of and shut down only the executable it
// launched. The port must be free before launch; a child exit outside the phases that expect
// one stops the stages at once; and the PID serving the port must be one the run owns before
// a destructive request goes out.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(__dirname, '..');
const smokeScript = path.join(repoRoot, 'scripts', 'smoke-packaged.js');

const SMOKE_PORT = 31847;
// tests/serverPorts.js pairs an even HTTP port with the odd RTC port beside it and claims the
// pair by binding UDP on the even port. Holding that claim while this file listens on 31847
// keeps every real-server test off the pair, and tells this file when one is using it.
const SMOKE_PORT_PAIR_CLAIM = SMOKE_PORT - 1;

const CAXA_DIR = '/var/folders/xy/T/caxa/applications/nextra-0123456789ab/0';
const OTHER_CAXA_DIR = '/var/folders/xy/T/caxa/applications/nextra-fedcba987654/0';
const serverCommand = (dir) => `${dir}/node_modules/.bin/node -r ${dir}/lib/startupRuntime.js ${dir}/server.js`;

const CHILD_PID = 4242;
const SERVER_PID = 5001;
const REPLACEMENT_PID = 5002;
const FOREIGN_PID = 6001;

function createFakeChild(pid = CHILD_PID) {
    const child = new EventEmitter();
    child.pid = pid;
    return child;
}

// A ChildProcess whose spawn failed has no pid.
function createUnspawnedChild() {
    const child = createFakeChild();
    child.pid = undefined;
    return child;
}

// The caxa stub the smoke launched, and the Node server it runs from its extraction.
function launchedRecords() {
    return [
        { pid: CHILD_PID, ppid: 900, command: '/repo/Nextra-macos-arm64' },
        { pid: SERVER_PID, ppid: CHILD_PID, command: serverCommand(CAXA_DIR) },
    ];
}

// A stand-in for a packaged Nextra: the routes the smoke stages call, the serving and worker
// PIDs it reports, and every request it got. It is not server.js, so a port-0 listener is fine.
async function startFakeNextra({ port: listenPort = 0 } = {}) {
    const state = { pid: SERVER_PID, workerPid: 7001, ready: true, down: false };
    const hooks = { onRequest: null, onKill: null, onShutdown: null, stall: new Set() };
    const requests = [];
    const openSockets = new Set();
    const fake = http.createServer((req, res) => {
        const route = `${req.method} ${req.url.split('?')[0]}`;
        requests.push(route);
        hooks.onRequest?.(route);
        if (state.down) {
            // Between the original server and its replacement nobody serves the port.
            req.socket.destroy();
            return;
        }
        if (hooks.stall.has(route)) return;
        const json = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        switch (route) {
        case 'GET /readyz':
            json(state.ready ? 200 : 503, { status: state.ready ? 'ready' : 'starting', components: {} });
            return;
        case 'GET /healthz':
            json(200, { status: 'ok' });
            return;
        case 'GET /':
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<div id="root"></div>');
            return;
        case 'GET /socket.io/':
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('0{"sid":"fake"}');
            return;
        case 'GET /api/package-info':
            json(200, { artifacts: { license: 'l', notices: 'n', sourceInstructions: 's', sbom: 'b', ffmpeg: 'f' } });
            return;
        case 'GET /api/metrics':
            json(200, { process: { pid: state.pid }, mediaWorker: { pid: state.workerPid } });
            return;
        case 'POST /api/test/kill-media-worker':
            json(202, { status: 'terminating', workerPid: state.workerPid });
            hooks.onKill?.();
            return;
        case 'POST /api/test/shutdown':
            json(202, { status: 'shutting-down' });
            hooks.onShutdown?.();
            return;
        default:
            json(404, { error: 'not found' });
        }
    });
    fake.on('connection', (socket) => {
        openSockets.add(socket);
        socket.on('close', () => openSockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        fake.once('error', reject);
        fake.listen(listenPort, '127.0.0.1', () => {
            fake.off('error', reject);
            resolve();
        });
    });
    let closing = null;
    const close = () => {
        if (!closing) {
            closing = new Promise((resolve) => fake.close(resolve));
            for (const socket of openSockets) socket.destroy();
        }
        return closing;
    };
    return { state, hooks, requests, close, baseUrl: `http://127.0.0.1:${fake.address().port}` };
}

async function closedPortUrl() {
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port: freePort } = closed.address();
    await new Promise((resolve) => closed.close(resolve));
    return `http://127.0.0.1:${freePort}`;
}

function trackUnhandledRejections(t) {
    const seen = [];
    const onRejection = (reason) => seen.push(reason);
    process.on('unhandledRejection', onRejection);
    t.after(() => process.off('unhandledRejection', onRejection));
    return seen;
}

// An unhandled rejection is reported once the microtask queue has drained.
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function isStillPending(promise) {
    const outcome = await Promise.race([
        promise.then(() => 'resolved', () => 'rejected'),
        settle().then(() => 'pending'),
    ]);
    return outcome === 'pending';
}

function fastRun(child, fake, overrides = {}) {
    return smoke.createRunContext({
        child,
        baseUrl: fake.baseUrl,
        listProcesses: () => launchedRecords(),
        readyIntervalMs: 20,
        readyAttempts: 100,
        pollIntervalMs: 20,
        recoveryTimeoutMs: 3000,
        runPlaywright: () => {},
        ...overrides,
    });
}

// How server.js recovers: the original process starts the replacement as its own child and
// stays, so the launched stub keeps running and the replacement descends from it. The port is
// unserved for a moment in between.
function restartAsChildOnKill(fake, setRecords, { pid = REPLACEMENT_PID, ppid = SERVER_PID, dir = CAXA_DIR } = {}) {
    fake.hooks.onKill = () => {
        fake.state.down = true;
        setTimeout(() => {
            setRecords([...launchedRecords(), { pid, ppid, command: serverCommand(dir) }]);
            Object.assign(fake.state, { pid, workerPid: 7002, down: false });
        }, 100);
    };
}

// A relaunch that hands over instead: the original spawns a detached replacement and exits 0,
// so the caxa stub the smoke launched exits 0 as well; on POSIX the replacement is reparented
// away from it.
function handOverOnKill(fake, child, setRecords, { pid = REPLACEMENT_PID, dir = CAXA_DIR, exit = [0, null] } = {}) {
    fake.hooks.onKill = () => {
        fake.state.down = true;
        setTimeout(() => {
            child.emit('exit', ...exit);
            setRecords([{ pid, ppid: 1, command: serverCommand(dir) }]);
            Object.assign(fake.state, { pid, workerPid: 7002, down: false });
        }, 100);
    };
}

test('classifyChildExit: an exit fails the run unless the harness entered a phase that expects one', () => {
    assert.deepEqual(smoke.CHILD_PHASES, ['starting', 'stages', 'recovery', 'post-recovery', 'shutdown', 'cleanup']);
    for (const phase of ['starting', 'stages']) {
        assert.equal(smoke.classifyChildExit({ phase, code: 0, signal: null }), 'unexpected', phase);
        assert.equal(smoke.classifyChildExit({ phase, code: 1, signal: null }), 'unexpected', phase);
        assert.equal(smoke.classifyChildExit({ phase, code: null, signal: 'SIGKILL' }), 'unexpected', phase);
    }
    for (const phase of ['recovery', 'post-recovery']) {
        assert.equal(smoke.classifyChildExit({ phase, code: 0, signal: null }), 'tolerated-recovery', phase);
        assert.equal(smoke.classifyChildExit({ phase, code: 1, signal: null }), 'unexpected', phase);
        assert.equal(smoke.classifyChildExit({ phase, code: null, signal: 'SIGTERM' }), 'unexpected', phase);
    }
    for (const phase of ['shutdown', 'cleanup']) {
        assert.equal(smoke.classifyChildExit({ phase, code: 0, signal: null }), 'expected', phase);
        assert.equal(smoke.classifyChildExit({ phase, code: 1, signal: null }), 'expected', phase);
        assert.equal(smoke.classifyChildExit({ phase, code: null, signal: 'SIGKILL' }), 'expected', phase);
    }
    // A child 'error' event (the spawn failed, or a signal could not be sent) is never expected.
    for (const phase of smoke.CHILD_PHASES) {
        assert.equal(smoke.classifyChildExit({ phase, error: new Error('spawn EACCES') }), 'unexpected', phase);
    }
    assert.throws(() => smoke.classifyChildExit({ phase: 'teardown', code: 0, signal: null }), TypeError);
});

test('createChildExitMonitor records the first exit with its phase and rejects `unexpected` only for an unexpected one', async (t) => {
    const unhandled = trackUnhandledRejections(t);

    const early = createFakeChild();
    const earlyMonitor = smoke.createChildExitMonitor(early);
    assert.equal(earlyMonitor.phase, 'starting');
    assert.equal(earlyMonitor.record, null);
    earlyMonitor.setPhase('stages');
    early.emit('exit', 3, null);
    await assert.rejects(earlyMonitor.unexpected, /code 3, no signal.*'stages'|'stages'.*code 3, no signal/);
    const earlyRecord = await earlyMonitor.exited;
    assert.equal(earlyRecord, earlyMonitor.record);
    assert.deepEqual({ ...earlyRecord, at: typeof earlyRecord.at }, { code: 3, signal: null, phase: 'stages', at: 'number' });
    early.emit('exit', 0, null);
    assert.equal(earlyMonitor.record.code, 3, 'only the first exit is recorded');

    const handover = createFakeChild();
    const handoverMonitor = smoke.createChildExitMonitor(handover);
    handoverMonitor.setPhase('recovery');
    handover.emit('exit', 0, null);
    assert.equal((await handoverMonitor.exited).phase, 'recovery');
    assert.equal(await isStillPending(handoverMonitor.unexpected), true, 'a code-0 handover is tolerated');
    assert.equal(handoverMonitor.phase, 'recovery', 'an observed exit never moves the phase');

    for (const [code, signal] of [[1, null], [null, 'SIGKILL']]) {
        const failed = createFakeChild();
        const failedMonitor = smoke.createChildExitMonitor(failed);
        failedMonitor.setPhase('post-recovery');
        failed.emit('exit', code, signal);
        await assert.rejects(failedMonitor.unexpected, signal ? /signal SIGKILL/ : /code 1/);
    }

    for (const phase of ['shutdown', 'cleanup']) {
        const stopped = createFakeChild();
        const stoppedMonitor = smoke.createChildExitMonitor(stopped);
        stoppedMonitor.setPhase(phase);
        stopped.emit('exit', 1, null);
        assert.equal((await stoppedMonitor.exited).phase, phase);
        assert.equal(await isStillPending(stoppedMonitor.unexpected), true, `an exit in ${phase} is expected`);
    }

    // A spawn failure: there never was a process, so `exited` settles too.
    const unspawned = createUnspawnedChild();
    const unspawnedMonitor = smoke.createChildExitMonitor(unspawned);
    unspawned.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await assert.rejects(unspawnedMonitor.unexpected, /failed to start: spawn ENOENT/);
    const unspawnedRecord = await unspawnedMonitor.exited;
    assert.equal(unspawnedRecord.phase, 'starting');
    assert.match(unspawnedRecord.error, /ENOENT/);

    // An 'error' from a running child is unexpected even in shutdown, and is not an exit.
    const erroring = createFakeChild();
    const erroringMonitor = smoke.createChildExitMonitor(erroring);
    erroringMonitor.setPhase('shutdown');
    erroring.emit('error', new Error('kill EPERM'));
    await assert.rejects(erroringMonitor.unexpected, /kill EPERM/);
    assert.equal(erroringMonitor.record, null);

    // Nobody races `unexpected` here: its rejection must not surface as unhandled.
    const ignored = createFakeChild();
    smoke.createChildExitMonitor(ignored).setPhase('stages');
    ignored.emit('exit', 1, null);
    await settle();
    assert.deepEqual(unhandled, []);
});

test('the exit monitor phases only move forward, and only to known phases', () => {
    const monitor = smoke.createChildExitMonitor(createFakeChild());
    assert.throws(() => monitor.setPhase('teardown'), TypeError);
    monitor.setPhase('recovery');
    monitor.setPhase('recovery');
    assert.throws(() => monitor.setPhase('stages'), /backwards/);
    monitor.setPhase('cleanup');
    assert.equal(monitor.phase, 'cleanup');
});

test('process records carry the parent PID on both platforms', () => {
    assert.deepEqual(smoke.parseWindowsProcessList(JSON.stringify([
        { ProcessId: 4242, ParentProcessId: 900, Name: 'Nextra.exe', ExecutablePath: 'C:\\repo\\Nextra.exe', CommandLine: '"C:\\repo\\Nextra.exe"' },
        { ProcessId: 5001, ParentProcessId: 4242, Name: 'node.exe', ExecutablePath: null, CommandLine: null },
        { ProcessId: 'not-a-pid', Name: 'odd' },
    ])), [
        { pid: 4242, ppid: 900, command: '"C:\\repo\\Nextra.exe" C:\\repo\\Nextra.exe Nextra.exe' },
        { pid: 5001, ppid: 4242, command: 'node.exe' },
    ]);
    // ConvertTo-Json writes one object, not an array, when there is a single process.
    assert.deepEqual(smoke.parseWindowsProcessList(JSON.stringify({ ProcessId: 4, ParentProcessId: 0, Name: 'System' })), [
        { pid: 4, ppid: 0, command: 'System' },
    ]);
    assert.deepEqual(smoke.parsePsProcessList([
        '    1     0 /sbin/launchd',
        ' 4242   900 /repo/Nextra-macos-arm64 --flag',
        ` 5001  4242 ${serverCommand(CAXA_DIR)}`,
        '   77     1',
        '',
    ].join('\n')), [
        { pid: 1, ppid: 0, command: '/sbin/launchd' },
        { pid: 4242, ppid: 900, command: '/repo/Nextra-macos-arm64 --flag' },
        { pid: 5001, ppid: 4242, command: serverCommand(CAXA_DIR) },
        { pid: 77, ppid: 1, command: '' },
    ]);
});

test('isDescendant follows parent PIDs up to the launched child, and nowhere else', () => {
    const records = [
        { pid: CHILD_PID, ppid: 900, command: 'Nextra.exe' },
        { pid: SERVER_PID, ppid: CHILD_PID, command: serverCommand(CAXA_DIR) },
        { pid: 5003, ppid: SERVER_PID, command: 'mediasoup-worker' },
        { pid: FOREIGN_PID, ppid: 900, command: serverCommand(CAXA_DIR) },
        { pid: REPLACEMENT_PID, ppid: 1, command: serverCommand(CAXA_DIR) },
        { pid: 8001, ppid: 8002, command: 'loop' },
        { pid: 8002, ppid: 8001, command: 'loop' },
    ];
    assert.equal(smoke.isDescendant(SERVER_PID, CHILD_PID, records), true, 'child of the launched process');
    assert.equal(smoke.isDescendant(5003, CHILD_PID, records), true, 'grandchild');
    assert.equal(smoke.isDescendant(CHILD_PID, CHILD_PID, records), true, 'the launched process itself');
    assert.equal(smoke.isDescendant(FOREIGN_PID, CHILD_PID, records), false, 'a sibling instance of the same build');
    assert.equal(smoke.isDescendant(REPLACEMENT_PID, CHILD_PID, records), false, 'reparented away');
    assert.equal(smoke.isDescendant(8001, CHILD_PID, records), false, 'a parent cycle ends the walk');
    assert.equal(smoke.isDescendant(9999, CHILD_PID, records), false, 'not in the list');
    assert.equal(smoke.isDescendant(SERVER_PID, CHILD_PID, []), false, 'no process list, no proof');
    assert.equal(smoke.isDescendant(SERVER_PID, undefined, records), false, 'no launched PID (spawn failed)');
});

test('caxaApplicationDirectory reads the same extraction from the stub-built and the Node-built command line', () => {
    const id = smoke.caxaApplicationDirectory;
    assert.equal(id(serverCommand(CAXA_DIR)), 'nextra-0123456789ab/0');
    // The caxa stub joins the Windows temp dir with forward slashes; a replacement Node spawns
    // from process.execPath uses backslashes, and Windows records may differ in case.
    const fromStub = 'C:\\Users\\V\\AppData\\Local\\Temp/caxa/applications/nextra-0123456789ab/0/node_modules/.bin/node -r '
        + 'C:\\Users\\V\\AppData\\Local\\Temp/caxa/applications/nextra-0123456789ab/0/lib/startupRuntime.js node.exe';
    const fromNode = '"C:\\Users\\V\\AppData\\Local\\Temp\\caxa\\applications\\NEXTRA-0123456789AB\\0\\node_modules\\.bin\\node.exe" -r x';
    assert.equal(id(fromStub), id(serverCommand(CAXA_DIR)));
    assert.equal(id(fromNode), id(fromStub));
    assert.notEqual(id(serverCommand(OTHER_CAXA_DIR)), id(serverCommand(CAXA_DIR)));
    assert.equal(id('/usr/local/bin/node server.js'), null);
    assert.equal(id(undefined), null);
});

test('a replacement PID is adopted only from the launched build, and only while no stranger answered the port', () => {
    const base = {
        ownedPids: new Set([CHILD_PID, SERVER_PID]),
        childPid: CHILD_PID,
        childExited: false,
        ownedCaxaDirectory: smoke.caxaApplicationDirectory(serverCommand(CAXA_DIR)),
        portObservedUnowned: false,
    };
    const decide = (overrides) => smoke.decideReplacementAdoption({ ...base, ...overrides });
    const withProcess = (pid, ppid, dir = CAXA_DIR) => [...launchedRecords(), { pid, ppid, command: serverCommand(dir) }];

    assert.equal(decide({ pid: SERVER_PID, records: [] }).verdict, 'owned');
    // The launched child is running and the replacement is its grandchild (the original server's child).
    assert.equal(decide({ pid: REPLACEMENT_PID, records: withProcess(REPLACEMENT_PID, SERVER_PID) }).verdict, 'adopt');
    // The launched child exited 0 in a handover: reparented (ppid 1), from the launched build's extraction.
    assert.equal(decide({ pid: REPLACEMENT_PID, childExited: true, records: withProcess(REPLACEMENT_PID, 1) }).verdict, 'adopt');

    const unowned = [
        // caxa reuses one extraction per build: while the launched child runs, only ancestry tells them apart.
        ['a same-build copy that is not a descendant', { pid: FOREIGN_PID, records: withProcess(FOREIGN_PID, 1) }],
        ['another build, as a descendant', { pid: FOREIGN_PID, records: withProcess(FOREIGN_PID, SERVER_PID, OTHER_CAXA_DIR) }],
        ['another build after a handover', { pid: FOREIGN_PID, childExited: true, records: withProcess(FOREIGN_PID, 1, OTHER_CAXA_DIR) }],
        ['not a caxa process', {
            pid: FOREIGN_PID, childExited: true, records: [{ pid: FOREIGN_PID, ppid: 1, command: 'node server.js' }],
        }],
        ['not in the process list', { pid: FOREIGN_PID, records: withProcess(REPLACEMENT_PID, SERVER_PID) }],
        ['a stranger answered earlier', {
            pid: REPLACEMENT_PID, records: withProcess(REPLACEMENT_PID, SERVER_PID), portObservedUnowned: true,
        }],
        ['launched build unknown', { pid: REPLACEMENT_PID, records: withProcess(REPLACEMENT_PID, SERVER_PID), ownedCaxaDirectory: null }],
        ['no PID in the answer', { pid: undefined, records: withProcess(REPLACEMENT_PID, SERVER_PID) }],
    ];
    for (const [label, overrides] of unowned) {
        const decision = decide(overrides);
        assert.equal(decision.verdict, 'unowned', label);
        assert.equal(typeof decision.reason, 'string', label);
    }
});

test('the pre-launch probe refuses a port where anything answers, and passes only a refused connection', async (t) => {
    const fake = await startFakeNextra();
    t.after(() => fake.close());
    await assert.rejects(smoke.assertSmokePortFree(fake.baseUrl, 1000), /occupied.*HTTP 200/);
    assert.deepEqual(fake.requests, ['GET /healthz']);

    // Any HTTP answer counts, not only a healthy Nextra.
    const teapot = http.createServer((_req, res) => {
        res.writeHead(418);
        res.end();
    });
    await new Promise((resolve) => teapot.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => teapot.close(resolve)));
    await assert.rejects(smoke.assertSmokePortFree(`http://127.0.0.1:${teapot.address().port}`, 1000), /occupied.*HTTP 418/);

    // A listener that accepts and never answers is not a free port either.
    const accepted = new Set();
    const silent = net.createServer((socket) => accepted.add(socket));
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        for (const socket of accepted) socket.destroy();
        return new Promise((resolve) => silent.close(resolve));
    });
    const { error, ms } = await timed(smoke.assertSmokePortFree(`http://127.0.0.1:${silent.address().port}`, 300));
    assert.match(error?.message ?? '', /not free/);
    assert.ok(ms < 300 + MARGIN_MS, `probe took ${ms} ms`);

    await smoke.assertSmokePortFree(await closedPortUrl(), 1000);
});

function bindUdpClaim(claimPort) {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', (err) => {
            socket.close();
            if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(null);
            else reject(err);
        });
        socket.bind(claimPort, '127.0.0.1', () => {
            socket.removeAllListeners('error');
            socket.on('error', () => {});
            resolve(socket);
        });
    });
}

// Listens on the real smoke port, waiting a while if another test or process holds it.
async function holdSmokePort() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const claim = await bindUdpClaim(SMOKE_PORT_PAIR_CLAIM);
        if (claim) {
            try {
                const fake = await startFakeNextra({ port: SMOKE_PORT });
                return { fake, release: async () => { await fake.close(); claim.close(); } };
            } catch (err) {
                claim.close();
                if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
            }
        }
        await settle(500);
    }
    return null;
}

// options.env is merged over this process's environment (a PATH given there replaces every
// spelling of it), options.script runs instead of the smoke script, and options.onOutput sees
// the output gathered so far after every chunk.
function runSmokeScript(args, timeoutMs, { env: extraEnv = {}, script = smokeScript, onOutput = null } = {}) {
    return new Promise((resolve) => {
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        if ('PATH' in extraEnv) {
            for (const key of Object.keys(env)) {
                if (key.toUpperCase() === 'PATH') delete env[key];
            }
        }
        Object.assign(env, extraEnv);
        const startedAt = Date.now();
        const proc = spawn(process.execPath, [script, ...args], {
            cwd: repoRoot,
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        const gather = (chunk) => {
            output += chunk;
            onOutput?.(output);
        };
        proc.stdout.on('data', gather);
        proc.stderr.on('data', gather);
        const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
        proc.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, output, ms: Date.now() - startedAt });
        });
    });
}

test('with a server already answering on the smoke port, the smoke exits before launching and sends it nothing', async (t) => {
    const held = await holdSmokePort();
    if (!held) {
        t.skip(`port ${SMOKE_PORT} stayed taken by another process`);
        return;
    }
    t.after(() => held.release());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-smoke-port-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // A real executable under a unique path (Node itself: with no script and no stdin it exits
    // at once), so only the port check stands between the smoke and a launch.
    const launchable = path.join(dir, `never-launched${path.extname(process.execPath)}`);
    try {
        fs.linkSync(process.execPath, launchable);
    } catch {
        fs.copyFileSync(process.execPath, launchable);
    }

    const result = await runSmokeScript([launchable], 15000);
    const outcome = `exit ${result.code} ${result.signal} after ${result.ms} ms\n${result.output}`;
    assert.deepEqual(held.fake.requests, ['GET /healthz'], `the instance on the port got more than the probe\n${outcome}`);
    assert.equal(result.code, 1, outcome);
    assert.match(result.output, /port 31847 is occupied/i);
    assert.doesNotMatch(result.output, /Starting packaged executable/);
    assert.ok(result.ms < 10000, outcome);
});

test('a child that exits before readiness stops the stages at once, with its exit code', async (t) => {
    const unhandled = trackUnhandledRejections(t);
    const fake = await startFakeNextra();
    t.after(() => fake.close());
    fake.state.ready = false;
    const child = createFakeChild();
    // The production readiness budget: 60 polls 500 ms apart.
    const run = smoke.createRunContext({ child, baseUrl: fake.baseUrl, listProcesses: launchedRecords });
    setTimeout(() => child.emit('exit', 1, null), 200);

    const { error, ms } = await timed(smoke.runStages(run));
    assert.match(error?.message ?? '', /code 1, no signal/);
    assert.match(error.message, /'starting'/);
    assert.ok(ms < 3000, `stages stopped after ${ms} ms`);

    // The readiness poll stops as well, so nothing keeps the process alive afterwards.
    assert.equal(run.signal.aborted, true);
    const seen = fake.requests.length;
    await settle(1200);
    assert.equal(fake.requests.length, seen, 'no readiness polls after the abort');
    assert.deepEqual(unhandled, []);
});

test('a spawn error stops the stages at once', async (t) => {
    const fake = await startFakeNextra();
    t.after(() => fake.close());
    fake.state.ready = false;
    const child = createUnspawnedChild();
    const run = smoke.createRunContext({ child, baseUrl: fake.baseUrl, listProcesses: launchedRecords });
    assert.equal(run.ownedPids.size, 0);
    setTimeout(() => child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })), 100);

    const { error, ms } = await timed(smoke.runStages(run));
    assert.match(error?.message ?? '', /failed to start: spawn EACCES/);
    assert.ok(ms < 3000, `stages stopped after ${ms} ms`);
});

test('a child exit during the static shell, handshake or package-info stage stops the run at once', async (t) => {
    t.mock.method(console, 'log', () => {});
    for (const route of ['GET /', 'GET /socket.io/', 'GET /api/package-info']) {
        const fake = await startFakeNextra();
        t.after(() => fake.close());
        const child = createFakeChild();
        fake.hooks.stall.add(route);
        fake.hooks.onRequest = (seen) => {
            if (seen === route) setTimeout(() => child.emit('exit', null, 'SIGKILL'), 50);
        };
        const run = fastRun(child, fake);

        // Each of these stages would otherwise wait out its own 5 s timeout.
        const { error, ms } = await timed(smoke.runStages(run));
        assert.match(error?.message ?? '', /signal SIGKILL/, route);
        assert.match(error.message, /'stages'/, route);
        assert.ok(ms < 3000, `${route}: stopped after ${ms} ms`);
        assert.equal(fake.requests.some((seen) => seen.startsWith('POST')), false, route);
    }
});

test('a ready server that is not the launched executable or its descendant fails readiness before any stage', async (t) => {
    const fake = await startFakeNextra();
    t.after(() => fake.close());
    const child = createFakeChild();
    const run = fastRun(child, fake, {
        listProcesses: () => [
            { pid: CHILD_PID, ppid: 900, command: '/repo/Nextra-macos-arm64' },
            { pid: SERVER_PID, ppid: 777, command: serverCommand(CAXA_DIR) },
        ],
    });

    await assert.rejects(smoke.runStages(run), /PID 5001.*not the launched executable/);
    assert.equal(run.ownedPids.has(SERVER_PID), false);
    assert.equal(fake.requests.includes('GET /'), false, 'no stage ran');
    assert.equal(fake.requests.some((seen) => seen.startsWith('POST')), false);
});

test('kill-media-worker is sent only while the PID serving the port is owned by the run', async (t) => {
    const fake = await startFakeNextra();
    t.after(() => fake.close());
    const run = fastRun(createFakeChild(), fake);
    await smoke.verifyLaunchedServer(run);
    run.monitor.setPhase('stages');
    fake.state.pid = FOREIGN_PID;

    await assert.rejects(smoke.checkMediaWorkerReplacement(run), /kill-media-worker.*PID 6001/);
    assert.equal(fake.requests.includes('POST /api/test/kill-media-worker'), false);
    assert.equal(run.monitor.phase, 'stages', 'the recovery phase is entered only right before the kill request');
});

test('recovery adopts the replacement the original server starts as its child, while the launched child keeps running', async (t) => {
    t.mock.method(console, 'log', () => {});
    const unhandled = trackUnhandledRejections(t);
    const fake = await startFakeNextra();
    t.after(() => fake.close());
    const child = createFakeChild();
    let records = launchedRecords();
    const run = fastRun(child, fake, { listProcesses: () => records });
    await smoke.verifyLaunchedServer(run);
    run.monitor.setPhase('stages');
    restartAsChildOnKill(fake, (next) => { records = next; });

    await smoke.raceUnexpected(run, smoke.checkMediaWorkerReplacement(run));
    assert.equal(run.monitor.phase, 'post-recovery');
    assert.equal(run.monitor.record, null, 'the launched child did not exit');
    assert.deepEqual([...run.ownedPids].sort(), [CHILD_PID, SERVER_PID, REPLACEMENT_PID]);
    assert.equal(run.servingPid, REPLACEMENT_PID);
    await settle();
    assert.deepEqual(unhandled, []);
});

test('a same-build copy that does not descend from the still-running launched child is not adopted', async (t) => {
    t.mock.method(console, 'log', () => {});
    const fake = await startFakeNextra();
    t.after(() => fake.close());
    const child = createFakeChild();
    let records = launchedRecords();
    const run = fastRun(child, fake, { listProcesses: () => records, recoveryTimeoutMs: 10_000 });
    await smoke.verifyLaunchedServer(run);
    run.monitor.setPhase('stages');
    // Another instance of the same build took the port in the gap: same caxa extraction, parent elsewhere.
    restartAsChildOnKill(fake, (next) => { records = next; }, { pid: FOREIGN_PID, ppid: 900 });

    const { error, ms } = await timed(smoke.raceUnexpected(run, smoke.checkMediaWorkerReplacement(run)));
    assert.match(error?.message ?? '', /PID 6001 does not descend from the launched executable/);
    assert.ok(ms < 3000, `failed after ${ms} ms`);
    assert.equal(run.ownedPids.has(FOREIGN_PID), false);
    assert.equal(run.ownership.portObservedUnowned, true);
    assert.equal(fake.requests.includes('POST /api/test/shutdown'), false);
});

test('a code-0 exit of the child after kill-media-worker is accepted is a handover: recovery passes once the replacement is adopted', async (t) => {
    t.mock.method(console, 'log', () => {});
    const unhandled = trackUnhandledRejections(t);
    const fake = await startFakeNextra();
    t.after(() => fake.close());
    const child = createFakeChild();
    let records = launchedRecords();
    const run = fastRun(child, fake, { listProcesses: () => records });
    await smoke.verifyLaunchedServer(run);
    run.monitor.setPhase('stages');
    let phaseAtKill = null;
    handOverOnKill(fake, child, (next) => { records = next; });
    const handOver = fake.hooks.onKill;
    fake.hooks.onKill = () => {
        phaseAtKill = run.monitor.phase;
        handOver();
    };

    await smoke.raceUnexpected(run, smoke.checkMediaWorkerReplacement(run));
    assert.equal(phaseAtKill, 'recovery');
    assert.equal(run.monitor.phase, 'post-recovery');
    assert.deepEqual({ ...run.monitor.record, at: 0 }, { code: 0, signal: null, phase: 'recovery', at: 0 });
    assert.equal(run.ownedPids.has(REPLACEMENT_PID), true);
    assert.equal(run.servingPid, REPLACEMENT_PID);
    assert.equal(run.ownership.portObservedUnowned, false);
    await settle();
    assert.deepEqual(unhandled, []);
});

test('a late code-0 child exit after the replacement was adopted is still tolerated', async (t) => {
    t.mock.method(console, 'log', () => {});
    const fake = await startFakeNextra();
    t.after(() => fake.close());
    const child = createFakeChild();
    let records = launchedRecords();
    const run = fastRun(child, fake, { listProcesses: () => records });
    await smoke.verifyLaunchedServer(run);
    run.monitor.setPhase('stages');
    // The replacement serves at once; the stub's exit arrives only after the stage passed.
    fake.hooks.onKill = () => {
        records = [...launchedRecords(), { pid: REPLACEMENT_PID, ppid: SERVER_PID, command: serverCommand(CAXA_DIR) }];
        Object.assign(fake.state, { pid: REPLACEMENT_PID, workerPid: 7002 });
    };

    await smoke.raceUnexpected(run, smoke.checkMediaWorkerReplacement(run));
    assert.equal(run.monitor.record, null);
    child.emit('exit', 0, null);
    assert.equal(run.monitor.record.phase, 'post-recovery');
    assert.equal(await isStillPending(run.monitor.unexpected), true);
});

test('without an adopted replacement the recovery stage fails at its deadline and reports the child exit', async (t) => {
    t.mock.method(console, 'log', () => {});
    const unhandled = trackUnhandledRejections(t);
    const fake = await startFakeNextra();
    t.after(() => fake.close());
    const child = createFakeChild();
    const run = fastRun(child, fake, { recoveryTimeoutMs: 600 });
    await smoke.verifyLaunchedServer(run);
    run.monitor.setPhase('stages');
    fake.hooks.onKill = () => {
        fake.state.down = true;
        setTimeout(() => child.emit('exit', 0, null), 50);
    };

    const { error, ms } = await timed(smoke.raceUnexpected(run, smoke.checkMediaWorkerReplacement(run)));
    assert.match(error?.message ?? '', /did not replace the failed media worker/);
    assert.match(error.message, /code 0, no signal/);
    assert.match(error.message, /'recovery'/);
    assert.ok(ms >= 550 && ms < 600 + MARGIN_MS, `failed after ${ms} ms`);
    assert.deepEqual([...run.ownedPids].sort(), [CHILD_PID, SERVER_PID]);
    await settle();
    assert.deepEqual(unhandled, []);
});

test('a non-zero or signalled child exit during recovery fails it at once', async (t) => {
    t.mock.method(console, 'log', () => {});
    for (const [exit, pattern] of [[[1, null], /code 1, no signal/], [[null, 'SIGKILL'], /signal SIGKILL/]]) {
        const fake = await startFakeNextra();
        t.after(() => fake.close());
        const child = createFakeChild();
        const run = fastRun(child, fake, { recoveryTimeoutMs: 10_000 });
        await smoke.verifyLaunchedServer(run);
        run.monitor.setPhase('stages');
        fake.hooks.onKill = () => {
            fake.state.down = true;
            setTimeout(() => child.emit('exit', ...exit), 50);
        };

        const { error, ms } = await timed(smoke.raceUnexpected(run, smoke.checkMediaWorkerReplacement(run)));
        assert.match(error?.message ?? '', pattern);
        assert.match(error.message, /'recovery'/);
        assert.ok(ms < 3000, `failed after ${ms} ms`);
    }
});

test('a replacement that does not run from the launched build is not adopted, and recovery fails', async (t) => {
    t.mock.method(console, 'log', () => {});
    const fake = await startFakeNextra();
    t.after(() => fake.close());
    const child = createFakeChild();
    let records = launchedRecords();
    const run = fastRun(child, fake, { listProcesses: () => records, recoveryTimeoutMs: 10_000 });
    await smoke.verifyLaunchedServer(run);
    run.monitor.setPhase('stages');
    handOverOnKill(fake, child, (next) => { records = next; }, { pid: FOREIGN_PID, dir: OTHER_CAXA_DIR });

    const { error, ms } = await timed(smoke.raceUnexpected(run, smoke.checkMediaWorkerReplacement(run)));
    assert.match(error?.message ?? '', /PID 6001/);
    assert.ok(ms < 3000, `failed after ${ms} ms`);
    assert.equal(run.ownedPids.has(FOREIGN_PID), false);
    assert.equal(run.ownership.portObservedUnowned, true);
});

test('a simulated packaged run passes every stage in order, each destructive request right after an ownership check', async (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const unhandled = trackUnhandledRejections(t);
    const fake = await startFakeNextra();
    t.after(() => fake.close());
    const child = createFakeChild();
    let records = launchedRecords();
    const playwrightPhases = [];
    const run = fastRun(child, fake, {
        listProcesses: () => records,
        runPlaywright: () => playwrightPhases.push(run.monitor.phase),
    });
    restartAsChildOnKill(fake, (next) => { records = next; });
    // The replacement stops, then the original exits with its code, and the launched stub with it.
    fake.hooks.onShutdown = () => setImmediate(async () => {
        await fake.close();
        records = [];
        child.emit('exit', 0, null);
    });

    await smoke.runStages(run);
    const passed = log.mock.calls.map((call) => String(call.arguments[0])).filter((line) => / passed\.$/.test(line));
    assert.deepEqual(passed, [
        'Initial packaged readiness passed.',
        'Packaged process and mediasoup worker replacement passed.',
        'Packaged decoded-frame flow passed.',
        'Packaged graceful shutdown passed.',
    ]);
    assert.deepEqual(playwrightPhases, ['post-recovery']);
    for (const destructive of ['POST /api/test/kill-media-worker', 'POST /api/test/shutdown']) {
        const at = fake.requests.indexOf(destructive);
        assert.ok(at > 0, destructive);
        assert.equal(fake.requests[at - 1], 'GET /api/metrics', `${destructive} follows an ownership check`);
    }
    assert.deepEqual([...run.ownedPids].sort(), [CHILD_PID, SERVER_PID, REPLACEMENT_PID]);
    assert.equal(run.monitor.record?.code, 0, 'the launched child ended with the shutdown');
    assert.equal(await isStillPending(run.monitor.unexpected), true);
    await settle();
    assert.deepEqual(unhandled, []);
});

test('the cleanup shutdown request goes only to a server the run owns', async (t) => {
    t.mock.method(console, 'log', () => {});
    const fake = await startFakeNextra();
    t.after(() => fake.close());
    const run = fastRun(createFakeChild(), fake, {
        listProcesses: () => [
            ...launchedRecords(),
            { pid: FOREIGN_PID, ppid: 900, command: serverCommand(CAXA_DIR) },
        ],
    });

    fake.state.pid = FOREIGN_PID;
    assert.equal(await smoke.requestCleanupShutdown(run), false);
    assert.deepEqual(fake.requests, ['GET /api/metrics']);

    // The launched child's own server, even before readiness put it in the owned set.
    fake.state.pid = SERVER_PID;
    assert.equal(await smoke.requestCleanupShutdown(run), true);
    assert.deepEqual(fake.requests.slice(1), ['GET /api/metrics', 'POST /api/test/shutdown']);

    // Nothing on the port: nothing to send, and no error.
    assert.equal(await smoke.requestCleanupShutdown({ ...run, baseUrl: await closedPortUrl() }), false);
});

// ---------------------------------------------------------------------------
// Shutdown and cleanup. A process list that cannot be read is an error, never "no processes".
// The shutdown stage passes only when the shutdown was accepted, the launched executable
// exited with code 0 in the 'shutdown' phase (or had already handed over during recovery), the
// port refuses connections and no process the run owns is left. Cleanup kills only the
// processes the run owns and their descendants, and reports what survived the shutdown before
// it kills it.
// ---------------------------------------------------------------------------

const WORKER_PID = 5003;
const workerCommand = (dir) => `${dir}/node_modules/mediasoup/worker/out/Release/mediasoup-worker`;

const fetchFailed = (cause) => Object.assign(new TypeError('fetch failed'), { cause });
const withCode = (message, code) => Object.assign(new Error(message), { code });

// A fake child that, like a ChildProcess, emits 'exit' once it was killed.
function createKillableChild(pid = CHILD_PID, onKill = () => {}) {
    const child = createFakeChild(pid);
    child.killSignals = [];
    child.kill = (signal) => {
        child.killSignals.push(signal);
        onKill(signal);
        setImmediate(() => child.emit('exit', null, signal));
        return true;
    };
    return child;
}

// A run that passed readiness, as the shutdown stage finds it: the launched stub and its
// server, owned and served on a fake Nextra. state.records is what the process list shows.
async function runAtShutdown(t, overrides = {}) {
    const fake = await startFakeNextra();
    t.after(() => fake.close());
    const child = overrides.child ?? createFakeChild();
    const state = { records: launchedRecords() };
    const run = fastRun(child, fake, { listProcesses: () => state.records, shutdownTimeoutMs: 1500, ...overrides });
    await smoke.verifyLaunchedServer(run);
    run.monitor.setPhase('stages');
    return { fake, child, run, state };
}

test('listProcesses throws when the process list cannot be read, instead of returning no processes', () => {
    const list = (platform, result) => () => smoke.listProcesses({ platform, spawnSyncImpl: () => result });
    for (const platform of ['win32', 'darwin']) {
        assert.throws(list(platform, { error: withCode('spawnSync powershell.exe ENOENT', 'ENOENT'), status: null, stdout: '' }), /ENOENT/, platform);
        // Output over maxBuffer: spawnSync kills the query and sets ENOBUFS, keeping a cut-off stdout.
        assert.throws(list(platform, {
            error: withCode('spawnSync ps ENOBUFS', 'ENOBUFS'), status: null, signal: 'SIGTERM', stdout: '[{"ProcessId":4,',
        }), /ENOBUFS/, platform);
        assert.throws(list(platform, { status: 1, stdout: '', stderr: 'Access is denied.' }), /status 1.*Access is denied/, platform);
        assert.throws(list(platform, { status: null, signal: 'SIGKILL', stdout: '' }), /SIGKILL/, platform);
        assert.throws(list(platform, { status: 0, stdout: '' }), /no output/, platform);
        assert.throws(list(platform, { status: 0, stdout: ' \r\n' }), /no output/, platform);
    }
    assert.throws(list('win32', { status: 0, stdout: '[{"ProcessId":4,' }), /could not be parsed/);
    assert.throws(list('win32', { status: 0, stdout: '[]' }), /no process records/);
    assert.throws(list('darwin', { status: 0, stdout: 'not a process line\n' }), /no process records/);

    // A list that can be read still comes back as records, from the query each platform uses.
    const calls = [];
    const record = (command, args, options) => {
        calls.push({ command, maxBuffer: options.maxBuffer });
        return command === 'ps'
            ? { status: 0, stdout: '    1     0 /sbin/launchd\n' }
            : { status: 0, stdout: JSON.stringify({ ProcessId: 4, ParentProcessId: 0, Name: 'System' }) };
    };
    assert.deepEqual(smoke.listProcesses({ platform: 'darwin', spawnSyncImpl: record }), [{ pid: 1, ppid: 0, command: '/sbin/launchd' }]);
    assert.deepEqual(smoke.listProcesses({ platform: 'win32', spawnSyncImpl: record }), [{ pid: 4, ppid: 0, command: 'System' }]);
    assert.deepEqual(calls.map((call) => call.command), ['ps', 'powershell.exe']);
    assert.ok(calls.every((call) => call.maxBuffer >= 64 * 1024 * 1024), 'room for a large process list');
});

test('selectCleanupTargets picks the processes the run owns and their descendants, never another instance or a pre-existing process', () => {
    const pids = (records) => records.map((record) => record.pid).sort((a, b) => a - b);
    const select = (options) => pids(smoke.selectCleanupTargets({ ownedPids: new Set([CHILD_PID, SERVER_PID]), ...options }));
    const tree = [
        ...launchedRecords(),
        { pid: WORKER_PID, ppid: SERVER_PID, command: workerCommand(CAXA_DIR) },
        { pid: REPLACEMENT_PID, ppid: SERVER_PID, command: serverCommand(CAXA_DIR) },
    ];
    // Another instance of the same build, started during the run: same caxa extraction, and its
    // own worker, but neither descends from the launched child.
    const sameBuild = [
        { pid: FOREIGN_PID, ppid: 900, command: serverCommand(CAXA_DIR) },
        { pid: 6002, ppid: FOREIGN_PID, command: workerCommand(CAXA_DIR) },
    ];
    assert.deepEqual(select({ records: [...tree, ...sameBuild] }), [CHILD_PID, SERVER_PID, REPLACEMENT_PID, WORKER_PID]);
    assert.deepEqual(select({ records: sameBuild }), [], 'nothing of the run is left');
    assert.deepEqual(pids(smoke.selectCleanupTargets({ records: tree, ownedPids: new Set() })), [], 'no owned PID, no target');

    // On Windows a process keeps the PID of a parent that died. One that was there before the
    // launch, whose dead parent had the PID the launched child got, is not the run's, and neither
    // is a process it starts later.
    const preExisting = { pid: 3001, ppid: CHILD_PID, command: 'C:\\Windows\\explorer.exe' };
    const startedByIt = { pid: 3002, ppid: 3001, command: 'C:\\tools\\helper.exe' };
    const baseline = new Map([[preExisting.pid, preExisting.command]]);
    assert.deepEqual(select({ records: [...tree, preExisting, startedByIt], baseline }), [CHILD_PID, SERVER_PID, REPLACEMENT_PID, WORKER_PID]);
    // The baseline protects a process, not a number: an owned process that got the PID of a
    // baseline process that has since ended is still the run's.
    assert.deepEqual(select({ records: tree, baseline: new Map([[SERVER_PID, 'powershell.exe -NoProfile']]) }), [CHILD_PID, SERVER_PID, REPLACEMENT_PID, WORKER_PID]);

    // A worker whose server already exited keeps the server's PID as its parent on Windows.
    assert.deepEqual(select({ records: [launchedRecords()[0], { pid: WORKER_PID, ppid: SERVER_PID, command: workerCommand(CAXA_DIR) }] }), [CHILD_PID, WORKER_PID]);
    // On macOS it is reparented to launchd; only a process seen in the run's tree before is still known.
    const reparented = { pid: WORKER_PID, ppid: 1, command: workerCommand(CAXA_DIR) };
    assert.deepEqual(select({ records: [reparented] }), []);
    assert.deepEqual(select({ records: [reparented], knownProcesses: new Map([[WORKER_PID, reparented.command]]) }), [WORKER_PID]);
    // A known PID that now runs something else was reused: neither it nor its children are the run's.
    const reused = [
        { pid: SERVER_PID, ppid: 900, command: 'C:\\Windows\\System32\\notepad.exe' },
        { pid: 7001, ppid: SERVER_PID, command: 'C:\\Windows\\System32\\conhost.exe' },
    ];
    assert.deepEqual(select({ records: reused, knownProcesses: new Map([[SERVER_PID, serverCommand(CAXA_DIR)]]) }), []);
    // Once the launched child's exit was observed, a process holding its PID is not the child.
    assert.deepEqual(select({
        records: [{ pid: CHILD_PID, ppid: 900, command: '/repo/Nextra-macos-arm64' }, { pid: 7002, ppid: CHILD_PID, command: 'other' }],
        exitedPids: [CHILD_PID],
    }), []);
});

test('classifyShutdownProbeError counts only a refused or reset connection as down', async () => {
    const classify = smoke.classifyShutdownProbeError;
    assert.equal(classify(fetchFailed(withCode('connect ECONNREFUSED 127.0.0.1:31847', 'ECONNREFUSED'))), 'down');
    assert.equal(classify(fetchFailed({ errors: [withCode('a', 'ECONNREFUSED'), withCode('b', 'ECONNREFUSED')] })), 'down');
    assert.equal(classify(fetchFailed(withCode('read ECONNRESET', 'ECONNRESET'))), 'down');
    assert.equal(classify(new DOMException('This operation was aborted', 'AbortError')), 'unknown', 'a timeout is not a stop');
    assert.equal(classify(new DOMException('The operation timed out.', 'TimeoutError')), 'unknown');
    assert.equal(classify(fetchFailed(withCode('other side closed', 'UND_ERR_SOCKET'))), 'unknown');
    assert.equal(classify(fetchFailed({ errors: [withCode('a', 'ECONNREFUSED'), withCode('b', 'ETIMEDOUT')] })), 'unknown');
    assert.equal(classify(new SyntaxError('Unexpected token')), 'unknown');

    // The same, from real requests: a closed port, and a listener that never answers.
    await assert.rejects(smoke.fetchWithTimeout(`${await closedPortUrl()}/healthz`, {}, 1000), (err) => classify(err) === 'down');
    await assert.rejects(smoke.fetchWithTimeout(`${baseUrl}/no-headers`, {}, 200), (err) => classify(err) === 'unknown');
});

test('evaluateShutdown passes only an accepted shutdown, a code-0 exit in the shutdown phase or an earlier handover, and no survivors', () => {
    const accepted = { status: 202 };
    const exit = (phase, code = 0, signal = null) => ({ code, signal, phase, at: 0 });
    const evaluate = (overrides) => smoke.evaluateShutdown({
        childExit: exit('shutdown'), survivingOwnedPids: [], postResult: accepted, deadlineExpired: false, ...overrides,
    });

    const clean = evaluate({});
    assert.equal(clean.passed, true);
    assert.match(clean.notes.join(' '), /exited \(code 0, no signal\) in phase 'shutdown'/);

    for (const phase of ['recovery', 'post-recovery']) {
        const handedOver = evaluate({ childExit: exit(phase) });
        assert.equal(handedOver.passed, true, phase);
        assert.match(handedOver.notes.join(' '), /replacement exit code not observable/, phase);
    }

    const failures = [
        [{ childExit: exit('shutdown', 1) }, /code 1, no signal.*'shutdown'/],
        [{ childExit: exit('shutdown', null, 'SIGKILL') }, /signal SIGKILL.*'shutdown'/],
        [{ childExit: exit('stages', 0) }, /before the shutdown/],
        [{ childExit: null, deadlineExpired: true }, /did not exit/],
        [{ survivingOwnedPids: [WORKER_PID, REPLACEMENT_PID], deadlineExpired: true }, /processes survived graceful shutdown: 5003, 5002/],
        [{ postResult: { status: 404 } }, /HTTP 404/],
        [{ postResult: { status: 503 } }, /HTTP 503/],
        [{ postResult: { error: new DOMException('This operation was aborted', 'AbortError') } }, /shutdown request failed.*AbortError/],
        [{ postResult: { error: fetchFailed(withCode('connect ECONNREFUSED', 'ECONNREFUSED')) } }, /shutdown request failed/],
        [{ postResult: { error: fetchFailed(withCode('read ECONNRESET', 'ECONNRESET')) }, childExit: null, deadlineExpired: true }, /reset.*no exit/],
        [{ portDown: false, deadlineExpired: true }, /did not refuse connections/],
        [{ deadlineExpired: true }, /did not complete/],
    ];
    for (const [overrides, pattern] of failures) {
        const evaluation = evaluate(overrides);
        assert.equal(evaluation.passed, false, String(pattern));
        assert.match(evaluation.failures.join('; '), pattern);
    }

    // The server may close the connection as it exits: a reset counts once an owned exit followed.
    for (const error of [fetchFailed(withCode('read ECONNRESET', 'ECONNRESET')), fetchFailed(withCode('other side closed', 'UND_ERR_SOCKET'))]) {
        assert.equal(evaluate({ postResult: { error } }).passed, true, error.cause.code);
    }
});

test('the requested exit of the launched executable passes the shutdown stage, in the shutdown phase set before the request', async (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const unhandled = trackUnhandledRejections(t);
    const { fake, child, run, state } = await runAtShutdown(t);
    let phaseAtRequest = null;
    fake.hooks.onShutdown = () => {
        phaseAtRequest = run.monitor.phase;
        // The child exits with code 0 right after the shutdown answer, and its tree with it.
        setImmediate(async () => {
            await fake.close();
            state.records = [];
            child.emit('exit', 0, null);
        });
    };

    await smoke.checkGracefulShutdown(run);
    assert.equal(phaseAtRequest, 'shutdown');
    assert.deepEqual({ ...run.monitor.record, at: 0 }, { code: 0, signal: null, phase: 'shutdown', at: 0 });
    assert.equal(await isStillPending(run.monitor.unexpected), true, 'the expected exit is not unexpected');
    const lines = log.mock.calls.map((call) => String(call.arguments[0]));
    assert.ok(lines.some((line) => /exited \(code 0, no signal\) in phase 'shutdown'/.test(line)), lines.join('\n'));
    await settle();
    assert.deepEqual(unhandled, []);
});

test('after a handover in recovery the shutdown stage waits only for the adopted replacement, and says its exit code is not observable', async (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const unhandled = trackUnhandledRejections(t);
    const { fake, child, run, state } = await runAtShutdown(t);
    // The launched stub handed over with code 0; the replacement is reparented away from it.
    run.monitor.setPhase('recovery');
    child.emit('exit', 0, null);
    run.monitor.setPhase('post-recovery');
    run.ownedPids.add(REPLACEMENT_PID);
    fake.state.pid = REPLACEMENT_PID;
    state.records = [{ pid: REPLACEMENT_PID, ppid: 1, command: serverCommand(CAXA_DIR) }];
    fake.hooks.onShutdown = () => setTimeout(async () => {
        await fake.close();
        state.records = [];
    }, 100);

    const { error, ms } = await timed(smoke.checkGracefulShutdown(run));
    assert.equal(error, undefined, error?.message);
    assert.ok(ms < 1500, `waited ${ms} ms, as if for a child exit`);
    const lines = log.mock.calls.map((call) => String(call.arguments[0]));
    assert.ok(lines.some((line) => /replacement exit code not observable/.test(line)), lines.join('\n'));
    await settle();
    assert.deepEqual(unhandled, []);
});

test('a non-zero or signalled exit of the launched executable in the shutdown phase fails the shutdown stage', async (t) => {
    t.mock.method(console, 'log', () => {});
    for (const [exit, pattern] of [[[1, null], /code 1, no signal/], [[null, 'SIGTERM'], /signal SIGTERM/]]) {
        const { fake, child, run, state } = await runAtShutdown(t);
        fake.hooks.onShutdown = () => setImmediate(async () => {
            await fake.close();
            state.records = [];
            child.emit('exit', ...exit);
        });

        const { error } = await timed(smoke.checkGracefulShutdown(run));
        assert.match(error?.message ?? 'the stage passed', pattern);
        assert.match(error.message, /'shutdown'/);
    }
});

test('a /healthz timeout is not a stop: the shutdown stage fails when the port never refuses connections', async (t) => {
    t.mock.method(console, 'log', () => {});
    const { fake, child, run, state } = await runAtShutdown(t);
    // The tree exits, but something keeps accepting connections on the port and never answers.
    fake.hooks.stall.add('GET /healthz');
    fake.hooks.onShutdown = () => setImmediate(() => {
        state.records = [];
        child.emit('exit', 0, null);
    });

    const { error, ms } = await timed(smoke.checkGracefulShutdown(run));
    assert.match(error?.message ?? 'the stage passed', /did not shut down gracefully/);
    assert.match(error.message, /did not refuse connections/);
    assert.ok(ms < 1500 + 1000 + MARGIN_MS, `failed after ${ms} ms`);
});

test('a process the run owns that is still alive at the shutdown deadline fails the shutdown stage', async (t) => {
    t.mock.method(console, 'log', () => {});
    const { fake, child, run, state } = await runAtShutdown(t);
    // The server and the stub exit with code 0, the server's media worker lingers.
    fake.hooks.onShutdown = () => setImmediate(async () => {
        await fake.close();
        state.records = [{ pid: WORKER_PID, ppid: SERVER_PID, command: workerCommand(CAXA_DIR) }];
        child.emit('exit', 0, null);
    });

    const { error, ms } = await timed(smoke.checkGracefulShutdown(run));
    assert.match(error?.message ?? 'the stage passed', /processes survived graceful shutdown: 5003/);
    assert.ok(ms >= 1400 && ms < 1500 + MARGIN_MS, `failed after ${ms} ms`);
});

test('cleanup kills the launched child through its handle, the processes the run owns and their descendants, and nothing else', async (t) => {
    t.mock.method(console, 'log', () => {});
    let records = [
        ...launchedRecords(),
        { pid: WORKER_PID, ppid: SERVER_PID, command: workerCommand(CAXA_DIR) },
        // Another instance of the same build, started during the run, and one that ran before it.
        { pid: FOREIGN_PID, ppid: 900, command: serverCommand(CAXA_DIR) },
        { pid: 3001, ppid: 900, command: serverCommand(OTHER_CAXA_DIR) },
    ];
    const gone = (pid) => { records = records.filter((record) => record.pid !== pid); };
    const killed = [];
    const child = createKillableChild(CHILD_PID, () => gone(CHILD_PID));
    const run = smoke.createRunContext({
        child,
        baseUrl: await closedPortUrl(),
        listProcesses: () => records,
        baseline: new Map([[3001, serverCommand(OTHER_CAXA_DIR)]]),
        killProcess: (pid) => {
            killed.push(pid);
            gone(pid);
        },
        cleanupGraceMs: 20,
    });
    run.ownedPids.add(SERVER_PID);

    assert.equal(await smoke.cleanup(run), null);
    assert.deepEqual(child.killSignals, ['SIGKILL']);
    assert.deepEqual(killed.sort((a, b) => a - b), [SERVER_PID, WORKER_PID]);
    assert.deepEqual(records.map((record) => record.pid).sort((a, b) => a - b), [3001, FOREIGN_PID]);
    assert.equal(run.monitor.record?.phase, 'cleanup');
});

test('a process list that cannot be read in cleanup is a cleanup error, and the child is still killed through its handle', async (t) => {
    t.mock.method(console, 'log', () => {});
    const child = createKillableChild();
    const run = smoke.createRunContext({
        child,
        baseUrl: await closedPortUrl(),
        listProcesses: () => { throw new Error('Process enumeration failed: powershell.exe exited with status 1.'); },
        killProcess: () => assert.fail('nothing can be attributed without a process list'),
        cleanupGraceMs: 20,
    });

    const error = await smoke.cleanup(run);
    assert.match(error?.message ?? 'no cleanup error', /enumeration failed/);
    assert.deepEqual(child.killSignals, ['SIGKILL']);
    assert.equal(run.monitor.record?.signal, 'SIGKILL');
});

test('cleanup reports the processes that survived graceful shutdown as a failure, then kills them', async (t) => {
    t.mock.method(console, 'log', () => {});
    const killed = [];
    // Called only once the run below exists.
    const gone = (pid) => { setup.state.records = setup.state.records.filter((record) => record.pid !== pid); };
    const child = createKillableChild(CHILD_PID, () => gone(CHILD_PID));
    const setup = await runAtShutdown(t, {
        child,
        shutdownTimeoutMs: 300,
        killProcess: (pid) => {
            killed.push(pid);
            gone(pid);
        },
        cleanupGraceMs: 20,
    });
    const { fake, run, state } = setup;
    // The server stops answering, but neither it nor the stub exits.
    fake.hooks.onShutdown = () => setImmediate(() => fake.close());

    await assert.rejects(smoke.checkGracefulShutdown(run), /processes survived graceful shutdown/);
    const error = await smoke.cleanup(run);
    assert.match(error?.message ?? 'no cleanup error', /survived graceful shutdown: 4242 \(.*\), 5001 \(.*\)/);
    assert.deepEqual(child.killSignals, ['SIGKILL']);
    assert.deepEqual(killed, [SERVER_PID]);
    assert.deepEqual(state.records, []);
});

test('cleanup reports a cloudflared the run started, or any new one, and never one that ran before', async (t) => {
    t.mock.method(console, 'log', () => {});
    const tunnel = { pid: 8100, ppid: SERVER_PID, command: 'C:\\cache\\cloudflared.exe tunnel --url http://127.0.0.1:31847' };
    const earlier = { pid: 8200, ppid: 900, command: 'C:\\cache\\cloudflared.exe tunnel run' };
    let records = [...launchedRecords(), tunnel, earlier];
    const killed = [];
    const child = createKillableChild(CHILD_PID, () => { records = records.filter((record) => record.pid !== CHILD_PID); });
    const run = smoke.createRunContext({
        child,
        baseUrl: await closedPortUrl(),
        listProcesses: () => records,
        baseline: new Map([[earlier.pid, earlier.command]]),
        killProcess: (pid) => {
            killed.push(pid);
            records = records.filter((record) => record.pid !== pid);
        },
        cleanupGraceMs: 20,
    });
    run.ownedPids.add(SERVER_PID);

    const error = await smoke.cleanup(run);
    assert.match(error?.message ?? 'no cleanup error', /cloudflared process remained after shutdown \(PID 8100\)/);
    assert.doesNotMatch(error.message, /8200/);
    assert.deepEqual(killed.sort((a, b) => a - b), [SERVER_PID, 8100]);
});

// ---------------------------------------------------------------------------
// The real script against real processes: a stand-in for the packaged executable with the
// process tree of the caxa build. It runs from a directory named like a caxa extraction, as
// the stub, which starts the server; on kill-media-worker the server releases the port, runs a
// replacement as its own child and ends with that child's exit code.
// ---------------------------------------------------------------------------

const FAKE_NEXTRA_SOURCE = String.raw`'use strict';
// Loaded with --require into a bare node: with no script and stdin ignored it runs an empty
// program, so this file is the whole process. Anything else that loads it through NODE_OPTIONS
// (the smoke script, a test driver) has a script argument and is left alone.
if (process.argv.length === 1 && process.env.FAKE_NEXTRA_ROLE) {
    const fs = require('node:fs');
    const http = require('node:http');
    const { spawn } = require('node:child_process');
    const role = process.env.FAKE_NEXTRA_ROLE;
    const modes = new Set(String(process.env.FAKE_NEXTRA_MODE || '').split(',').filter(Boolean));
    // Never outlive the test that started it.
    setTimeout(() => process.exit(3), 60000).unref();
    if (process.env.FAKE_NEXTRA_PID_FILE) {
        fs.appendFileSync(process.env.FAKE_NEXTRA_PID_FILE, role + ' ' + process.pid + '\n');
    }
    const startRole = (next) => spawn(process.execPath, [], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, FAKE_NEXTRA_ROLE: next },
    });
    if (role === 'stub') {
        // The caxa stub runs the server from the extraction and ends with its exit code.
        startRole('server').on('exit', (code) => process.exit(code === null ? 1 : code));
    } else {
        const workerPid = role === 'server' ? 101 : 102;
        const readyAt = Date.now() + Number(process.env.FAKE_NEXTRA_READY_DELAY_MS || 0);
        const server = http.createServer((req, res) => {
            const route = req.method + ' ' + req.url.split('?')[0];
            const json = (status, body) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body));
            };
            const release = () => {
                server.close();
                server.closeAllConnections();
            };
            if (route === 'GET /readyz') {
                json(200, { status: Date.now() >= readyAt ? 'ready' : 'starting', components: {} });
            } else if (route === 'GET /healthz') {
                json(200, { status: 'ok' });
            } else if (route === 'GET /') {
                res.writeHead(200, { 'content-type': 'text/html' });
                res.end('<div id="root"></div>');
            } else if (route === 'GET /socket.io/') {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end('0{"sid":"fake"}');
            } else if (route === 'GET /api/package-info') {
                const artifacts = { license: 'l', notices: 'n', sourceInstructions: 's', sbom: 'b', ffmpeg: 'f' };
                if (modes.has('missing-artifact')) delete artifacts.ffmpeg;
                json(200, { artifacts });
            } else if (route === 'GET /api/metrics') {
                json(200, { process: { pid: process.pid }, mediaWorker: { pid: workerPid } });
            } else if (route === 'POST /api/test/kill-media-worker') {
                res.on('finish', () => {
                    release();
                    // As server.js: with a supervisor declared, exit 1 for it to restart Nextra.
                    if (['1', 'true', 'yes', 'on'].includes(String(process.env.EXTERNAL_SUPERVISOR || '').trim().toLowerCase())) {
                        process.exit(1);
                    }
                    startRole('replacement').on('exit', (code) => process.exit(code === null ? 1 : code));
                });
                json(202, { status: 'terminating', workerPid });
            } else if (route === 'POST /api/test/shutdown') {
                if (!modes.has('ignore-shutdown')) {
                    res.on('finish', () => {
                        release();
                        process.exit(0);
                    });
                }
                json(202, { status: 'shutting-down' });
            } else {
                json(404, { error: 'not found' });
            }
        });
        const listen = () => server.listen(Number(process.env.PORT), process.env.BIND_HOST || '127.0.0.1');
        server.on('error', (err) => {
            if (err && err.code === 'EADDRINUSE') setTimeout(listen, 50);
            else throw err;
        });
        listen();
    }
}
`;

function tcpPortFree(checkPort) {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.listen(checkPort, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
}

// Keeps real-server tests off the smoke port pair while the launched stand-in listens on it.
async function claimFreeSmokePort() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const claim = await bindUdpClaim(SMOKE_PORT_PAIR_CLAIM);
        if (claim) {
            if (await tcpPortFree(SMOKE_PORT)) return { release: () => claim.close() };
            claim.close();
        }
        await settle(500);
    }
    return null;
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

// The stand-in executable under <tmp>/.../caxa/applications/nextra-<id>/0, the environment
// that turns it into the stub, and the PIDs its processes wrote down. Afterwards it kills any
// of them still running, matched by their command line, never by a PID alone.
function prepareFakeExecutable(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-smoke-tree-'));
    const appDir = path.join(root, 'caxa', 'applications', `nextra-${path.basename(root).slice(-6).toLowerCase()}`, '0');
    fs.mkdirSync(appDir, { recursive: true });
    const executable = path.join(appDir, `Nextra${path.extname(process.execPath)}`);
    try {
        fs.linkSync(process.execPath, executable);
    } catch {
        fs.copyFileSync(process.execPath, executable);
    }
    const fixture = path.join(root, 'fake-nextra.js');
    fs.writeFileSync(fixture, FAKE_NEXTRA_SOURCE);
    const pidFile = path.join(root, 'pids.txt');
    const pids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : '')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [role, pid] = line.trim().split(' ');
            return { role, pid: Number(pid) };
        });
    t.after(async () => {
        try {
            const mine = executable.toLowerCase();
            for (const record of smoke.listProcesses()) {
                if (record.command.toLowerCase().includes(mine)) {
                    try { process.kill(record.pid, 'SIGKILL'); } catch {}
                }
            }
        } catch {}
        await settle(300);
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    return {
        root,
        executable,
        pids,
        env: {
            NODE_OPTIONS: `--require "${fixture.split(path.sep).join('/')}"`,
            FAKE_NEXTRA_ROLE: 'stub',
            FAKE_NEXTRA_PID_FILE: pidFile,
        },
    };
}

test('cleanup kills the tree of the executable the smoke launched and leaves a Nextra instance started during the run alone', async (t) => {
    const smokePort = await claimFreeSmokePort();
    if (!smokePort) {
        t.skip(`port ${SMOKE_PORT} stayed taken by another process`);
        return;
    }
    t.after(() => smokePort.release());
    const tree = prepareFakeExecutable(t);
    // Another caxa-packaged Nextra, started after the smoke took its baseline.
    const decoyScript = path.join(tree.root, 'caxa', 'applications', 'nextra-decoy', '0', 'server.js');
    let decoy = null;
    t.after(() => decoy?.kill('SIGKILL'));

    const result = await runSmokeScript([tree.executable], 30000, {
        env: { ...tree.env, FAKE_NEXTRA_MODE: 'missing-artifact,ignore-shutdown', FAKE_NEXTRA_READY_DELAY_MS: '1500' },
        onOutput: (output) => {
            if (!decoy && /Starting packaged executable/.test(output)) {
                decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', decoyScript], { stdio: 'ignore', windowsHide: true });
            }
        },
    });
    await settle(300);
    const outcome = `exit ${result.code} ${result.signal} after ${result.ms} ms\n${result.output}`;
    assert.ok(decoy, outcome);
    assert.equal(result.code, 1, outcome);
    assert.match(result.output, /Packaged artifact is missing ffmpeg/, outcome);
    assert.equal(isAlive(decoy.pid), true, `the smoke killed a Nextra instance it did not launch (PID ${decoy.pid})\n${outcome}`);
    assert.equal(decoy.exitCode, null, outcome);
    const launched = tree.pids();
    assert.deepEqual(launched.map((entry) => entry.role).sort(), ['server', 'stub'], outcome);
    for (const { role, pid } of launched) {
        assert.equal(isAlive(pid), false, `the launched ${role} (PID ${pid}) outlived the smoke\n${outcome}`);
    }
});

test('a process list that cannot be read before the launch stops the smoke before it launches anything', async (t) => {
    const smokePort = await claimFreeSmokePort();
    if (!smokePort) {
        t.skip(`port ${SMOKE_PORT} stayed taken by another process`);
        return;
    }
    t.after(() => smokePort.release());
    const tree = prepareFakeExecutable(t);
    // With nothing on PATH, neither powershell.exe nor ps can be started.
    const emptyPath = path.join(tree.root, 'empty-path');
    fs.mkdirSync(emptyPath);

    const result = await runSmokeScript([tree.executable], 20000, {
        env: { ...tree.env, FAKE_NEXTRA_MODE: 'ignore-shutdown', PATH: emptyPath },
    });
    const outcome = `exit ${result.code} ${result.signal} after ${result.ms} ms\n${result.output}`;
    assert.equal(result.code, 1, outcome);
    assert.match(result.output, /process baseline/i, outcome);
    assert.doesNotMatch(result.output, /Starting packaged executable/, outcome);
    assert.deepEqual(tree.pids(), [], `something was launched\n${outcome}`);
    assert.ok(result.ms < 10000, outcome);
});

test('a simulated packaged run with real processes passes, logs the launched executable exit, and the smoke ends on its own', async (t) => {
    const smokePort = await claimFreeSmokePort();
    if (!smokePort) {
        t.skip(`port ${SMOKE_PORT} stayed taken by another process`);
        return;
    }
    t.after(() => smokePort.release());
    const tree = prepareFakeExecutable(t);
    // The real main(), with the decoded-frame (Playwright) flow left out.
    const driver = path.join(tree.root, 'drive-smoke.js');
    fs.writeFileSync(driver, [
        "'use strict';",
        `const smoke = require(${JSON.stringify(smokeScript)});`,
        `smoke.main({ executable: ${JSON.stringify(tree.executable)}, runOptions: { runPlaywright: () => {} } })`,
        '    .then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 1; });',
        '',
    ].join('\n'));

    // A runner that declares a supervisor for its own services: the smoke pins it off for the
    // executable it launches, whose own recovery it tests.
    const result = await runSmokeScript([], 45000, { script: driver, env: { ...tree.env, EXTERNAL_SUPERVISOR: 'true' } });
    const outcome = `exit ${result.code} ${result.signal} after ${result.ms} ms\n${result.output}`;
    assert.equal(result.signal, null, `the smoke did not end on its own\n${outcome}`);
    assert.equal(result.code, 0, outcome);
    assert.match(result.output, /Adopted replacement server PID/, outcome);
    assert.match(result.output, /Packaged graceful shutdown passed\./, outcome);
    assert.match(result.output, /exited \(code 0, no signal\) in phase 'shutdown'/, outcome);
    assert.match(result.output, /Packaged smoke passed\./, outcome);
    const launched = tree.pids();
    assert.deepEqual(launched.map((entry) => entry.role).sort(), ['replacement', 'server', 'stub'], outcome);
    for (const { role, pid } of launched) {
        assert.equal(isAlive(pid), false, `the ${role} (PID ${pid}) outlived the smoke\n${outcome}`);
    }
});
