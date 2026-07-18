const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

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

async function waitForJson(url, predicate, timeoutMs = 25_000) {
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
    throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'condition not met'}`);
}

test('a killed real mediasoup subprocess is replaced with a ready process', {
    concurrency: false,
    timeout: 45_000,
}, async (t) => {
    const port = await reserveTcpPort();
    let rtcPort = await reserveTcpPort();
    while (rtcPort === port) rtcPort = await reserveTcpPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let output = '';
    let replacementStarted = false;

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
            WORKER_RECOVERY_MIN_UPTIME_SECONDS: '0',
            LOG_LEVEL: 'warn',
        },
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });

    t.after(async () => {
        try { await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' }); } catch {}
        if (!replacementStarted && child.exitCode === null) child.kill();
    });

    await waitForJson(`${baseUrl}/readyz`, (body) => body.status === 'ready');
    const before = await (await fetch(`${baseUrl}/api/metrics`)).json();
    assert.ok(Number.isInteger(before.process.pid));
    assert.ok(Number.isInteger(before.mediaWorker.pid));

    const killed = await fetch(`${baseUrl}/api/test/kill-media-worker`, { method: 'POST' });
    assert.equal(killed.status, 202);
    assert.equal((await killed.json()).workerPid, before.mediaWorker.pid);

    const after = await waitForJson(`${baseUrl}/api/metrics`, (body) => (
        body.process?.pid !== before.process.pid
        && body.mediaWorker?.pid !== before.mediaWorker.pid
    ));
    replacementStarted = true;
    assert.notEqual(after.process.pid, before.process.pid);
    assert.notEqual(after.mediaWorker.pid, before.mediaWorker.pid);
    await waitForJson(`${baseUrl}/readyz`, (body) => body.status === 'ready');

    const shutdown = await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' });
    assert.equal(shutdown.status, 202, output);
});
