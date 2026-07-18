const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
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

async function waitForReady(baseUrl, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${baseUrl}/readyz`);
            if (response.ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('server did not become ready');
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
    const server = spawn(process.execPath, ['server.js'], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: 'ignore',
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
            LOG_LEVEL: 'warn',
        },
    });
    t.after(async () => {
        try { await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' }); } catch {}
        if (server.exitCode === null) server.kill();
    });

    await waitForReady(baseUrl);
    const result = await runHarness(baseUrl);
    assert.equal(result.pass, true, JSON.stringify(result.failures));
    assert.equal(result.churnErrors, 0);
    assert.ok(result.cycles > 0);
    assert.equal(result.settled.roomsActive, 0);
    assert.equal(result.observed.socketGrowth, 0);
});
