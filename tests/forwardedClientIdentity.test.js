// Who a relayed request comes from, as the per-IP rate limits see it.
//
// The owner's answer 4 (Q-001): X-Forwarded-For is read from the right, skipping the TRUST_PROXY hop count, and
// CF-Connecting-IP names the client only in Nextra's own Cloudflare tunnel mode (Nextra launched cloudflared) or
// with TRUST_CLOUDFLARE_CONNECTING_IP=true. A per-IP limit that takes a client-chosen header as the key gives each
// attempt a fresh bucket, so the join limit (JOIN_RATE_LIMIT_MAX=1 here) shows which identity the server used.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Server } = require('socket.io');
const { io: createSocketClient } = require('socket.io-client');

const config = require('../config');
const { registerSocketHandlers, stopJoinCleanup } = require('../lib/socket');
const { createWhepRouter } = require('../lib/whepRoutes');
const { claimServerPorts } = require('./serverPorts');

const projectRoot = path.resolve(__dirname, '..');
const RATE_LIMITED = /Too many attempts/;
const PROXY_SHARE = 'https://stream.example.com';
const FAKE_TUNNEL = 'https://nextra-fake-tunnel.trycloudflare.com';

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

/** One join attempt on a fresh connection with these headers; the room does not exist, so only the limit differs. */
async function joinFrom(baseUrl, headers) {
    const socket = await connectSocket(baseUrl, headers);
    try {
        return await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('join-room acknowledgement timed out')), 5_000);
            socket.emit('join-room', { code: 'ABCDEF' }, (response) => {
                clearTimeout(timeout);
                resolve(response);
            });
        });
    } finally {
        socket.close();
    }
}

function assertAdmitted(response, label) {
    assert.equal(response.success, false, label);
    assert.doesNotMatch(response.error, RATE_LIMITED, `${label} was rate-limited: it shared another client's bucket`);
}

function assertRateLimited(response, label) {
    assert.equal(response.success, false, label);
    assert.match(response.error, RATE_LIMITED, `${label} was not rate-limited: it got a bucket of its own`);
}

/** Sets config values for one test and puts the old ones back afterwards. */
function overrideConfig(t, values) {
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, config[key]]));
    Object.assign(config, values);
    t.after(() => Object.assign(config, previous));
}

test('the socket handlers\' own IP fallback skips the TRUST_PROXY hop count and honours only the explicit Cloudflare flag', { concurrency: false }, async (t) => {
    overrideConfig(t, {
        TRUST_X_FORWARDED_HEADERS: true,
        TRUST_PROXY: 2,
        TRUST_CLOUDFLARE_CONNECTING_IP: false,
        JOIN_RATE_LIMIT_MAX: 1,
    });
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    // No getClientIp option: the handlers resolve the client themselves (getSocketIp in lib/socket.js).
    registerSocketHandlers(ioServer, {}, {});
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        stopJoinCleanup();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    });
    const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

    // Two proxies in front: the client is the second entry from the right, the first is the outer proxy.
    assertAdmitted(await joinFrom(baseUrl, { 'x-forwarded-for': '198.51.100.31, 10.0.0.2' }), 'first client behind two proxies');
    assertAdmitted(await joinFrom(baseUrl, { 'x-forwarded-for': '198.51.100.32, 10.0.0.2' }), 'second client behind the same proxies');
    assertRateLimited(await joinFrom(baseUrl, { 'x-forwarded-for': '203.0.113.99, 198.51.100.31, 10.0.0.3' }), 'first client again, with a spoofed leftmost entry');

    // CF-Connecting-IP is ignored with the flag off and is the client with it on.
    assertRateLimited(
        await joinFrom(baseUrl, { 'x-forwarded-for': '198.51.100.31, 10.0.0.2', 'cf-connecting-ip': '198.51.100.33' }),
        'CF-Connecting-IP with the flag off'
    );
    config.TRUST_CLOUDFLARE_CONNECTING_IP = true;
    assertAdmitted(
        await joinFrom(baseUrl, { 'x-forwarded-for': '198.51.100.31, 10.0.0.2', 'cf-connecting-ip': '198.51.100.34' }),
        'CF-Connecting-IP with the flag on'
    );
});

test('the WHEP router\'s own IP fallback skips the TRUST_PROXY hop count and honours only the explicit Cloudflare flag', { concurrency: false }, async (t) => {
    overrideConfig(t, {
        WHEP_ENABLED: true,
        WHEP_RATE_LIMIT_MAX: 1,
        TRUST_X_FORWARDED_HEADERS: true,
        TRUST_PROXY: 2,
        TRUST_CLOUDFLARE_CONNECTING_IP: false,
    });
    const mediasoupRouter = { rtpCapabilities: { codecs: [], headerExtensions: [] }, canConsume: () => true };
    const app = express();
    // No getClientIp option: the router resolves the client itself (getRequestIp in lib/whepRoutes.js).
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        createWebRtcTransport: async () => { throw new Error('no room exists, so no transport is created'); },
    }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const post = (headers) => fetch(`${baseUrl}/whep/watch/NOROOM`, {
        method: 'POST',
        headers: { 'content-type': 'application/sdp', ...headers },
        body: 'v=0\r\n',
    }).then((response) => response.status);

    // 404 is the missing room, past the limit; 429 is the per-IP limit.
    assert.equal(await post({ 'x-forwarded-for': '198.51.100.41, 10.0.0.2' }), 404);
    assert.equal(await post({ 'x-forwarded-for': '198.51.100.42, 10.0.0.2' }), 404, 'a second client behind the same proxies shared the first one\'s bucket');
    assert.equal(await post({ 'x-forwarded-for': '203.0.113.98, 198.51.100.41, 10.0.0.3' }), 429, 'a spoofed leftmost entry gave the first client a fresh bucket');
    assert.equal(await post({ 'x-forwarded-for': '198.51.100.41, 10.0.0.2', 'cf-connecting-ip': '198.51.100.43' }), 429, 'CF-Connecting-IP chose the client with the flag off');
    config.TRUST_CLOUDFLARE_CONNECTING_IP = true;
    assert.equal(await post({ 'x-forwarded-for': '198.51.100.41, 10.0.0.2', 'cf-connecting-ip': '198.51.100.44' }), 404, 'CF-Connecting-IP was ignored with the flag on');
});

async function waitForConfig(baseUrl, child, getOutput, isReady, timeoutMs = 25_000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})\n${getOutput()}`);
        try {
            const response = await fetch(`${baseUrl}/api/config`);
            if (response.ok) {
                last = await response.json();
                if (isReady(last)) return last;
            }
        } catch {
            // The listener may not exist yet while mediasoup initializes.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`server not ready within ${timeoutMs}ms (last /api/config: ${JSON.stringify(last)})\n${getOutput()}`);
}

/** A GET from this machine with exactly these headers; fetch() cannot set Host, which a proxy forwards. */
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

/**
 * A real server.js on loopback with plain HTTP and forwarded headers not configured, started from its own working
 * directory (no .env is read there). `tunnel: true` gives it a quick tunnel whose cloudflared is a stand-in.
 */
async function startServer(t, { env = {}, tunnel = false } = {}) {
    const { port, rtcPort } = await claimServerPorts();
    const baseUrl = `http://127.0.0.1:${port}`;
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nextra-client-identity-'));
    const distDir = path.join(workDir, 'dist');
    await fs.mkdir(distDir);
    await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><div id="root"></div>');
    if (tunnel) {
        // `cloudflared tunnel --url ...` becomes `node tunnel --url ...`, which runs this file from the working
        // directory: it prints a quick-tunnel URL as cloudflared does and runs until it is stopped or Nextra is gone.
        await fs.writeFile(path.join(workDir, 'tunnel'), [
            `process.stderr.write('INF |  ${FAKE_TUNNEL}  |\\n');`,
            'const parent = process.ppid;',
            'setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 250);',
            '',
        ].join('\n'));
    }
    let output = '';
    const child = spawn(process.execPath, [path.join(projectRoot, 'server.js')], {
        cwd: workDir,
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
            AUTO_PUBLIC_TUNNEL: tunnel ? 'true' : 'false',
            CLOUDFLARED_PATH: tunnel ? process.execPath : '',
            ALLOW_SYSTEM_CLOUDFLARED: '',
            CLOUDFLARED_TUNNEL_TOKEN: '',
            RELAY_PUBLIC_LINK_KBPS: '1000',
            SHARE_BASE_URL: '',
            WHIP_ENABLED: 'false',
            WHEP_ENABLED: 'false',
            OPERATOR_TOKEN: '',
            TRUSTED_LAN_CIDRS: '',
            TRUST_PROXY: '',
            TRUST_X_FORWARDED_HEADERS: 'false',
            TRUST_CLOUDFLARE_CONNECTING_IP: '',
            JOIN_RATE_LIMIT_MAX: '1',
            NEXTRA_SMOKE_TEST: '1',
            NEXTRA_TEST_DIST_DIR: distDir,
            NEXTRA_LOG_DIR: path.join(workDir, 'logs'),
            LOG_LEVEL: 'warn',
            ...env,
        },
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    t.after(async () => {
        if (child.exitCode === null) {
            // The graceful path stops the tunnel's process too; kill() is the fallback.
            await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' }).catch(() => {});
            await new Promise((resolve) => {
                const timer = setTimeout(() => { child.kill(); resolve(); }, 8_000);
                child.once('exit', () => { clearTimeout(timer); resolve(); });
            });
        }
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    });
    const getOutput = () => output;
    await waitForConfig(baseUrl, child, getOutput, (cfg) => !tunnel || cfg.publicShareStatus === 'active');
    return { port, baseUrl, getOutput };
}

test('VAL-132 on the real server: behind a SHARE_BASE_URL proxy a client-supplied CF-Connecting-IP never names the client', { concurrency: false, timeout: 60_000 }, async (t) => {
    const { port, baseUrl } = await startServer(t, { env: { SHARE_BASE_URL: PROXY_SHARE } });

    // The host's own browser on this machine is still local.
    assert.equal(await getFromLoopback(port, '/api/package-info', { host: `127.0.0.1:${port}` }), 200);
    // Through the proxy, a client claiming a local address with CF-Connecting-IP is not local.
    for (const claimed of ['127.0.0.1', '192.168.1.5']) {
        assert.equal(await getFromLoopback(port, '/api/package-info', {
            host: 'stream.example.com',
            'x-forwarded-for': '203.0.113.180',
            'cf-connecting-ip': claimed,
        }), 403, `CF-Connecting-IP ${claimed} through a non-Cloudflare proxy was taken as a local client`);
    }

    // The proxy-appended X-Forwarded-For entry is the rate-limit identity; a new CF-Connecting-IP is no new bucket.
    assertAdmitted(await joinFrom(baseUrl, { Origin: PROXY_SHARE, 'x-forwarded-for': '203.0.113.181', 'cf-connecting-ip': '198.51.100.181' }), 'first attempt');
    assertRateLimited(await joinFrom(baseUrl, { Origin: PROXY_SHARE, 'x-forwarded-for': '203.0.113.181', 'cf-connecting-ip': '198.51.100.182' }), 'same client, new CF-Connecting-IP');
    assertAdmitted(await joinFrom(baseUrl, { Origin: PROXY_SHARE, 'x-forwarded-for': '198.51.100.181, 203.0.113.183' }), 'another client');
});

test('VAL-146 on the real server: TRUST_CLOUDFLARE_CONNECTING_IP=true gives each Cloudflare viewer its own identity', { concurrency: false, timeout: 60_000 }, async (t) => {
    // An operator's own cloudflared in front of Nextra, declared with the flag; no SHARE_BASE_URL, so nothing else
    // marks these requests as Cloudflare's.
    const { port, baseUrl } = await startServer(t, { env: { TRUST_X_FORWARDED_HEADERS: 'true', TRUST_CLOUDFLARE_CONNECTING_IP: 'true' } });
    const origin = `http://127.0.0.1:${port}`;

    // Cloudflare's edge appends to X-Forwarded-For too; the same entry here shows that CF-Connecting-IP decides.
    assertAdmitted(await joinFrom(baseUrl, { Origin: origin, 'x-forwarded-for': '203.0.113.190', 'cf-connecting-ip': '198.51.100.191' }), 'first viewer');
    assertAdmitted(await joinFrom(baseUrl, { Origin: origin, 'x-forwarded-for': '203.0.113.190', 'cf-connecting-ip': '198.51.100.192' }), 'second viewer');
    assertRateLimited(await joinFrom(baseUrl, { Origin: origin, 'x-forwarded-for': '203.0.113.193', 'cf-connecting-ip': '198.51.100.191' }), 'first viewer again');
});

test('VAL-146 on the real server: Nextra\'s own quick tunnel reads CF-Connecting-IP, other loopback relays do not', { concurrency: false, timeout: 60_000 }, async (t) => {
    const { port, baseUrl } = await startServer(t, { tunnel: true });

    // Requests addressed to the tunnel Nextra started: each viewer keeps its own identity.
    assertAdmitted(await joinFrom(baseUrl, { Origin: FAKE_TUNNEL, 'x-forwarded-for': '203.0.113.200', 'cf-connecting-ip': '198.51.100.201' }), 'first tunnel viewer');
    assertAdmitted(await joinFrom(baseUrl, { Origin: FAKE_TUNNEL, 'x-forwarded-for': '203.0.113.200', 'cf-connecting-ip': '198.51.100.202' }), 'second tunnel viewer');
    assertRateLimited(await joinFrom(baseUrl, { Origin: FAKE_TUNNEL, 'x-forwarded-for': '203.0.113.203', 'cf-connecting-ip': '198.51.100.201' }), 'first tunnel viewer again');

    // A relay on this machine that is not the tunnel (another proxy) cannot pick a fresh identity per attempt.
    const local = `http://127.0.0.1:${port}`;
    assertAdmitted(await joinFrom(baseUrl, { Origin: local, 'cf-connecting-ip': '198.51.100.211', 'cf-ray': '8f00000000000000-AMS' }), 'first relayed attempt');
    assertRateLimited(await joinFrom(baseUrl, { Origin: local, 'cf-connecting-ip': '198.51.100.212', 'cf-ray': '8f00000000000000-AMS' }), 'relayed attempt with a new CF-Connecting-IP');
});
