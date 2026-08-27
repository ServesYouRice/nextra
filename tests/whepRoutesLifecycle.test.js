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

function createLifecycleHarness() {
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
        transport.id = 'lifecycle-transport-1';
        transport.close = () => { stats.transportCloses += 1; };
        transport.connect = async () => {};
        transport.consume = async () => {
            const consumer = new EventEmitter();
            consumer.id = 'lifecycle-consumer-1';
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

test('connect deadline reaps never-connected WHEP session after 30s', { concurrency: false }, async (t) => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobal = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createLifecycleHarness();
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `never-conn-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('never-conn-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };

        t.mock.timers.enable({ apis: ['setTimeout'] });

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(res.status, 201);
        const sessionId = res.headers.get('location').split('/whep/watch/')[1];

        // Session exists before deadline
        assert.equal(room.whepSessions.size, 1);
        assert.ok(sessionRegistry.getWhepSession(sessionId));

        // Tick to 29,999ms -> session still exists
        t.mock.timers.tick(29_999);
        assert.equal(room.whepSessions.size, 1);
        assert.ok(sessionRegistry.getWhepSession(sessionId));
        assert.equal(stats.transportCloses, 0);

        // Tick 1ms more (30,000ms reached) -> session reaped
        t.mock.timers.tick(1);
        assert.equal(room.whepSessions.size, 0);
        assert.equal(room.whepViewerCount, 0);
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

test('DTLS connected cancels connect deadline and keeps session alive past 30s', { concurrency: false }, async (t) => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobal = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createLifecycleHarness();
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `dtls-conn-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('dtls-conn-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };

        t.mock.timers.enable({ apis: ['setTimeout'] });

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(res.status, 201);
        const sessionId = res.headers.get('location').split('/whep/watch/')[1];
        const session = room.whepSessions.get(sessionId);

        // Emit DTLS connected
        stats.transport.emit('dtlsstatechange', 'connected');
        assert.equal(session.dtlsConnected, true);
        assert.equal(session.connectTimer, null);

        // Tick past 30s deadline
        t.mock.timers.tick(30_000);
        assert.equal(room.whepSessions.size, 1);
        assert.ok(sessionRegistry.getWhepSession(sessionId));
        assert.equal(stats.transportCloses, 0);
    } finally {
        t.mock.timers.reset();
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhep;
        await new Promise((resolve) => server.close(resolve));
        assert.equal(sessionRegistry.whepSessions.size, initialGlobal);
    }
});

for (const dtlsTerminalState of ['failed', 'closed']) {
    test(`DTLS ${dtlsTerminalState} terminates session immediately and idempotently`, { concurrency: false }, async (t) => {
        const prevWhep = config.WHEP_ENABLED;
        const initialGlobal = sessionRegistry.whepSessions.size;

        const { mediasoupRouter, createWebRtcTransport, stats } = createLifecycleHarness();
        let reqCounter = 0;
        const app = express();
        app.use('/whep', createWhepRouter(mediasoupRouter, {
            getClientIp: () => `dtls-${dtlsTerminalState}-${reqCounter++}`,
            createWebRtcTransport,
        }));
        const { server, baseUrl } = await listen(app);

        let room = null;
        try {
            config.WHEP_ENABLED = true;
            room = await createRoom(`dtls-${dtlsTerminalState}-room`);
            room.producer = { id: 'prod-video', closed: false, close() {} };

            t.mock.timers.enable({ apis: ['setTimeout'] });

            const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/sdp' },
                body: VIDEO_OFFER,
            });
            assert.equal(res.status, 201);
            const sessionId = res.headers.get('location').split('/whep/watch/')[1];

            // Emit terminal DTLS state
            stats.transport.emit('dtlsstatechange', dtlsTerminalState);
            assert.equal(room.whepSessions.size, 0);
            assert.equal(room.whepViewerCount, 0);
            assert.equal(sessionRegistry.getWhepSession(sessionId), null);
            assert.equal(stats.transportCloses, 1);
            assert.equal(stats.consumerCloses, 1);

            // Repeated emit is idempotent
            stats.transport.emit('dtlsstatechange', dtlsTerminalState);
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
}

for (const iceRecoveryState of ['connected', 'completed']) {
    test(`ICE recovery with ${iceRecoveryState} cancels disconnect timer and keeps session active`, { concurrency: false }, async (t) => {
        const prevWhep = config.WHEP_ENABLED;
        const initialGlobal = sessionRegistry.whepSessions.size;

        const { mediasoupRouter, createWebRtcTransport, stats } = createLifecycleHarness();
        let reqCounter = 0;
        const app = express();
        app.use('/whep', createWhepRouter(mediasoupRouter, {
            getClientIp: () => `ice-recov-${iceRecoveryState}-${reqCounter++}`,
            createWebRtcTransport,
        }));
        const { server, baseUrl } = await listen(app);

        let room = null;
        try {
            config.WHEP_ENABLED = true;
            room = await createRoom(`ice-recov-${iceRecoveryState}-room`);
            room.producer = { id: 'prod-video', closed: false, close() {} };

            t.mock.timers.enable({ apis: ['setTimeout'] });

            const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/sdp' },
                body: VIDEO_OFFER,
            });
            assert.equal(res.status, 201);
            const sessionId = res.headers.get('location').split('/whep/watch/')[1];
            const session = room.whepSessions.get(sessionId);

            stats.transport.emit('dtlsstatechange', 'connected');
            stats.transport.emit('icestatechange', 'disconnected');
            assert.ok(session.iceDisconnectTimer);

            // Tick 29,999ms while disconnected
            t.mock.timers.tick(29_999);
            assert.equal(room.whepSessions.size, 1);

            // Emit recovery state
            stats.transport.emit('icestatechange', iceRecoveryState);
            assert.equal(session.iceDisconnectTimer, null);

            // Tick past original 30s deadline
            t.mock.timers.tick(10_000);
            assert.equal(room.whepSessions.size, 1);
            assert.ok(sessionRegistry.getWhepSession(sessionId));
            assert.equal(stats.transportCloses, 0);
        } finally {
            t.mock.timers.reset();
            if (room) destroyRoom(room.code);
            config.WHEP_ENABLED = prevWhep;
            await new Promise((resolve) => server.close(resolve));
            assert.equal(sessionRegistry.whepSessions.size, initialGlobal);
        }
    });
}

test('ICE disconnected timeout terminates session after 30s', { concurrency: false }, async (t) => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobal = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createLifecycleHarness();
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `ice-timeout-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('ice-timeout-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };

        t.mock.timers.enable({ apis: ['setTimeout'] });

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(res.status, 201);
        const sessionId = res.headers.get('location').split('/whep/watch/')[1];

        stats.transport.emit('dtlsstatechange', 'connected');
        stats.transport.emit('icestatechange', 'disconnected');

        // Tick to 30,000ms
        t.mock.timers.tick(30_000);
        assert.equal(room.whepSessions.size, 0);
        assert.equal(room.whepViewerCount, 0);
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

test('consumer producerclose terminates session immediately and idempotently', { concurrency: false }, async () => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobal = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createLifecycleHarness();
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `producer-close-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('producer-close-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(res.status, 201);
        const sessionId = res.headers.get('location').split('/whep/watch/')[1];

        // Emit producerclose
        stats.consumer.emit('producerclose');
        assert.equal(room.whepSessions.size, 0);
        assert.equal(room.whepViewerCount, 0);
        assert.equal(sessionRegistry.getWhepSession(sessionId), null);
        assert.equal(stats.transportCloses, 1);
        assert.equal(stats.consumerCloses, 1);

        // Second emit is idempotent
        stats.consumer.emit('producerclose');
        assert.equal(stats.transportCloses, 1);
        assert.equal(stats.consumerCloses, 1);
    } finally {
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhep;
        await new Promise((resolve) => server.close(resolve));
        assert.equal(sessionRegistry.whepSessions.size, initialGlobal);
    }
});
