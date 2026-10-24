const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');

function reserveTcpPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close((err) => (err ? reject(err) : resolve(port)));
        });
    });
}

async function waitForReady(baseUrl, child, getOutput, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`server exited before readiness (code ${child.exitCode})\n${getOutput()}`);
        }
        try {
            const response = await fetch(`${baseUrl}/readyz`);
            if (response.ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`server did not become ready within ${timeoutMs}ms\n${getOutput()}`);
}

function runHarness(baseUrl) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [
            'scripts/churn-runtime.js',
            `--url=${baseUrl}`,
            '--duration-ms=1500',
            '--sample-ms=200',
            '--settle-ms=500',
            '--concurrency=2',
            '--cycle-delay-ms=5',
            '--max-heap-growth-percent=1000',
            '--max-resource-growth=50',
        ], { cwd: projectRoot, timeout: 20_000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(`${err.message}\n${stderr}\n${stdout}`));
            else resolve(JSON.parse(stdout));
        });
    });
}

test('churn harness completes real room/transport cycles and returns to baseline', {
    concurrency: false,
    timeout: 35_000,
}, async (t) => {
    const port = await reserveTcpPort();
    let rtcPort = await reserveTcpPort();
    while (rtcPort === port) rtcPort = await reserveTcpPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const testDistDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nextra-churn-dist-'));
    await fs.writeFile(path.join(testDistDir, 'index.html'), '<!doctype html><div id="root"></div>');
    let output = '';
    const server = spawn(process.execPath, ['server.js'], {
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
            CREATE_ROOM_RATE_LIMIT_MAX: '100000',
            JOIN_RATE_LIMIT_MAX: '100000',
            MAX_CONNECTIONS_PER_IP: '1000',
            NEXTRA_SMOKE_TEST: '1',
            NEXTRA_TEST_DIST_DIR: testDistDir,
            LOG_LEVEL: 'warn',
        },
    });
    server.stdout.on('data', (chunk) => { output += chunk.toString(); });
    server.stderr.on('data', (chunk) => { output += chunk.toString(); });
    t.after(async () => {
        try { await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' }); } catch {}
        if (server.exitCode === null) server.kill();
        await fs.rm(testDistDir, { recursive: true, force: true });
    });

    await waitForReady(baseUrl, server, () => output);
    const result = await runHarness(baseUrl);
    assert.equal(result.pass, true, JSON.stringify(result.failures));
    assert.equal(result.churnErrors, 0);
    assert.ok(result.cycles > 0);
    assert.equal(result.settled.roomsActive, 0);
    assert.equal(result.observed.socketGrowth, 0);
});

// --- Missing or partial metrics must fail the churn run, not read as zero growth ---

const http = require('node:http');
const { Server: SocketServer } = require('socket.io');

function completeChurnMetrics() {
    return {
        process: {
            memory: { heapUsed: 50_000_000 },
            resources: { total: 20, byType: { Timeout: 3 } },
        },
        rooms: { active: 0 },
        sockets: { counters: { activeSockets: 4 } },
    };
}

// A stand-in server: it acknowledges the room operations the churn cycle uses and
// serves /api/metrics. `metricsFor(requestNumber)` builds each metrics payload; the
// first request is the baseline and the last one the settled sample.
// `metricsStatus(requestNumber)` can make a metrics request fail with that HTTP status
// and `acceptConnection(attemptNumber)` can refuse a socket handshake, like the
// server's per-IP connection limiter. The fixture also records how many sockets
// connected, how many are still connected and why each one went away, so a test can
// tell a client that closed its sockets from one that was only killed.
async function startChurnFixture(metricsFor, {
    metricsStatus = () => 200,
    acceptConnection = () => true,
} = {}) {
    let requestNumber = 0;
    let handshakeAttempts = 0;
    const connections = { connected: 0, disconnectReasons: [] };
    const server = http.createServer((req, res) => {
        if (req.url.split('?')[0] !== '/api/metrics') {
            res.writeHead(404);
            res.end();
            return;
        }
        requestNumber += 1;
        const status = metricsStatus(requestNumber);
        if (status !== 200) {
            res.writeHead(status);
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(metricsFor(requestNumber)));
    });
    const io = new SocketServer(server);
    io.use((_socket, next) => {
        handshakeAttempts += 1;
        next(acceptConnection(handshakeAttempts) ? undefined : new Error('connection limit'));
    });
    io.on('connection', (socket) => {
        connections.connected += 1;
        socket.on('disconnect', (reason) => connections.disconnectReasons.push(reason));
        for (const event of ['create-room', 'create-send-transport', 'join-room', 'create-recv-transport', 'leave-room']) {
            socket.on(event, (_payload, ack) => ack({ success: true, code: 'ROOM' }));
        }
    });
    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        connections,
        liveSockets: () => io.of('/').sockets.size,
        async close() {
            await io.close();
            if (server.listening) await new Promise((resolve) => server.close(resolve));
        },
    };
}

async function waitForNoLiveSockets(fixture, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (fixture.liveSockets() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return fixture.liveSockets();
}

function runChurnHarness(baseUrl) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [
            'scripts/churn-runtime.js',
            `--url=${baseUrl}`,
            '--duration-ms=400',
            '--sample-ms=100',
            '--settle-ms=100',
            '--concurrency=1',
            '--cycle-delay-ms=5',
        ], { cwd: projectRoot, timeout: 20_000 }, (err, stdout, stderr) => {
            if (err && !stdout.trim()) {
                reject(new Error(`${err.message}\n${stderr}`));
                return;
            }
            resolve({ exitCode: err ? err.code : 0, summary: JSON.parse(stdout) });
        });
    });
}

test('churn harness passes a fixture whose metrics are complete and steady', async () => {
    const fixture = await startChurnFixture(() => completeChurnMetrics());
    try {
        const { exitCode, summary } = await runChurnHarness(fixture.baseUrl);
        assert.equal(exitCode, 0, JSON.stringify(summary.failures));
        assert.equal(summary.pass, true);
        assert.ok(summary.cycles > 0);
        assert.equal(summary.observed.heapGrowthPercent, 0);
        assert.equal(summary.observed.resourceGrowth, 0);
        assert.equal(summary.observed.socketGrowth, 0);
        assert.equal(summary.settled.roomsActive, 0);
        assert.equal(summary.observed.peakHeapUsed, 50_000_000);
        assert.equal(summary.observed.peakResources, 20);
    } finally {
        await fixture.close();
    }
});

test('churn harness fails with explicit unavailable failures when heap, resource, room and socket metrics are absent', async () => {
    const fixture = await startChurnFixture(() => ({ process: {}, rooms: {}, sockets: {} }));
    try {
        const { exitCode, summary } = await runChurnHarness(fixture.baseUrl);
        assert.equal(exitCode, 1);
        assert.equal(summary.pass, false);
        assert.deepEqual(summary.failures, [
            'heap growth unavailable',
            'active resource growth unavailable',
            'rooms active after settle unavailable',
            'active socket growth unavailable',
        ]);
        assert.equal(summary.baseline.heapUsed, null);
        assert.equal(summary.baseline.resources, null);
        assert.equal(summary.baseline.socketsActive, null);
        assert.equal(summary.settled.heapUsed, null);
        assert.equal(summary.settled.resources, null);
        assert.equal(summary.settled.roomsActive, null);
        assert.equal(summary.settled.socketsActive, null);
        assert.equal(summary.observed.heapGrowthPercent, null);
        assert.equal(summary.observed.resourceGrowth, null);
        assert.equal(summary.observed.socketGrowth, null);
        assert.equal(summary.observed.peakHeapUsed, null);
        assert.equal(summary.observed.peakResources, null);
    } finally {
        await fixture.close();
    }
});

test('churn harness fails when only the baseline sample lacks the heap and socket counts', async () => {
    const fixture = await startChurnFixture((requestNumber) => {
        const metrics = completeChurnMetrics();
        if (requestNumber === 1) {
            return { ...metrics, process: { ...metrics.process, memory: {} }, sockets: {} };
        }
        return metrics;
    });
    try {
        const { exitCode, summary } = await runChurnHarness(fixture.baseUrl);
        assert.equal(exitCode, 1);
        assert.deepEqual(summary.failures, ['heap growth unavailable', 'active socket growth unavailable']);
        assert.equal(summary.observed.resourceGrowth, 0);
        assert.equal(summary.settled.roomsActive, 0);
    } finally {
        await fixture.close();
    }
});

test('churn harness fails when the settled sample lacks the resource count and active rooms', async () => {
    // Request 1 is the baseline; every later request (the sampler's and the settled one)
    // lacks those fields.
    const fixture = await startChurnFixture((requestNumber) => {
        const metrics = completeChurnMetrics();
        if (requestNumber > 1) {
            return { ...metrics, process: { ...metrics.process, resources: {} }, rooms: {} };
        }
        return metrics;
    });
    try {
        const { exitCode, summary } = await runChurnHarness(fixture.baseUrl);
        assert.equal(exitCode, 1);
        assert.deepEqual(summary.failures, ['active resource growth unavailable', 'rooms active after settle unavailable']);
        assert.equal(summary.observed.heapGrowthPercent, 0);
        assert.equal(summary.observed.socketGrowth, 0);
        assert.equal(summary.observed.peakHeapUsed, 50_000_000);
        assert.equal(summary.observed.peakResources, null);
    } finally {
        await fixture.close();
    }
});

// --- A failed run must close every socket it opened and exit with code 1 ---

// Runs the harness for a case that fails before it can print a summary. `killed` is
// true when the process had to be stopped because it did not exit by itself.
function runFailingChurnHarness(baseUrl, { concurrency = 2, timeoutMs = 10_000 } = {}) {
    return new Promise((resolve) => {
        execFile(process.execPath, [
            'scripts/churn-runtime.js',
            `--url=${baseUrl}`,
            '--duration-ms=400',
            '--sample-ms=100',
            '--settle-ms=100',
            `--concurrency=${concurrency}`,
            '--cycle-delay-ms=5',
        ], { cwd: projectRoot, timeout: timeoutMs }, (err, stdout, stderr) => {
            resolve({
                exitCode: err ? err.code : 0,
                killed: Boolean(err?.killed),
                stdout,
                stderr,
            });
        });
    });
}

function assertClosedByTheClient(fixture, expectedConnected) {
    assert.equal(fixture.connections.connected, expectedConnected);
    assert.equal(fixture.connections.disconnectReasons.length, expectedConnected);
    assert.deepEqual(
        [...new Set(fixture.connections.disconnectReasons)],
        ['client namespace disconnect'],
        'every connected socket should have been closed by the harness, not dropped with the process',
    );
}

test('churn harness closes its whole pool and exits 1 when the baseline metrics request fails', async () => {
    const fixture = await startChurnFixture(() => completeChurnMetrics(), { metricsStatus: () => 500 });
    try {
        const result = await runFailingChurnHarness(fixture.baseUrl);
        assert.equal(result.killed, false, 'the harness should exit by itself');
        assert.equal(result.exitCode, 1);
        assert.match(result.stderr, /Churn suite failed: \/api\/metrics returned 500/);
        assert.equal(await waitForNoLiveSockets(fixture), 0);
        assertClosedByTheClient(fixture, 4);
    } finally {
        await fixture.close();
    }
});

test('churn harness closes the host that connected before a refused viewer and exits 1', async () => {
    // Handshakes are host 1, viewer 1, host 2, viewer 2: the fourth is refused, so the
    // second pair never completes and its host is connected but in no pair.
    const fixture = await startChurnFixture(() => completeChurnMetrics(), {
        acceptConnection: (attemptNumber) => attemptNumber !== 4,
    });
    try {
        const result = await runFailingChurnHarness(fixture.baseUrl);
        assert.equal(result.killed, false, 'the harness should exit by itself');
        assert.equal(result.exitCode, 1);
        assert.match(result.stderr, /Churn suite failed: connection limit/);
        assert.equal(await waitForNoLiveSockets(fixture), 0);
        assertClosedByTheClient(fixture, 3);
    } finally {
        await fixture.close();
    }
});

test('churn harness still closes its pool and exits 1 when only the settled metrics request fails', async () => {
    // The baseline (request 1) succeeds; the sampler's and the settled requests fail.
    const fixture = await startChurnFixture(() => completeChurnMetrics(), {
        metricsStatus: (requestNumber) => (requestNumber === 1 ? 200 : 500),
    });
    try {
        const result = await runFailingChurnHarness(fixture.baseUrl);
        assert.equal(result.killed, false, 'the harness should exit by itself');
        assert.equal(result.exitCode, 1);
        assert.match(result.stderr, /Could not read settled metrics: \/api\/metrics returned 500/);
        assert.equal(await waitForNoLiveSockets(fixture), 0);
        assertClosedByTheClient(fixture, 4);
    } finally {
        await fixture.close();
    }
});
