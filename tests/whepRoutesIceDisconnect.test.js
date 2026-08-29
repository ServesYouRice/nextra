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
        transport: null,
        consumer: null,
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
        transport.id = 'ice-flap-transport-1';
        transport.close = () => { stats.transportCloses += 1; };
        transport.connect = async () => {};
        transport.consume = async () => {
            const consumer = new EventEmitter();
            consumer.id = 'ice-flap-consumer-1';
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
            stats.consumer = consumer;
            return consumer;
        };
        stats.transport = transport;

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

test('flapping ICE disconnect extends deadline to full 30s after second event', { concurrency: false }, async (t) => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobal = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createHarness();
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `ice-flap-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('ice-flap-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };

        t.mock.timers.enable({ apis: ['setTimeout'] });

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(res.status, 201);
        const sessionId = res.headers.get('location').split('/whep/watch/')[1];

        // DTLS connected
        stats.transport.emit('dtlsstatechange', 'connected');

        // First disconnect at t = 0
        stats.transport.emit('icestatechange', 'disconnected');

        // Tick 20s
        t.mock.timers.tick(20_000);
        assert.equal(room.whepSessions.size, 1);

        // Second disconnect at t = 20s
        stats.transport.emit('icestatechange', 'disconnected');

        // Tick 15s more -> total elapsed 35s from first disconnect (15s after second disconnect)
        // With the bug, orphaned first timer would have fired at t = 30s and killed session.
        t.mock.timers.tick(15_000);
        assert.equal(room.whepSessions.size, 1, 'Session should still be alive 15s after second disconnect');
        assert.ok(sessionRegistry.getWhepSession(sessionId));
        assert.equal(stats.transportCloses, 0);

        // Tick remaining 15s -> total 30s elapsed from second disconnect
        t.mock.timers.tick(15_000);
        assert.equal(room.whepSessions.size, 0, 'Session should be closed 30s after second disconnect');
        assert.equal(sessionRegistry.getWhepSession(sessionId), null);
        assert.equal(stats.transportCloses, 1);
        assert.equal(stats.consumerCloses, 1);
    } finally {
        t.mock.timers.reset();
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhep;
        await new Promise((resolve) => server.close(resolve));
        assert.equal(sessionRegistry.whepSessions.size, initialGlobal);
    }
});

test('repeated rapid ICE disconnect flapping does not orphan timers and cleans up exactly once', { concurrency: false }, async (t) => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobal = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createHarness();
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `ice-rapid-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('ice-rapid-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };

        t.mock.timers.enable({ apis: ['setTimeout'] });

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(res.status, 201);
        const sessionId = res.headers.get('location').split('/whep/watch/')[1];

        // DTLS connected
        stats.transport.emit('dtlsstatechange', 'connected');

        // Fire 5 disconnect events at 1s intervals (t=0, 1, 2, 3, 4s)
        for (let i = 0; i < 5; i += 1) {
            stats.transport.emit('icestatechange', 'disconnected');
            if (i < 4) t.mock.timers.tick(1_000);
        }

        // Now at t = 4s. The last disconnect happened at t = 4s, so deadline is t = 34s (30s after t=4s).
        // Tick to t = 33,999ms from start (29,999ms from 5th disconnect).
        t.mock.timers.tick(29_999);
        assert.equal(room.whepSessions.size, 1);
        assert.ok(sessionRegistry.getWhepSession(sessionId));
        assert.equal(stats.transportCloses, 0);

        // Tick 1ms more -> reaches 30s from 5th disconnect
        t.mock.timers.tick(1);
        assert.equal(room.whepSessions.size, 0);
        assert.equal(sessionRegistry.getWhepSession(sessionId), null);
        assert.equal(stats.transportCloses, 1);
        assert.equal(stats.consumerCloses, 1);

        // Tick another 60s -> assert no orphaned timer fires or increases close counts
        t.mock.timers.tick(60_000);
        assert.equal(stats.transportCloses, 1);
        assert.equal(stats.consumerCloses, 1);
    } finally {
        t.mock.timers.reset();
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhep;
        await new Promise((resolve) => server.close(resolve));
        assert.equal(sessionRegistry.whepSessions.size, initialGlobal);
    }
});
