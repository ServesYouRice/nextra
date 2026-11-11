const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io: createSocketClient } = require('socket.io-client');
const { claimServerPorts } = require('./serverPorts');
const { hasRemoteForwardingEvidence, isLocalOperatorHost } = require('../lib/requestIdentity');

const projectRoot = path.resolve(__dirname, '..');
const OPERATOR_TOKEN = 'operator-host-boundary-token-0123456789abcdef';

test('isLocalOperatorHost accepts only names that address this machine', () => {
    for (const host of [undefined, '', '127.0.0.1:3000', '[::1]:3000', '192.168.1.20:3000', 'localhost', 'LOCALHOST:3000',
        'app.localhost:3000', 'localhost.:3000']) {
        assert.equal(isLocalOperatorHost(host), true, `expected ${host} to be local`);
    }
    for (const host of ['attacker.example:3000', 'share.example.com', '127.0.0.1.attacker.example', 'localhost.attacker.example',
        'bad host', 'a/b']) {
        assert.equal(isLocalOperatorHost(host), false, `expected ${host} to be refused`);
    }
    assert.equal(isLocalOperatorHost('Studio-PC:3000', ['studio-pc']), true);
    assert.equal(isLocalOperatorHost('studio-pc.attacker.example', ['studio-pc']), false);
});

test('hasRemoteForwardingEvidence tells a proxied remote client from a browser on this machine', () => {
    assert.equal(hasRemoteForwardingEvidence({}), false);
    assert.equal(hasRemoteForwardingEvidence({ 'x-forwarded-for': '127.0.0.1' }), false);
    assert.equal(hasRemoteForwardingEvidence({ 'x-forwarded-for': '::1, 127.0.0.1' }), false);
    assert.equal(hasRemoteForwardingEvidence({ 'x-forwarded-for': '203.0.113.9' }), true);
    assert.equal(hasRemoteForwardingEvidence({ 'x-forwarded-for': '127.0.0.1, 203.0.113.9' }), true);
    assert.equal(hasRemoteForwardingEvidence({ 'x-forwarded-for': 'not-an-address' }), true);
    assert.equal(hasRemoteForwardingEvidence({ 'x-real-ip': '203.0.113.9' }), true);
    assert.equal(hasRemoteForwardingEvidence({ via: '1.1 proxy' }), true);
    assert.equal(hasRemoteForwardingEvidence({ forwarded: 'for=203.0.113.9' }), true);
});

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

/** A GET from this machine with exactly these headers; fetch() cannot set Host. */
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

test('a loopback request is the operator only when it is addressed to this machine and no proxy vouches for a remote client', { concurrency: false, timeout: 40_000 }, async (t) => {
    const { port, rtcPort } = await claimServerPorts();
    const baseUrl = `http://127.0.0.1:${port}`;
    const testDistDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nextra-operator-host-dist-'));
    await fs.writeFile(path.join(testDistDir, 'index.html'), '<!doctype html><div id="root"></div>');
    let output = '';
    const sockets = [];
    // No share URL is configured: a same-host reverse proxy or a rebound DNS name is all the server can see.
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
            OPERATOR_HOSTNAMES: 'studio-pc',
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
        sockets.forEach((socket) => socket.close());
        if (child.exitCode === null) child.kill();
        await fs.rm(testDistDir, { recursive: true, force: true });
    });
    await waitForReady(baseUrl, child, () => output);
    const metrics = (headers) => getFromLoopback(port, '/api/metrics', headers);
    const local = { host: `127.0.0.1:${port}` };

    // The host's own browser, under every name this machine answers to.
    assert.equal(await metrics(local), 200);
    assert.equal(await metrics({ host: `localhost:${port}` }), 200);
    assert.equal(await metrics({ host: `studio-pc:${port}` }), 200, 'an OPERATOR_HOSTNAMES name was refused');
    // The Vite dev proxy forwards the address of the page it serves, which is this machine.
    assert.equal(await metrics({ ...local, 'x-forwarded-for': '127.0.0.1' }), 200, 'a loopback X-Forwarded-For was refused');

    // DNS rebinding: a page on another site whose name now resolves here sends its own name as Host.
    assert.equal(await metrics({ host: `attacker.example:${port}` }), 403, 'a rebound Host got operator metrics');
    // A same-host reverse proxy that forwards the public Host, without SHARE_BASE_URL naming it.
    assert.equal(await metrics({ host: 'stream.example.com' }), 403, 'a forwarded public Host got operator metrics');
    assert.equal(await metrics({ ...local, 'x-forwarded-host': 'stream.example.com' }), 403, 'a forwarded public X-Forwarded-Host got operator metrics');
    // A same-host reverse proxy that rewrites Host but appends the client it relays for.
    assert.equal(await metrics({ ...local, 'x-forwarded-for': '203.0.113.9' }), 403, 'a proxied remote client got operator metrics');
    assert.equal(await metrics({ ...local, 'x-forwarded-for': '127.0.0.1, 203.0.113.9' }), 403, 'a spoofed loopback entry got operator metrics');
    assert.equal(await metrics({ ...local, 'x-real-ip': '203.0.113.9' }), 403, 'X-Real-IP of a remote client got operator metrics');
    assert.equal(await metrics({ ...local, via: '1.1 proxy' }), 403, 'a request with Via got operator metrics');
    // The operator token still works through such a proxy.
    assert.equal(await metrics({ host: 'stream.example.com', 'x-nextra-operator-token': OPERATOR_TOKEN }), 200);

    // The same over Socket.IO: a proxied socket cannot create rooms without the token.
    const proxied = await connectSocket(baseUrl, { Origin: baseUrl, 'x-forwarded-for': '203.0.113.9' });
    sockets.push(proxied);
    const denied = await socketRequest(proxied, 'create-room', { ingestMode: 'browser' });
    assert.equal(denied.success, false, 'a proxied socket created a room without the operator token');
    assert.match(denied.error, /Operator authorization/);

    const own = await connectSocket(baseUrl, { Origin: baseUrl });
    sockets.push(own);
    const created = await socketRequest(own, 'create-room', { ingestMode: 'browser' });
    assert.equal(created.success, true, `the host's own socket could not create a room: ${created.error}`);
});
