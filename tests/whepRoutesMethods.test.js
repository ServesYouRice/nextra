const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const config = require('../config');
const { createRoom, destroyRoom } = require('../lib/rooms');
const { createWhepRouter } = require('../lib/whepRoutes');
const { sessionRegistry } = require('../lib/sessionRegistry');

const VIDEO_OFFER = [
    'v=0',
    'o=- 123456 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    'a=setup:actpass',
    'a=ice-ufrag:testufrag',
    'a=ice-pwd:testpwd1234567890123456',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=recvonly',
    'a=rtcp-mux',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 profile-level-id=42e01f;packetization-mode=1',
    '',
].join('\r\n');

function listen(app) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

function createHarness() {
    const stats = {
        transportCloses: 0,
        consumerCloses: 0,
    };

    const mediasoupRouter = {
        rtpCapabilities: {
            codecs: [{
                kind: 'video',
                mimeType: 'video/H264',
                preferredPayloadType: 96,
                clockRate: 90000,
                parameters: { 'profile-level-id': '42e01f', 'packetization-mode': 1 },
                rtcpFeedback: [],
            }],
            headerExtensions: [],
        },
        canConsume: () => true,
    };

    const createWebRtcTransport = async () => {
        const transport = new EventEmitter();
        transport.id = 'fake-transport-1';
        transport.close = () => { stats.transportCloses += 1; };
        transport.connect = async () => {};
        transport.consume = async () => {
            const consumer = new EventEmitter();
            consumer.id = 'fake-consumer-1';
            consumer.kind = 'video';
            consumer.rtpParameters = {
                codecs: [{
                    payloadType: 96,
                    mimeType: 'video/H264',
                    clockRate: 90000,
                    parameters: { 'profile-level-id': '42e01f', 'packetization-mode': 1 },
                    rtcpFeedback: [],
                }],
                headerExtensions: [],
                encodings: [{ ssrc: 12345678 }],
            };
            consumer.resume = async () => {};
            consumer.close = () => { stats.consumerCloses += 1; };
            return consumer;
        };

        return {
            transport,
            params: {
                iceParameters: { usernameFragment: 'serverufrag', password: 'serverpwd' },
                iceCandidates: [{ protocol: 'udp', ip: '127.0.0.1', port: 40000, type: 'host' }],
                dtlsParameters: {
                    fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB:CC' }],
                },
            },
        };
    };

    return { mediasoupRouter, createWebRtcTransport, stats };
}

test('DELETE terminates active WHEP session, reflects CORS, decrements viewer count, and cleans maps/resources', { concurrency: false }, async () => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobalSessions = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createHarness();
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        isAllowedOrigin: (origin) => origin === 'https://allowed.example',
        getClientIp: () => `whep-del-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('whep-del-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };

        // Create session via POST
        const postRes = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(postRes.status, 201);
        const location = postRes.headers.get('location');
        const sessionId = location.split('/whep/watch/')[1];

        assert.equal(room.whepSessions.size, 1);
        assert.equal(room.whepViewerCount, 1);
        assert.ok(sessionRegistry.getWhepSession(sessionId));

        // DELETE active session
        const delRes = await fetch(`${baseUrl}/whep/watch/${sessionId}`, {
            method: 'DELETE',
            headers: { Origin: 'https://allowed.example' },
        });
        assert.equal(delRes.status, 200);
        assert.equal(delRes.headers.get('access-control-allow-origin'), 'https://allowed.example');
        assert.equal(delRes.headers.get('vary'), 'Origin');
        assert.deepEqual(await delRes.json(), { ok: true });

        // Assert maps, viewer counts, resources
        assert.equal(room.whepSessions.size, 0);
        assert.equal(room.whepViewerCount, 0);
        assert.equal(sessionRegistry.getWhepSession(sessionId), null);
        assert.equal(stats.transportCloses, 1);
        assert.equal(stats.consumerCloses, 1);

        // Repeated DELETE -> 404
        const repeatDelRes = await fetch(`${baseUrl}/whep/watch/${sessionId}`, {
            method: 'DELETE',
            headers: { Origin: 'https://allowed.example' },
        });
        assert.equal(repeatDelRes.status, 404);
        assert.equal(repeatDelRes.headers.get('access-control-allow-origin'), 'https://allowed.example');
        assert.deepEqual(await repeatDelRes.json(), { error: 'WHEP session not found' });
    } finally {
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhep;
        await new Promise((resolve) => server.close(resolve));
        assert.equal(sessionRegistry.whepSessions.size, initialGlobalSessions);
    }
});

test('DELETE unknown sessionId returns 404 with CORS headers', { concurrency: false }, async () => {
    const { mediasoupRouter, createWebRtcTransport } = createHarness();
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        isAllowedOrigin: (origin) => origin === 'https://allowed.example',
        getClientIp: () => `whep-unk-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    try {
        const res = await fetch(`${baseUrl}/whep/watch/unknownsession123`, {
            method: 'DELETE',
            headers: { Origin: 'https://allowed.example' },
        });
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('access-control-allow-origin'), 'https://allowed.example');
        assert.deepEqual(await res.json(), { error: 'WHEP session not found' });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('DELETE cleans up orphan session from global map if room was already destroyed', { concurrency: false }, async () => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobalSessions = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport } = createHarness();
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-orphan-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('whep-orphan-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };

        // Create session
        const postRes = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(postRes.status, 201);
        const location = postRes.headers.get('location');
        const sessionId = location.split('/whep/watch/')[1];

        assert.ok(sessionRegistry.getWhepSession(sessionId));

        // Manually destroy room without closing whepSessions directly to simulate orphan
        destroyRoom(room.code);
        room = null;

        // Re-inject orphan session into registry if destroyRoom cleaned it
        sessionRegistry.registerWhepSession(sessionId, { roomCode: 'whep-orphan-room' });
        assert.ok(sessionRegistry.getWhepSession(sessionId));

        // DELETE orphan session
        const delRes = await fetch(`${baseUrl}/whep/watch/${sessionId}`, {
            method: 'DELETE',
        });
        assert.equal(delRes.status, 200);
        assert.deepEqual(await delRes.json(), { ok: true });
        assert.equal(sessionRegistry.getWhepSession(sessionId), null);
    } finally {
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhep;
        await new Promise((resolve) => server.close(resolve));
        assert.equal(sessionRegistry.whepSessions.size, initialGlobalSessions);
    }
});

test('PATCH returns 501 Trickle ICE not implemented with CORS headers', { concurrency: false }, async () => {
    const { mediasoupRouter, createWebRtcTransport } = createHarness();
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        isAllowedOrigin: (origin) => origin === 'https://allowed.example',
        getClientIp: () => `whep-patch-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    try {
        const res = await fetch(`${baseUrl}/whep/watch/anysession123`, {
            method: 'PATCH',
            headers: {
                Origin: 'https://allowed.example',
                'Content-Type': 'application/trickle-ice-sdpfrag',
            },
            body: 'a=candidate:...',
        });
        assert.equal(res.status, 501);
        assert.equal(res.headers.get('access-control-allow-origin'), 'https://allowed.example');
        assert.deepEqual(await res.json(), { error: 'Trickle ICE not implemented' });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
