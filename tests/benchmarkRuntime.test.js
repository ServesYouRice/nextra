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
async function startBenchmarkFixture(degrade = (metrics) => metrics) {
    const startedAt = Date.now();
    let requestNumber = 0;
    const server = http.createServer((req, res) => {
        if (req.url.split('?')[0] !== '/api/metrics') {
            res.writeHead(404);
            res.end();
            return;
        }
        requestNumber += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(degrade(completeBenchmarkMetrics(startedAt), requestNumber)));
    });
    const io = new SocketServer(server);
    io.on('connection', (socket) => {
        socket.on('get-rtp-capabilities', (_payload, ack) => ack({ success: true, rtpCapabilities: {} }));
    });
    const port = await listen(server);
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        async close() {
            await io.close();
            if (server.listening) await closeServer(server).catch(() => {});
        },
    };
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
