const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io: createSocketClient } = require('socket.io-client');
const { claimServerPorts } = require('./serverPorts');

const projectRoot = path.resolve(__dirname, '..');
const SHARE_BASE_URL = 'https://nextra-proof.trycloudflare.com';
const OPERATOR_TOKEN = 'public-link-operator-token-0123456789abcdef';
// What cloudflared adds to every request it relays from the public link to the local listener.
const TUNNEL_HEADERS = {
    host: 'nextra-proof.trycloudflare.com',
    'cf-connecting-ip': '203.0.113.9',
    'cf-ray': '8f00000000000000-AMS',
    'cdn-loop': 'cloudflare',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '203.0.113.9',
};

async function waitForReady(baseUrl, child, getOutput, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited before readiness (code ${child.exitCode})\n${getOutput()}`);
        try {
            const response = await fetch(`${baseUrl}/readyz`);
            if (response.ok) return;
        } catch {
            // The listener may not exist yet while mediasoup initializes.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`server did not become ready within ${timeoutMs}ms\n${getOutput()}`);
}

/** A GET from this machine with exactly these headers; fetch() cannot set Host, which is what the tunnel forwards. */
function getFromLoopback(port, pathname, headers) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });
        request.once('error', reject);
        request.end();
    });
}

function connectSocket(baseUrl, extraHeaders) {
    return new Promise((resolve, reject) => {
        const socket = createSocketClient(baseUrl, { transports: ['websocket'], extraHeaders, reconnection: false, timeout: 5_000 });
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', (err) => {
            socket.close();
            reject(err);
        });
    });
}

function socketRequest(socket, event, payload = {}) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), 5_000);
        socket.emit(event, payload, (response) => {
            clearTimeout(timeout);
            resolve(response);
        });
    });
}

test('requests relayed through the public link never get the local operator\'s rights', { concurrency: false, timeout: 40_000 }, async (t) => {
    const { port, rtcPort } = await claimServerPorts();
    const baseUrl = `http://127.0.0.1:${port}`;
    const testDistDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nextra-public-link-dist-'));
    await fs.writeFile(path.join(testDistDir, 'index.html'), '<!doctype html><div id="root"></div>');
    let output = '';
    let socket = null;
    // The packaged app's public link: plain HTTP on loopback, a known share URL, forwarded headers not trusted.
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
            SHARE_BASE_URL,
            WHIP_ENABLED: 'false',
            WHEP_ENABLED: 'false',
            OPERATOR_TOKEN,
            TRUSTED_LAN_CIDRS: '',
            TRUST_X_FORWARDED_HEADERS: 'false',
            NEXTRA_SMOKE_TEST: '1',
            NEXTRA_TEST_DIST_DIR: testDistDir,
            LOG_LEVEL: 'warn',
        },
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    t.after(async () => {
        socket?.close();
        if (child.exitCode === null) child.kill();
        await fs.rm(testDistDir, { recursive: true, force: true });
    });
    await waitForReady(baseUrl, child, () => output);

    // The host's own browser on this machine stays the operator without a token.
    assert.equal(await getFromLoopback(port, '/api/metrics', { host: `127.0.0.1:${port}` }), 200);

    // A viewer's script through the tunnel, sending no Origin or Referer.
    assert.equal(await getFromLoopback(port, '/api/metrics', TUNNEL_HEADERS), 403, 'tunnel request without Origin got operator metrics');
    // The share host alone, whatever the scheme the local listener sees.
    assert.equal(await getFromLoopback(port, '/api/metrics', { host: TUNNEL_HEADERS.host }), 403, 'share Host without Origin got operator metrics');
    // Cloudflare's headers with an Origin and Host that claim to be local.
    assert.equal(await getFromLoopback(port, '/api/metrics', {
        host: `127.0.0.1:${port}`,
        origin: baseUrl,
        'cf-connecting-ip': '203.0.113.9',
        'cf-ray': '8f00000000000000-AMS',
    }), 403, 'Cloudflare-relayed request with a local Origin got operator metrics');
    // The operator token still works through the tunnel.
    assert.equal(await getFromLoopback(port, '/api/metrics', { ...TUNNEL_HEADERS, 'x-nextra-operator-token': OPERATOR_TOKEN }), 200);

    // The same over Socket.IO: a relayed socket cannot create rooms without the token.
    socket = await connectSocket(baseUrl, { Origin: baseUrl, 'cf-connecting-ip': '203.0.113.9', 'cf-ray': '8f00000000000000-AMS' });
    const denied = await socketRequest(socket, 'create-room', { ingestMode: 'browser' });
    assert.equal(denied.success, false, 'relayed socket created a room without the operator token');
    assert.match(denied.error, /Operator authorization/);
    const created = await socketRequest(socket, 'create-room', { ingestMode: 'browser', operatorToken: OPERATOR_TOKEN });
    assert.equal(created.success, true);
});
