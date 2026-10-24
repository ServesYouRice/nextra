const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { claimServerPorts } = require('./serverPorts');

const projectRoot = path.resolve(__dirname, '..');

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
    const { port, rtcPort } = await claimServerPorts();
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
async function startChurnFixture(metricsFor) {
    let requestNumber = 0;
    const server = http.createServer((req, res) => {
        if (req.url.split('?')[0] !== '/api/metrics') {
            res.writeHead(404);
            res.end();
            return;
        }
        requestNumber += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(metricsFor(requestNumber)));
    });
    const io = new SocketServer(server);
    io.on('connection', (socket) => {
        for (const event of ['create-room', 'create-send-transport', 'join-room', 'create-recv-transport', 'leave-room']) {
            socket.on(event, (_payload, ack) => ack({ success: true, code: 'ROOM' }));
        }
    });
    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        async close() {
            await io.close();
            if (server.listening) await new Promise((resolve) => server.close(resolve));
        },
    };
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
