const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const selfsigned = require('selfsigned');
const { createMetricsFetcher } = require('../scripts/runtime-metrics-client');

async function generateSelfSigned() {
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }],
    });
    return { cert: pems.cert, key: pems.private };
}

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeServer(server) {
    return new Promise((resolve) => server.close(resolve));
}

function metricsHandler(received) {
    return (req, res) => {
        received.push({ url: req.url, authorization: req.headers.authorization });
        if (req.url.split('?')[0] !== '/api/metrics') {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    };
}

test('metrics fetch against an HTTPS target with a self-signed certificate succeeds with allowInsecureTls', async () => {
    const received = [];
    const { cert, key } = await generateSelfSigned();
    const server = https.createServer({ cert, key }, metricsHandler(received));
    const port = await listen(server);
    try {
        const fetchMetrics = createMetricsFetcher({
            baseUrl: `https://127.0.0.1:${port}`,
            allowInsecureTls: true,
            token: 'secret-token',
        });
        const metrics = await fetchMetrics();
        assert.deepEqual(metrics, { ok: true });
        assert.equal(received[0].url, '/api/metrics?resetEventLoopDelay=true');
        assert.equal(received[0].authorization, 'Bearer secret-token');
    } finally {
        await closeServer(server);
    }
});

test('metrics fetch against an HTTPS target with a self-signed certificate fails when TLS verification is on', async () => {
    const received = [];
    const { cert, key } = await generateSelfSigned();
    const server = https.createServer({ cert, key }, metricsHandler(received));
    const port = await listen(server);
    try {
        const fetchMetrics = createMetricsFetcher({
            baseUrl: `https://127.0.0.1:${port}`,
            allowInsecureTls: false,
        });
        await assert.rejects(fetchMetrics(), (err) => {
            assert.match(err.code || err.message, /SELF_SIGNED|CERT|UNABLE_TO_VERIFY/i);
            return true;
        });
        assert.equal(received.length, 0);
    } finally {
        await closeServer(server);
    }
});

test('metrics fetch against an HTTP target is unaffected and sends no Authorization header without a token', async () => {
    const received = [];
    const server = http.createServer(metricsHandler(received));
    const port = await listen(server);
    try {
        const fetchMetrics = createMetricsFetcher({
            baseUrl: `http://127.0.0.1:${port}`,
            allowInsecureTls: true,
            token: '',
        });
        assert.deepEqual(await fetchMetrics(), { ok: true });
        assert.equal(received[0].url, '/api/metrics?resetEventLoopDelay=true');
        assert.equal(received[0].authorization, undefined);
    } finally {
        await closeServer(server);
    }
});

test('metrics fetch does not change process-wide TLS verification', async () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const { cert, key } = await generateSelfSigned();
    const server = https.createServer({ cert, key }, metricsHandler([]));
    const port = await listen(server);
    try {
        const fetchMetrics = createMetricsFetcher({
            baseUrl: `https://127.0.0.1:${port}`,
            allowInsecureTls: true,
        });
        await fetchMetrics();
        assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, before);
    } finally {
        await closeServer(server);
    }
});

// --- Harness-level checks: missing resource metrics must not pass silently ---

const { execFile } = require('node:child_process');
const path = require('node:path');
const { Server: SocketServer } = require('socket.io');

const projectRoot = path.resolve(__dirname, '..');

function completeBenchmarkMetrics(startedAt) {
    // Worker and process CPU both climb at 10% of wall time; RSS barely moves.
    const elapsed = Date.now() - startedAt;
    return {
        process: {
            memory: { rss: 100_000_000 + elapsed * 100 },
            cpuUsageMicroseconds: { user: elapsed * 50, system: elapsed * 50 },
            eventLoopDelayMs: { mean: 1, p95: 2, max: 5 },
        },
        rooms: { active: 1, totalViewers: 1, totalRelayViewers: 0, totalMediasoupConsumers: 1 },
        sockets: { counters: { activeProducers: 1, activeFallbackPipelines: 0 }, rooms: [] },
        mediaWorker: { resourceUsage: { ru_utime: elapsed * 0.05, ru_stime: elapsed * 0.05 } },
    };
}

// A stand-in for the Nextra server: signalling acknowledgements plus an /api/metrics
// endpoint whose payload each test can degrade (`degrade(metrics, requestNumber)`).
// `metricsStatus(requestNumber)` can make a metrics request fail with that HTTP status
// and `acceptConnection(attemptNumber)` can refuse a socket handshake. The fixture
// also records how many sockets connected, how many are still connected and why each
// one went away, so a test can tell a client that closed its sockets from one that
// was only killed.
async function startBenchmarkFixture(degrade = (metrics) => metrics, {
    metricsStatus = () => 200,
    acceptConnection = () => true,
} = {}) {
    const startedAt = Date.now();
    let requestNumber = 0;
    let handshakeAttempts = 0;
    const connections = { connected: 0, acks: 0, disconnectReasons: [] };
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
        res.end(JSON.stringify(degrade(completeBenchmarkMetrics(startedAt), requestNumber)));
    });
    const io = new SocketServer(server);
    io.use((_socket, next) => {
        handshakeAttempts += 1;
        next(acceptConnection(handshakeAttempts) ? undefined : new Error('connection limit'));
    });
    io.on('connection', (socket) => {
        connections.connected += 1;
        socket.on('disconnect', (reason) => connections.disconnectReasons.push(reason));
        socket.on('get-rtp-capabilities', (_payload, ack) => {
            connections.acks += 1;
            ack({ success: true, rtpCapabilities: {} });
        });
    });
    const port = await listen(server);
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        connections,
        liveSockets: () => io.of('/').sockets.size,
        async close() {
            await io.close();
            if (server.listening) await closeServer(server).catch(() => {});
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

function runBenchmarkHarness(baseUrl) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [
            'scripts/benchmark-runtime.js',
            `--url=${baseUrl}`,
            '--scenario=webrtc',
            '--label=fixture',
            '--clients=1',
            '--duration-ms=700',
            '--sample-ms=100',
            '--ack-interval-ms=50',
        ], { cwd: projectRoot, timeout: 20_000 }, (err, stdout, stderr) => {
            if (err && !stdout.trim()) {
                reject(new Error(`${err.message}\n${stderr}`));
                return;
            }
            resolve({ exitCode: err ? err.code : 0, summary: JSON.parse(stdout) });
        });
    });
}

test('benchmark with complete metrics reports measured values and passes', async () => {
    const fixture = await startBenchmarkFixture();
    try {
        const { exitCode, summary } = await runBenchmarkHarness(fixture.baseUrl);
        assert.equal(exitCode, 0, JSON.stringify(summary.failures));
        assert.equal(summary.pass, true);
        for (const field of ['workerCpuPercent', 'processCpuPercent', 'memoryGrowthPercent', 'eventLoopP95Ms', 'eventLoopMaxMs']) {
            assert.equal(Number.isFinite(summary.observed[field]), true, `${field} should be measured`);
        }
        assert.equal(summary.observed.eventLoopP95Ms, 2);
        assert.equal(summary.observed.eventLoopMaxMs, 5);
        assert.equal(Number.isFinite(summary.headroomPercent.workerCpu), true);
        assert.equal(Number.isFinite(summary.headroomPercent.processCpu), true);
        assert.equal(Number.isFinite(summary.headroomPercent.memoryGrowth), true);
    } finally {
        await fixture.close();
    }
});

test('benchmark fails closed and reports null when worker, process, RSS and event-loop metrics are absent', async () => {
    const fixture = await startBenchmarkFixture((metrics) => ({
        ...metrics,
        process: {},
        mediaWorker: { pid: null, resourceUsage: null },
    }));
    try {
        const { exitCode, summary } = await runBenchmarkHarness(fixture.baseUrl);
        assert.equal(exitCode, 1);
        assert.equal(summary.pass, false);
        for (const field of ['workerCpuPercent', 'processCpuPercent', 'memoryGrowthPercent', 'eventLoopP95Ms', 'eventLoopMaxMs']) {
            assert.equal(summary.observed[field], null, `${field} should be null`);
        }
        assert.deepEqual(summary.headroomPercent, {
            ackP95: summary.headroomPercent.ackP95,
            eventLoopP95: null,
            eventLoopMax: null,
            workerCpu: null,
            processCpu: null,
            memoryGrowth: null,
        });
        assert.deepEqual(summary.failures, [
            'event-loop p95 unavailable',
            'event-loop max unavailable',
            'media-worker CPU unavailable',
            'Node process CPU unavailable',
            'RSS growth unavailable',
        ]);
    } finally {
        await fixture.close();
    }
});

test('benchmark fails closed when only one sample lacks the event-loop delay', async () => {
    const fixture = await startBenchmarkFixture((metrics, requestNumber) => (
        requestNumber === 3 ? { ...metrics, process: { ...metrics.process, eventLoopDelayMs: undefined } } : metrics
    ));
    try {
        const { exitCode, summary } = await runBenchmarkHarness(fixture.baseUrl);
        assert.equal(exitCode, 1);
        assert.equal(summary.observed.eventLoopP95Ms, null);
        assert.equal(summary.observed.eventLoopMaxMs, null);
        assert.deepEqual(summary.failures, ['event-loop p95 unavailable', 'event-loop max unavailable']);
        assert.equal(Number.isFinite(summary.observed.workerCpuPercent), true);
    } finally {
        await fixture.close();
    }
});

test('benchmark fails closed when the worker usage lacks the system CPU time', async () => {
    const fixture = await startBenchmarkFixture((metrics) => ({
        ...metrics,
        mediaWorker: { resourceUsage: { ru_utime: metrics.mediaWorker.resourceUsage.ru_utime } },
    }));
    try {
        const { exitCode, summary } = await runBenchmarkHarness(fixture.baseUrl);
        assert.equal(exitCode, 1);
        assert.equal(summary.observed.workerCpuPercent, null);
        assert.deepEqual(summary.failures, ['media-worker CPU unavailable']);
    } finally {
        await fixture.close();
    }
});

// --- The required topology must hold in every sample of the measured window ---

// Request 1 is the warm-up whose result is discarded; request n (n >= 2) is sample n - 1.
test('benchmark fails when the required load is missing in earlier samples even though the last sample has it', async () => {
    const fixture = await startBenchmarkFixture((metrics, requestNumber) => {
        if (requestNumber === 3) {
            return { ...metrics, rooms: { ...metrics.rooms, totalMediasoupConsumers: 0 } };
        }
        if (requestNumber === 4) {
            return { ...metrics, sockets: { ...metrics.sockets, counters: { ...metrics.sockets.counters, activeProducers: 0 } } };
        }
        return metrics;
    });
    try {
        const { exitCode, summary } = await runBenchmarkHarness(fixture.baseUrl);
        // The final sample alone meets every requirement: the topology it reports is complete.
        assert.equal(summary.topology.producers, 1);
        assert.equal(summary.topology.consumers, 1);
        assert.equal(exitCode, 1);
        assert.equal(summary.pass, false);
        assert.equal(summary.failures.length, 2, JSON.stringify(summary.failures));
        assert.match(summary.failures[0], /^required 1 producers in every sample, lowest observed 0, first unmet at sample 3 of \d+ \(\d{4}-\d{2}-\d{2}T[\d:.]+Z\)$/);
        assert.match(summary.failures[1], /^required 1 mediasoup consumers in every sample, lowest observed 0, first unmet at sample 2 of \d+ \(\d{4}-\d{2}-\d{2}T[\d:.]+Z\)$/);
        assert.equal(summary.topologyMinimums.producers, 0);
        assert.equal(summary.topologyMinimums.consumers, 0);
        assert.equal(summary.topologyMinimums.rooms, 1);
    } finally {
        await fixture.close();
    }
});

test('benchmark reports the lowest observed load of the window and passes when every sample meets the requirements', async () => {
    const fixture = await startBenchmarkFixture((metrics, requestNumber) => ({
        ...metrics,
        rooms: { ...metrics.rooms, totalMediasoupConsumers: requestNumber === 4 ? 2 : 3, totalViewers: requestNumber === 4 ? 2 : 3 },
    }));
    try {
        const { exitCode, summary } = await runBenchmarkHarness(fixture.baseUrl);
        assert.equal(exitCode, 0, JSON.stringify(summary.failures));
        assert.equal(summary.pass, true);
        assert.deepEqual(summary.failures, []);
        assert.deepEqual(summary.topologyMinimums, {
            rooms: 1,
            producers: 1,
            consumers: 2,
            viewers: 2,
            relayViewers: 0,
            fallbackPipelines: 0,
        });
        // The existing keys keep their meaning: the last sample's load and the whole-window relay total.
        assert.equal(summary.topology.clients, 1);
        assert.equal(summary.topology.consumers, 3);
        assert.equal(summary.topology.relayBytesForwarded, 0);
    } finally {
        await fixture.close();
    }
});

// --- A failed run must close every socket it opened and exit with code 1 ---

// Runs the harness for a case that fails before it can print a summary. `killed` is
// true when the process had to be stopped because it did not exit by itself.
function runFailingBenchmarkHarness(baseUrl, { clients = 2, timeoutMs = 10_000 } = {}) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        execFile(process.execPath, [
            'scripts/benchmark-runtime.js',
            `--url=${baseUrl}`,
            '--scenario=webrtc',
            '--label=fixture',
            `--clients=${clients}`,
            '--duration-ms=1500',
            '--sample-ms=100',
            '--ack-interval-ms=50',
        ], { cwd: projectRoot, timeout: timeoutMs }, (err, stdout, stderr) => {
            resolve({
                exitCode: err ? err.code : 0,
                killed: Boolean(err?.killed),
                stdout,
                stderr,
                elapsedMs: Date.now() - startedAt,
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

test('benchmark closes its sockets and exits 1 when the warm-up metrics request fails', async () => {
    const fixture = await startBenchmarkFixture(undefined, { metricsStatus: () => 500 });
    try {
        const result = await runFailingBenchmarkHarness(fixture.baseUrl);
        assert.equal(result.killed, false, 'the harness should exit by itself');
        assert.equal(result.exitCode, 1);
        assert.match(result.stderr, /Benchmark failed: \/api\/metrics returned 500/);
        assert.equal(await waitForNoLiveSockets(fixture), 0);
        assertClosedByTheClient(fixture, 2);
    } finally {
        await fixture.close();
    }
});

test('benchmark stops its acknowledgement loops, closes its sockets and exits 1 when sampling fails mid-run', async () => {
    // Request 1 is the warm-up; the third request (the second sample) fails while
    // the acknowledgement loops are running.
    const fixture = await startBenchmarkFixture(undefined, {
        metricsStatus: (requestNumber) => (requestNumber >= 3 ? 500 : 200),
    });
    try {
        const result = await runFailingBenchmarkHarness(fixture.baseUrl);
        assert.equal(result.killed, false, 'the harness should exit by itself');
        assert.equal(result.exitCode, 1);
        assert.match(result.stderr, /Benchmark failed: \/api\/metrics returned 500/);
        assert.ok(fixture.connections.acks > 0, 'the acknowledgement loops should have been running');
        assert.equal(await waitForNoLiveSockets(fixture), 0);
        assertClosedByTheClient(fixture, 2);
    } finally {
        await fixture.close();
    }
});

test('benchmark closes the sockets that did connect and exits 1 when one connection is refused', async () => {
    const fixture = await startBenchmarkFixture(undefined, {
        acceptConnection: (attemptNumber) => attemptNumber !== 2,
    });
    try {
        const result = await runFailingBenchmarkHarness(fixture.baseUrl, { clients: 3 });
        assert.equal(result.killed, false, 'the harness should exit by itself');
        assert.equal(result.exitCode, 1);
        assert.match(result.stderr, /Benchmark failed: connection limit/);
        assert.equal(await waitForNoLiveSockets(fixture), 0);
        assertClosedByTheClient(fixture, 2);
    } finally {
        await fixture.close();
    }
});
