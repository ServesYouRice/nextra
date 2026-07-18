const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io: createSocketClient } = require('socket.io-client');

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

function waitForExit(child, timeoutMs = 10_000) {
    if (child.exitCode !== null) {
        return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`server did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timeout);
            child.removeListener('exit', onExit);
        };
        const onExit = (code, signal) => {
            cleanup();
            resolve({ code, signal });
        };
        child.once('exit', onExit);
    });
}

async function waitForReady(baseUrl, child, getOutput, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`server exited before readiness (code ${child.exitCode})\n${getOutput()}`);
        }
        try {
            const response = await fetch(`${baseUrl}/readyz`);
            if (response.ok) return response.json();
        } catch {
            // The listener may not exist yet while mediasoup initializes.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`server did not become ready within ${timeoutMs}ms\n${getOutput()}`);
}

function connectSocket(baseUrl, origin = baseUrl) {
    return new Promise((resolve, reject) => {
        const socket = createSocketClient(baseUrl, {
            transports: ['websocket'],
            extraHeaders: { Origin: origin },
            reconnection: false,
            timeout: 5_000,
        });
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

test('real server composition enforces HTTP and Socket.IO operational contracts', { concurrency: false, timeout: 40_000 }, async (t) => {
    const port = await reserveTcpPort();
    let rtcPort = await reserveTcpPort();
    while (rtcPort === port) rtcPort = await reserveTcpPort();
    const metricsToken = 'integration-metrics-token';
    const baseUrl = `http://127.0.0.1:${port}`;
    let output = '';
    let socket = null;
    let viewer = null;
    let overflowViewer = null;
    let payloadSocket = null;
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
            ENABLE_OPENMETRICS: 'true',
            METRICS_TOKEN: metricsToken,
            ALLOW_REMOTE_METRICS: 'false',
            TRUST_X_FORWARDED_HEADERS: 'true',
            CREATE_ROOM_RATE_LIMIT_MAX: '1',
            MAX_VIEWERS_PER_ROOM: '1',
            SOCKET_MAX_HTTP_BUFFER_SIZE: '8192',
            NEXTRA_SMOKE_TEST: '1',
            LOG_LEVEL: 'warn',
        },
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });

    t.after(async () => {
        socket?.close();
        viewer?.close();
        overflowViewer?.close();
        payloadSocket?.close();
        if (child.exitCode === null && !shutdownRequested) {
            try {
                shutdownRequested = true;
                await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' });
            } catch {
                child.kill();
            }
        }
        if (child.exitCode === null) {
            try {
                await waitForExit(child, 7_000);
            } catch {
                child.kill();
            }
        }
    });

    const ready = await waitForReady(baseUrl, child, () => output);
    assert.deepEqual({
        status: ready.status,
        mediaWorker: ready.mediaWorker,
        socketServer: ready.socketServer,
        whip: ready.whip,
    }, {
        status: 'ready',
        mediaWorker: true,
        socketServer: true,
        whip: 'disabled',
    });

    const healthResponse = await fetch(`${baseUrl}/healthz`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { status: 'ok' });

    const configResponse = await fetch(`${baseUrl}/api/config`);
    assert.equal(configResponse.status, 200);
    const publicConfig = await configResponse.json();
    assert.equal(publicConfig.whipEnabled, false);
    assert.equal(publicConfig.whepEnabled, false);
    assert.equal(Object.hasOwn(publicConfig, 'metricsToken'), false);
    assert.equal(Object.hasOwn(publicConfig, 'iceServers'), false);

    const jsonMetricsResponse = await fetch(`${baseUrl}/api/metrics`);
    assert.equal(jsonMetricsResponse.status, 200);
    const jsonMetrics = await jsonMetricsResponse.json();
    assert.equal(jsonMetrics.rooms.active, 0);
    assert.equal(jsonMetrics.rooms.sensitiveFieldsIncluded, true);
    assert.ok(jsonMetrics.mediaWorker.resourceUsage);

    const forwardedRemoteMetricsResponse = await fetch(`${baseUrl}/api/metrics`, {
        headers: { 'x-forwarded-for': '203.0.113.40' },
    });
    assert.equal(forwardedRemoteMetricsResponse.status, 403);

    const unavailableTurnMintResponse = await fetch(`${baseUrl}/api/cloudflare-turn-credentials`, {
        method: 'POST',
        headers: { Origin: baseUrl },
    });
    assert.equal(unavailableTurnMintResponse.status, 404);
    assert.match((await unavailableTurnMintResponse.json()).error, /not configured/i);

    const deniedMetricsResponse = await fetch(`${baseUrl}/metrics`);
    assert.equal(deniedMetricsResponse.status, 401);
    assert.match(deniedMetricsResponse.headers.get('www-authenticate') || '', /Bearer/i);

    const openMetricsResponse = await fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: `Bearer ${metricsToken}` },
    });
    assert.equal(openMetricsResponse.status, 200);
    assert.match(openMetricsResponse.headers.get('content-type') || '', /openmetrics-text/);
    assert.match(await openMetricsResponse.text(), /nextra_rooms_active 0/);

    const unknownApiResponse = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(unknownApiResponse.status, 404);
    assert.deepEqual(await unknownApiResponse.json(), { error: 'Not found' });

    const spaResponse = await fetch(`${baseUrl}/watch/example`);
    assert.equal(spaResponse.status, 200);
    assert.match(spaResponse.headers.get('content-type') || '', /text\/html/);
    assert.match(await spaResponse.text(), /<div id="root"><\/div>/);

    socket = await connectSocket(baseUrl);
    const serverConfig = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('server-config event timed out')), 5_000);
        socket.once('server-config', (payload) => {
            clearTimeout(timeout);
            resolve(payload);
        });
        socket.emit('request-server-config');
    });
    assert.equal(serverConfig.whipHttpStatus, 'disabled');
    assert.equal(serverConfig.shareBaseUrl, '');
    assert.equal(Object.hasOwn(serverConfig, 'metricsToken'), false);
    assert.equal(Object.hasOwn(serverConfig, 'iceServers'), false);
    await assert.rejects(connectSocket(baseUrl, 'https://untrusted.example'));

    const created = await socketRequest(socket, 'create-room', { ingestMode: 'browser' });
    assert.equal(created.success, true);
    assert.match(created.code, /^[A-Z0-9]{6}$/);
    assert.ok(created.hostToken.length >= 16);

    viewer = await connectSocket(baseUrl);
    const joined = await socketRequest(viewer, 'join-room', { code: created.code });
    assert.equal(joined.success, true);
    const duplicateJoin = await socketRequest(viewer, 'join-room', { code: created.code });
    assert.equal(duplicateJoin.success, true);

    const firstSendTransport = await socketRequest(socket, 'create-send-transport');
    assert.equal(firstSendTransport.success, true);
    assert.ok(firstSendTransport.params.id);
    const replacementSendTransport = await socketRequest(socket, 'create-send-transport');
    assert.equal(replacementSendTransport.success, true);
    assert.notEqual(replacementSendTransport.params.id, firstSendTransport.params.id);

    const firstRecvTransport = await socketRequest(viewer, 'create-recv-transport');
    assert.equal(firstRecvTransport.success, true);
    assert.ok(firstRecvTransport.params.id);
    const replacementRecvTransport = await socketRequest(viewer, 'create-recv-transport');
    assert.equal(replacementRecvTransport.success, true);
    assert.notEqual(replacementRecvTransport.params.id, firstRecvTransport.params.id);
    const invalidConnect = await socketRequest(viewer, 'connect-transport', {
        transportId: replacementRecvTransport.params.id,
        dtlsParameters: {},
    });
    assert.equal(invalidConnect.success, false);
    assert.match(invalidConnect.error, /Invalid parameters/);

    const capabilitiesResponse = await socketRequest(socket, 'get-rtp-capabilities');
    assert.equal(capabilitiesResponse.success, true);
    const vp8 = capabilitiesResponse.rtpCapabilities.codecs.find((codec) => codec.mimeType.toLowerCase() === 'video/vp8');
    assert.ok(vp8);
    const produced = await socketRequest(socket, 'produce', {
        kind: 'video',
        rtpParameters: {
            mid: '0',
            codecs: [{
                mimeType: vp8.mimeType,
                payloadType: vp8.preferredPayloadType,
                clockRate: vp8.clockRate,
                parameters: vp8.parameters,
                rtcpFeedback: vp8.rtcpFeedback,
            }],
            headerExtensions: [],
            encodings: [{ ssrc: 111_111_111 }],
            rtcp: { cname: 'integration-host', reducedSize: true },
        },
        appData: { source: 'integration-test' },
    });
    assert.equal(produced.success, true);
    assert.ok(produced.producerId);

    const consumed = await socketRequest(viewer, 'consume', {
        producerId: produced.producerId,
        rtpCapabilities: capabilitiesResponse.rtpCapabilities,
    });
    assert.equal(consumed.success, true);
    assert.equal(consumed.params.producerId, produced.producerId);
    assert.equal(consumed.params.kind, 'video');
    assert.deepEqual(
        await socketRequest(viewer, 'consumer-resume', { consumerId: consumed.params.id }),
        { success: true },
    );

    overflowViewer = await connectSocket(baseUrl);
    const rejectedJoin = await socketRequest(overflowViewer, 'join-room', { code: created.code });
    assert.equal(rejectedJoin.success, false);
    assert.match(rejectedJoin.error, /Room is full \(max 1 viewer/);
    const rateLimitedCreate = await socketRequest(overflowViewer, 'create-room', { ingestMode: 'browser' });
    assert.equal(rateLimitedCreate.success, false);
    assert.match(rateLimitedCreate.error, /Too many room creation attempts/);

    const activeRoomMetrics = await (await fetch(`${baseUrl}/api/metrics`)).json();
    assert.equal(activeRoomMetrics.rooms.active, 1);
    assert.equal(activeRoomMetrics.rooms.totalViewers, 1);
    assert.equal(activeRoomMetrics.rooms.totalMediasoupConsumers, 1);
    assert.equal(activeRoomMetrics.sockets.counters.joinDeniedRoomFull, 1);
    assert.equal(activeRoomMetrics.sockets.counters.createRoomDeniedRateLimit, 1);
    assert.equal(activeRoomMetrics.sockets.counters.activeProducers, 1);
    assert.equal(activeRoomMetrics.sockets.counters.activeConsumers, 1);
    // Active-resource metrics power the churn/leak suite (T-07).
    assert.equal(typeof activeRoomMetrics.process.resources.total, 'number');
    assert.ok(activeRoomMetrics.process.resources.total > 0);
    assert.equal(typeof activeRoomMetrics.process.resources.byType, 'object');

    assert.deepEqual(await socketRequest(viewer, 'leave-room'), { success: true });
    assert.deepEqual(await socketRequest(socket, 'leave-room'), { success: true });
    const cleanedMetrics = await (await fetch(`${baseUrl}/api/metrics`)).json();
    assert.equal(cleanedMetrics.rooms.active, 0);
    assert.equal(cleanedMetrics.rooms.totalViewers, 0);
    assert.equal(cleanedMetrics.sockets.counters.activeProducers, 0);
    assert.equal(cleanedMetrics.sockets.counters.activeConsumers, 0);

    payloadSocket = await connectSocket(baseUrl);
    const oversizedDisconnect = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('oversized Socket.IO payload was not disconnected')), 5_000);
        payloadSocket.once('disconnect', (reason) => {
            clearTimeout(timeout);
            resolve(reason);
        });
    });
    payloadSocket.emit('oversized-probe', Buffer.alloc(16_384));
    assert.match(await oversizedDisconnect, /transport close|server disconnect/i);

    shutdownRequested = true;
    const shutdownResponse = await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' });
    assert.equal(shutdownResponse.status, 202);
    assert.deepEqual(await shutdownResponse.json(), { status: 'shutting-down' });
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, output);
});
