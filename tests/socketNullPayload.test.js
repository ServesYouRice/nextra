const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const { registerSocketHandlers, stopJoinCleanup } = require('../lib/socket');

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

function connect(url, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const client = createClient(url, { transports: ['websocket'], extraHeaders, reconnection: false, timeout: 5_000 });
        client.once('connect', () => resolve(client));
        client.once('connect_error', (err) => {
            client.close();
            reject(err);
        });
    });
}

function request(client, event, payload) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), 3_000);
        client.emit(event, payload, (response) => {
            clearTimeout(timeout);
            resolve(response);
        });
    });
}

test('one viewer message with a null payload does not shut the server down', { concurrency: false, timeout: 40_000 }, async (t) => {
    const port = await reserveTcpPort();
    let rtcPort = await reserveTcpPort();
    while (rtcPort === port) rtcPort = await reserveTcpPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const testDistDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nextra-null-payload-dist-'));
    await fs.writeFile(path.join(testDistDir, 'index.html'), '<!doctype html><div id="root"></div>');
    let output = '';
    let client = null;
    const child = spawn(process.execPath, ['server.js'], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            NODE_ENV: 'test', APP_ENV: 'test', PORT: String(port), BIND_HOST: '127.0.0.1', LAN_IP: '127.0.0.1',
            RTC_LISTEN_IP: '127.0.0.1', RTC_MIN_PORT: String(rtcPort), RTC_MAX_PORT: String(rtcPort), LOCAL_HTTPS: 'false',
            OPEN_BROWSER: 'false', AUTO_DETECT_PUBLIC_IP: 'false', AUTO_PUBLIC_TUNNEL: 'false', CLOUDFLARED_TUNNEL_TOKEN: '',
            SHARE_BASE_URL: '', WHIP_ENABLED: 'false', WHEP_ENABLED: 'false', NEXTRA_SMOKE_TEST: '1',
            NEXTRA_TEST_DIST_DIR: testDistDir, LOG_LEVEL: 'warn',
        },
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    t.after(async () => {
        client?.close();
        if (child.exitCode === null) child.kill();
        await fs.rm(testDistDir, { recursive: true, force: true });
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`server exited before readiness\n${output}`);
        try { if ((await fetch(`${baseUrl}/readyz`)).ok) break; } catch { /* not listening yet */ }
        if (Date.now() > deadline) throw new Error(`server did not become ready\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    client = await connect(baseUrl, { Origin: baseUrl });
    const reply = await Promise.race([
        request(client, 'reclaim-host', null),
        new Promise((resolve) => child.once('exit', (code) => resolve({ exited: code }))),
    ]);
    assert.deepEqual(reply.exited, undefined, `the server exited on a null reclaim-host payload\n${output}`);
    assert.equal(reply.success, false);
    assert.equal(reply.error, 'Invalid reclaim parameters.');
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
});

test('every handler answers a non-object payload with its usual invalid-parameter reply', { concurrency: false, timeout: 30_000 }, async (t) => {
    const failures = [];
    const onFailure = (error) => failures.push(error);
    process.on('uncaughtException', onFailure);
    process.on('unhandledRejection', onFailure);
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer, {}, { authorizeCreateRoom: () => true });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const client = await connect(`http://127.0.0.1:${httpServer.address().port}`);
    t.after(async () => {
        process.off('uncaughtException', onFailure);
        process.off('unhandledRejection', onFailure);
        client.close();
        stopJoinCleanup();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    });

    const expected = {
        'reclaim-host': 'Invalid reclaim parameters.',
        'join-room': 'Invalid room code format.',
        'connect-transport': 'Invalid parameters.',
        produce: 'Invalid media kind.',
        consume: 'Invalid parameters.',
        'consumer-resume': 'Invalid consumer ID.',
        'close-viewer-transport': 'Invalid transport ID.',
    };
    for (const [event, error] of Object.entries(expected)) {
        for (const payload of [null, 7, 'text', [], undefined]) {
            const reply = await request(client, event, payload);
            assert.equal(reply?.success, false, `${event} with ${JSON.stringify(payload)}`);
            assert.equal(reply.error, error, `${event} with ${JSON.stringify(payload)}`);
        }
    }
    assert.deepEqual(failures, []);
});
