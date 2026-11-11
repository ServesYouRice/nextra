const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { claimServerPorts } = require('./serverPorts');

const projectRoot = path.resolve(__dirname, '..');
const OPERATOR_TOKEN = 'turn-cache-operator-token-0123456789abcdef';
const TTL_SECONDS = 120;
// The mint rate limit (10 s per client) runs before the cache check, so the
// second request has to wait it out. The cache window is then 60 s (120 - 60).
const WAIT_BEFORE_SECOND_REQUEST_MS = 10_500;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
        } catch {
            // The listener may not exist yet while mediasoup initializes.
        }
        await sleep(100);
    }
    throw new Error(`server did not become ready within ${timeoutMs}ms\n${getOutput()}`);
}

function startFakeCloudflare() {
    const state = { requests: 0 };
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            state.requests += 1;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                iceServers: [{
                    urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
                    username: 'cached-user',
                    credential: 'cached-credential',
                }],
            }));
        });
    });
    return new Promise((resolve) => {
        upstream.listen(0, '127.0.0.1', () => {
            resolve({
                state,
                baseUrl: `http://127.0.0.1:${upstream.address().port}`,
                close: () => new Promise((done) => upstream.close(done)),
            });
        });
    });
}

test('cached TURN credentials advertise the remaining lifetime', { concurrency: false, timeout: 60_000 }, async (t) => {
    const upstream = await startFakeCloudflare();
    t.after(() => upstream.close());

    const { port, rtcPort } = await claimServerPorts();
    const baseUrl = `http://127.0.0.1:${port}`;
    const testDistDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nextra-turn-cache-dist-'));
    await fs.writeFile(
        path.join(testDistDir, 'index.html'),
        '<!doctype html><html><body><div id="root"></div></body></html>',
    );
    t.after(() => fs.rm(testDistDir, { recursive: true, force: true }));

    let output = '';
    const child = spawn(process.execPath, ['server.js'], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            NODE_ENV: 'test',
            APP_ENV: 'test',
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
            CLOUDFLARED_TUNNEL_TOKEN: '',
            SHARE_BASE_URL: '',
            WHIP_ENABLED: 'false',
            WHEP_ENABLED: 'false',
            OPERATOR_TOKEN,
            NEXTRA_SMOKE_TEST: '1',
            NEXTRA_TEST_DIST_DIR: testDistDir,
            CLOUDFLARE_TURN_KEY_ID: 'turn-cache-test-key',
            CLOUDFLARE_TURN_API_TOKEN: 'turn-cache-test-token',
            CLOUDFLARE_TURN_API_BASE_URL: upstream.baseUrl,
            CLOUDFLARE_TURN_TTL_SECONDS: String(TTL_SECONDS),
            LOG_LEVEL: 'warn',
        },
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });

    t.after(async () => {
        if (child.exitCode === null) {
            try {
                await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' });
            } catch {
                child.kill();
            }
        }
    });

    await waitForReady(baseUrl, child, () => output);

    const mint = async () => {
        const response = await fetch(`${baseUrl}/api/cloudflare-turn-credentials`, {
            method: 'POST',
            headers: { Origin: baseUrl, 'x-nextra-operator-token': OPERATOR_TOKEN },
        });
        return { response, body: await response.json() };
    };

    const first = await mint();
    assert.equal(first.response.status, 200);
    assert.equal(first.response.headers.get('cache-control'), 'no-store');
    assert.equal(first.body.ttlSeconds, TTL_SECONDS);
    assert.equal(upstream.state.requests, 1);

    await sleep(WAIT_BEFORE_SECOND_REQUEST_MS);

    const second = await mint();
    assert.equal(second.response.status, 200);
    assert.equal(second.response.headers.get('cache-control'), 'no-store');
    // Served from the cache: no second upstream mint.
    assert.equal(upstream.state.requests, 1);
    assert.deepEqual(second.body.turnConfig, first.body.turnConfig);
    assert.equal(second.body.provider, 'cloudflare');
    // About 10.5 s have passed since the mint, so the remaining lifetime is
    // below the original 120 s and at least 1 s.
    assert.ok(
        second.body.ttlSeconds < first.body.ttlSeconds,
        `cached ttlSeconds ${second.body.ttlSeconds} should be below the original ${first.body.ttlSeconds}`,
    );
    assert.ok(second.body.ttlSeconds <= TTL_SECONDS - 10, `cached ttlSeconds ${second.body.ttlSeconds} too high`);
    assert.ok(second.body.ttlSeconds >= 1, `cached ttlSeconds ${second.body.ttlSeconds} below 1`);
});
