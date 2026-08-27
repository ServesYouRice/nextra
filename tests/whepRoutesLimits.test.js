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

function createFakeTransport(closed) {
    const transport = new EventEmitter();
    transport.close = () => { closed.transports += 1; };
    transport.connect = async () => {};
    transport.consume = async ({ producerId }) => {
        const consumer = new EventEmitter();
        consumer.id = `consumer-${closed.consumers + 1}`;
        consumer.producerId = producerId;
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
        consumer.close = () => { closed.consumers += 1; };
        return consumer;
    };
    return transport;
}

test('per-IP rate limiter denies second request from single-attempt IP before transport creation', { concurrency: false }, async () => {
    const prevWhepEnabled = config.WHEP_ENABLED;
    const prevRateLimitMax = config.WHEP_RATE_LIMIT_MAX;
    const prevRateLimitWindow = config.WHEP_RATE_LIMIT_WINDOW_MS;

    let transportCalls = 0;
    const mediasoupRouter = {
        rtpCapabilities: { codecs: [{ kind: 'video', mimeType: 'video/H264', preferredPayloadType: 96, clockRate: 90000 }] },
        canConsume: () => true,
    };
    const app = express();
    const uniqueIp = `rate-test-ip-${Date.now()}`;
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => uniqueIp,
        createWebRtcTransport: async () => {
            transportCalls += 1;
            throw new Error('should not allocate transport');
        },
    }));
    const { server, baseUrl } = await listen(app);

    try {
        config.WHEP_ENABLED = true;
        config.WHEP_RATE_LIMIT_MAX = 1;
        config.WHEP_RATE_LIMIT_WINDOW_MS = 60_000;

        // First request: unknown room -> 404
        const firstRes = await fetch(`${baseUrl}/whep/watch/UNKNOWN1`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(firstRes.status, 404);
        assert.deepEqual(await firstRes.json(), { error: 'Room not found' });
        assert.equal(transportCalls, 0);

        // Second request from same IP -> 429 Too many WHEP requests
        const secondRes = await fetch(`${baseUrl}/whep/watch/UNKNOWN2`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(secondRes.status, 429);
        assert.match((await secondRes.json()).error, /Too many WHEP requests/);
        assert.equal(transportCalls, 0);
    } finally {
        config.WHEP_ENABLED = prevWhepEnabled;
        config.WHEP_RATE_LIMIT_MAX = prevRateLimitMax;
        config.WHEP_RATE_LIMIT_WINDOW_MS = prevRateLimitWindow;
        await new Promise((resolve) => server.close(resolve));
    }
});

test('existing Socket.IO viewer consumes room slot and denies WHEP before transport allocation', { concurrency: false }, async () => {
    const prevWhepEnabled = config.WHEP_ENABLED;
    const prevMaxViewers = config.MAX_VIEWERS_PER_ROOM;
    const prevGlobalSessions = config.WHEP_MAX_GLOBAL_SESSIONS;
    const prevRateLimit = config.WHEP_RATE_LIMIT_MAX;

    let transportCalls = 0;
    const mediasoupRouter = {
        rtpCapabilities: { codecs: [{ kind: 'video', mimeType: 'video/H264', preferredPayloadType: 96, clockRate: 90000 }] },
        canConsume: () => true,
    };
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `socket-slot-${reqCounter++}`,
        createWebRtcTransport: async () => {
            transportCalls += 1;
            throw new Error('should not allocate transport');
        },
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        config.MAX_VIEWERS_PER_ROOM = 1;
        config.WHEP_MAX_GLOBAL_SESSIONS = 100;
        config.WHEP_RATE_LIMIT_MAX = 100;

        room = await createRoom('whep-socket-viewer-host');
        room.producer = { id: 'video-producer-1', closed: false, close() {} };
        // Add one Socket.IO viewer to room.viewers
        room.viewers.add('socket-viewer-1');

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });

        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), { error: 'Room is full' });
        assert.equal(transportCalls, 0);
    } finally {
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhepEnabled;
        config.MAX_VIEWERS_PER_ROOM = prevMaxViewers;
        config.WHEP_MAX_GLOBAL_SESSIONS = prevGlobalSessions;
        config.WHEP_RATE_LIMIT_MAX = prevRateLimit;
        await new Promise((resolve) => server.close(resolve));
    }
});

test('global pending and active limits deny across rooms before allocation and clean up completely', { concurrency: false }, async () => {
    const prevWhepEnabled = config.WHEP_ENABLED;
    const prevMaxViewers = config.MAX_VIEWERS_PER_ROOM;
    const prevGlobalSessions = config.WHEP_MAX_GLOBAL_SESSIONS;
    const prevRateLimit = config.WHEP_RATE_LIMIT_MAX;

    const initialPendingGlobal = sessionRegistry.pendingWhepGlobal;
    const initialActiveGlobal = sessionRegistry.whepSessions.size;

    let transportCalls = 0;
    const closed = { transports: 0, consumers: 0 };
    let releaseBarrier;
    const barrierPromise = new Promise((resolve) => { releaseBarrier = resolve; });
    let markEntered;
    const enteredPromise = new Promise((resolve) => { markEntered = resolve; });

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

    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `global-cap-${reqCounter++}`,
        createWebRtcTransport: async () => {
            transportCalls += 1;
            markEntered();
            await barrierPromise;
            return {
                transport: createFakeTransport(closed),
                params: {
                    iceParameters: { usernameFragment: 'srv', password: 'srv-password' },
                    iceCandidates: [{ protocol: 'udp', ip: '127.0.0.1', port: 40000, type: 'host' }],
                    dtlsParameters: {
                        fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB:CC' }],
                    },
                },
            };
        },
    }));
    const { server, baseUrl } = await listen(app);

    let roomA = null;
    let roomB = null;
    try {
        config.WHEP_ENABLED = true;
        config.WHEP_MAX_GLOBAL_SESSIONS = 1;
        config.MAX_VIEWERS_PER_ROOM = 10;
        config.WHEP_RATE_LIMIT_MAX = 100;

        roomA = await createRoom('whep-global-host-a');
        roomA.producer = { id: 'prod-a', closed: false, close() {} };

        roomB = await createRoom('whep-global-host-b');
        roomB.producer = { id: 'prod-b', closed: false, close() {} };

        // Start request for Room A (will pause in transport factory)
        const reqA = fetch(`${baseUrl}/whep/watch/${roomA.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });

        await enteredPromise;

        // Assert pending counters: 1 global, 1 in room A, 0 in room B
        assert.equal(sessionRegistry.pendingWhepGlobal, 1);
        assert.equal(roomA.whepPendingReservations, 1);
        assert.equal(roomB.whepPendingReservations || 0, 0);

        // POST for Room B while Room A is pending -> 503 Server WHEP capacity reached
        const resBPending = await fetch(`${baseUrl}/whep/watch/${roomB.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(resBPending.status, 503);
        assert.deepEqual(await resBPending.json(), {
            error: 'Server WHEP capacity reached. Try again later.',
        });
        assert.equal(transportCalls, 1, 'Only room A should have entered transport factory');

        // Release Room A barrier and await its response
        releaseBarrier();
        const resA = await reqA;
        assert.equal(resA.status, 201);
        assert.equal(sessionRegistry.pendingWhepGlobal, 0);
        assert.equal(roomA.whepPendingReservations, 0);
        assert.equal(sessionRegistry.whepSessions.size, 1);
        assert.equal(roomA.whepSessions.size, 1);

        // Retry Room B now that Room A is active -> 503 Server WHEP capacity reached (due to active session)
        const resBActive = await fetch(`${baseUrl}/whep/watch/${roomB.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(resBActive.status, 503);
        assert.deepEqual(await resBActive.json(), {
            error: 'Server WHEP capacity reached. Try again later.',
        });
        assert.equal(transportCalls, 1, 'Room B must not allocate transport');
    } finally {
        releaseBarrier?.();
        if (roomA) destroyRoom(roomA.code);
        if (roomB) destroyRoom(roomB.code);
        config.WHEP_ENABLED = prevWhepEnabled;
        config.MAX_VIEWERS_PER_ROOM = prevMaxViewers;
        config.WHEP_MAX_GLOBAL_SESSIONS = prevGlobalSessions;
        config.WHEP_RATE_LIMIT_MAX = prevRateLimit;
        await new Promise((resolve) => server.close(resolve));

        assert.equal(sessionRegistry.pendingWhepGlobal, initialPendingGlobal);
        assert.equal(sessionRegistry.whepSessions.size, initialActiveGlobal);
    }
});
