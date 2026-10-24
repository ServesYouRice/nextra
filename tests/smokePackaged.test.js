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

function runSmokeScript(args, timeoutMs) {
    return new Promise((resolve) => {
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const startedAt = Date.now();
        const proc = spawn(process.execPath, [smokeScript, ...args], {
            cwd: repoRoot,
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        proc.stdout.on('data', (chunk) => { output += chunk; });
        proc.stderr.on('data', (chunk) => { output += chunk; });
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
