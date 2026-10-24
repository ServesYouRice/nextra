// A setup that fails after the encoder settings file was written puts the file back
// as it was: the host page's rollback (src/lib/obsWebSocket.js), the socket handler
// (lib/socket.js) and the profile folder (lib/obsProfile.js) together, with a fake OBS
// on the page's side and a temporary OBS configuration folder on the server's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const { findRoomBySocket, destroyRoom } = require('../lib/rooms');
const { registerSocketHandlers, stopJoinCleanup } = require('../lib/socket');
const { restoreStreamEncoderSettings, writeStreamEncoderSettings } = require('../lib/obsProfile');
const { claimServerPorts } = require('./serverPorts');

const projectRoot = path.resolve(__dirname, '..');
const obsWebSocketModule = import('../src/lib/obsWebSocket.js');
const mediasoupClientModule = import('../src/lib/mediasoupClient.js');

// OBS's configuration folder with one profile, "Streaming". Returns the folders the
// server looks in (as APPDATA on Windows, XDG_CONFIG_HOME elsewhere) and the profile.
function fakeObsConfig(t) {
    const configHome = fsSync.mkdtempSync(path.join(os.tmpdir(), 'nextra-obs-restore-'));
    t.after(() => fsSync.rmSync(configHome, { recursive: true, force: true }));
    const dir = path.join(configHome, 'obs-studio', 'basic', 'profiles', 'Streaming');
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(path.join(dir, 'basic.ini'), '﻿[General]\r\nName=Streaming\r\n\r\n[Output]\r\nMode=Advanced\r\n');
    return { configHome, dir, file: path.join(dir, 'streamEncoder.json'), options: { env: { APPDATA: configHome }, platform: 'win32' } };
}

// OBS as the host page sees it over obs-websocket: a profile, a video setup and a
// stream that starts when asked (or is refused).
function fakeObsWebSocket(onRequest) {
    return class FakeObsWebSocket {
        constructor(url) {
            this.url = url;
            this.closed = false;
            queueMicrotask(() => {
                this.onopen?.();
                this.onmessage?.({ data: JSON.stringify({ op: 0, d: { rpcVersion: 1 } }) });
            });
        }

        send(payload) {
            const message = JSON.parse(payload);
            if (message.op === 1) {
                queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }) }));
                return;
            }
            if (message.op === 6) onRequest(this, message.d);
        }

        close() {
            if (this.closed) return;
            this.closed = true;
            this.onclose?.({ code: 1000 });
        }

        respond(request, responseData = {}, requestStatus = { result: true }) {
            this.onmessage?.({
                data: JSON.stringify({
                    op: 7,
                    d: { requestId: request.requestId, requestType: request.requestType, requestStatus, responseData },
                }),
            });
        }
    };
}

function fakeObs({ refuseStart = null, stallColorSpace = false, encoderId = 'obs_nvenc_h264_tex' } = {}) {
    const status = { outputActive: false, outputReconnecting: false };
    const profile = new Map([['Output/Mode', 'Advanced'], ['AdvOut/Encoder', encoderId]]);
    let stalled = false;
    const WebSocketImpl = fakeObsWebSocket((ws, request) => {
        const { requestType, requestData = {} } = request;
        const key = `${requestData.parameterCategory}/${requestData.parameterName}`;
        const reply = (data, requestStatus) => queueMicrotask(() => ws.respond(request, data, requestStatus));
        if (stallColorSpace && !stalled && requestType === 'SetProfileParameter' && requestData.parameterName === 'ColorSpace') {
            stalled = true;
            return undefined;
        }
        switch (requestType) {
        case 'GetProfileParameter':
            return reply({ parameterValue: profile.get(key) ?? '' });
        case 'SetProfileParameter':
            profile.set(key, requestData.parameterValue);
            return reply();
        case 'GetProfileList':
            return reply({ currentProfileName: 'Streaming', profiles: ['Streaming'] });
        case 'GetOutputList':
            return reply({ outputs: [] });
        case 'GetOutputSettings':
            return reply({}, { result: false, comment: 'not found' });
        case 'GetStreamStatus':
            return reply({ ...status });
        case 'StartStream':
            if (refuseStart) return reply({}, { result: false, comment: refuseStart });
            status.outputActive = true;
            return reply();
        case 'StopStream':
            status.outputActive = false;
            return reply();
        case 'GetStreamServiceSettings':
            return reply({ streamServiceType: 'rtmp_custom', streamServiceSettings: { server: 'rtmp://previous.example/live' } });
        case 'GetVideoSettings':
            return reply({ outputWidth: 2560, outputHeight: 1440 });
        default:
            return reply();
        }
    });
    return { WebSocketImpl };
}

async function configure(obs, writeEncoderSettings, overrides = {}) {
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = obs.WebSocketImpl;
    const { configureObsStream } = await obsWebSocketModule;
    try {
        return await configureObsStream({
            whipUrl: 'http://127.0.0.1:3001/whip/broadcast/ABC123',
            bearerToken: 'token',
            encoderSettings: { videoCodec: 'av1', obsEncoderIds: ['obs_nvenc_av1_tex'], bitrateKbps: 18_000, keyframeIntervalSec: 1 },
            writeEncoderSettings,
            transactionOptions: { stopPollIntervalMs: 1, stopPollAttempts: 3 },
            encoderResetOptions: { stopPollIntervalMs: 1, stopPollAttempts: 3 },
            connectionOptions: {
                WebSocketImpl: obs.WebSocketImpl,
                connectTimeoutMs: 100,
                requestTimeoutMs: 50,
                transactionTimeoutMs: 5000,
            },
            ...overrides,
        });
    } finally {
        globalThis.WebSocket = previousWebSocket;
    }
}

function request(client, event, data = {}) {
    return new Promise((resolve) => client.emit(event, data, resolve));
}

// The Nextra server in this process, wired as server.js wires it: the handlers call
// lib/obsProfile.js on the temporary OBS folder. `log` lists what reached it.
async function withSocketServer(t, obsOptions) {
    const log = [];
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer, {}, {
        applyObsEncoderSettings: (_socket, payload) => {
            log.push('write');
            return writeStreamEncoderSettings(payload, obsOptions);
        },
        restoreObsEncoderSettings: (_socket, payload) => {
            log.push('restore');
            return restoreStreamEncoderSettings(payload, obsOptions);
        },
    });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const client = createClient(`http://127.0.0.1:${httpServer.address().port}`, { transports: ['websocket'] });
    await new Promise((resolve) => client.once('connect', resolve));
    const created = await request(client, 'create-room', { ingestMode: 'obs' });
    assert.equal(created.success, true);
    const room = findRoomBySocket(client.id);
    t.after(async () => {
        client.close();
        destroyRoom(room.code);
        stopJoinCleanup();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    });
    return { client, room, log };
}

// What the host page does in HostView: a request over the page's socket.
async function pageWriter(client) {
    const { socketRequest } = await mediasoupClientModule;
    return (payload) => socketRequest(client, 'obs-encoder-settings', payload, { timeoutMs: 5000, maxAttempts: 1 });
}

// OBS's own layout, with keys the setup never sets.
const encoderFileBefore = '{\r\n  "rate_control": "VBR",\r\n  "device": 1,\r\n  "lookahead": true,\r\n  "custom": { "a": [1, 2] }\r\n}\r\n';

const failedSetups = [
    {
        name: 'a refused auto-start',
        // OBS already holds the AV1 encoder, so no restart is needed and the auto-start is attempted.
        obs: () => fakeObs({ refuseStart: 'output busy', encoderId: 'obs_nvenc_av1_tex' }),
        overrides: { autoStart: true },
        failure: /^OBS configured, but auto-start failed: output busy /,
    },
    {
        name: 'a request OBS never answers',
        obs: () => fakeObs({ stallColorSpace: true }),
        overrides: {},
        failure: /^OBS request SetProfileParameter timed out after 50ms\./,
    },
];

for (const { name, obs, overrides, failure } of failedSetups) {
    test(`after ${name} the encoder settings file is back as it was, whatever the file held`, { concurrency: false }, async (t) => {
        for (const before of [encoderFileBefore, Buffer.from('{not json'), null]) {
            const config = fakeObsConfig(t);
            if (before !== null) fsSync.writeFileSync(config.file, before);
            const server = await withSocketServer(t, config.options);
            const write = await pageWriter(server.client);

            const result = await configure(obs(), write, overrides);

            assert.equal(result.success, false);
            assert.match(result.message, failure);
            assert.match(result.message, /OBS settings were restored\./);
            assert.doesNotMatch(result.message, /Rollback incomplete/);
            assert.deepEqual(server.log, ['write', 'restore']);
            if (before === null) {
                assert.equal(fsSync.existsSync(config.file), false, 'a file that was not there is gone again');
            } else {
                assert.ok(fsSync.readFileSync(config.file).equals(Buffer.from(before)), 'the file holds its old bytes again');
            }
            assert.deepEqual(fsSync.readdirSync(config.dir).filter((entry) => entry !== 'streamEncoder.json'), ['basic.ini']);
            assert.equal(server.room.obsEncoderSettingsApplied, false, 'the room no longer counts on the settings that were taken back');
        }
    });
}

test('a setup that works leaves the settings it wrote, and nothing is restored', { concurrency: false }, async (t) => {
    const config = fakeObsConfig(t);
    fsSync.writeFileSync(config.file, encoderFileBefore);
    const server = await withSocketServer(t, config.options);

    const result = await configure(fakeObs(), await pageWriter(server.client), { autoStart: false });

    assert.equal(result.success, true, result.message);
    assert.deepEqual(server.log, ['write']);
    const written = JSON.parse(fsSync.readFileSync(config.file, 'utf8'));
    assert.equal(written.bitrate, 18_000);
    assert.equal(written.device, 1);
    assert.equal(server.room.obsEncoderSettingsApplied, true);
});

// The wiring in server.js itself (the loopback check, the two functions), in a real
// server process whose OBS configuration folder is the temporary one.
function waitForExit(child, timeoutMs = 10_000) {
    if (child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server did not exit within ${timeoutMs}ms`)), timeoutMs);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
}

test('the real server puts the settings file back for the local host of an OBS room, and for no one else', { concurrency: false, timeout: 40_000 }, async (t) => {
    const { port, rtcPort } = await claimServerPorts();
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = fakeObsConfig(t);
    fsSync.writeFileSync(config.file, encoderFileBefore);
    const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nextra-obs-restore-dist-'));
    await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
    t.after(() => fs.rm(distDir, { recursive: true, force: true }));
    let output = '';
    const sockets = [];
    let shutdownRequested = false;

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
            NEXTRA_SMOKE_TEST: '1',
            NEXTRA_TEST_DIST_DIR: distDir,
            LOG_LEVEL: 'warn',
            APPDATA: config.configHome,
            XDG_CONFIG_HOME: config.configHome,
        },
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    t.after(async () => {
        for (const socket of sockets) socket.close();
        if (child.exitCode === null && !shutdownRequested) {
            shutdownRequested = true;
            try { await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' }); } catch { child.kill(); }
        }
        try { await waitForExit(child, 7_000); } catch { child.kill(); }
    });

    const deadline = Date.now() + 20_000;
    for (;;) {
        if (child.exitCode !== null) assert.fail(`server exited before readiness\n${output}`);
        try {
            if ((await fetch(`${baseUrl}/readyz`)).ok) break;
        } catch { /* not listening yet */ }
        assert.ok(Date.now() < deadline, `server did not become ready\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const connect = async () => {
        const socket = await new Promise((resolve, reject) => {
            const opened = createClient(baseUrl, { transports: ['websocket'], extraHeaders: { Origin: baseUrl }, reconnection: false, timeout: 5_000 });
            opened.once('connect', () => resolve(opened));
            opened.once('connect_error', reject);
        });
        sockets.push(socket);
        return socket;
    };
    const host = await connect();
    const created = await request(host, 'create-room', { ingestMode: 'obs' });
    assert.equal(created.success, true, JSON.stringify(created));

    const settings = { rate_control: 'CBR', bitrate: 18_000, keyint_sec: 1, bf: 0 };
    const written = await request(host, 'obs-encoder-settings', { profileName: 'Streaming', settings });
    assert.equal(written.success, true);
    assert.equal(written.applied, true, JSON.stringify(written));
    assert.ok(written.previous, 'the server says how to put the file back');
    assert.ok(!JSON.stringify(written).includes(config.configHome), 'and not where the file is');
    assert.equal(JSON.parse(fsSync.readFileSync(config.file, 'utf8')).bitrate, 18_000);

    // Someone else's socket is not the host of the room: it can neither write nor restore.
    const stranger = await connect();
    assert.deepEqual(await request(stranger, 'obs-encoder-settings', { profileName: 'Streaming', settings: written.previous }),
        { success: false, error: 'Not hosting an OBS room.' });
    assert.equal(JSON.parse(fsSync.readFileSync(config.file, 'utf8')).bitrate, 18_000);

    assert.deepEqual(await request(host, 'obs-encoder-settings', { profileName: 'Streaming', settings: written.previous }),
        { success: true, applied: true, reason: null });
    assert.equal(fsSync.readFileSync(config.file, 'utf8'), encoderFileBefore);

    // A restore is spent once it has been used.
    assert.deepEqual(await request(host, 'obs-encoder-settings', { profileName: 'Streaming', settings: written.previous }),
        { success: true, applied: false, reason: 'restore-unavailable' });
    assert.equal(fsSync.readFileSync(config.file, 'utf8'), encoderFileBefore);

    assert.deepEqual(await request(host, 'leave-room'), { success: true });
    shutdownRequested = true;
    assert.equal((await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' })).status, 202);
    await waitForExit(child);
    assert.equal(child.exitCode, 0, output);
});
