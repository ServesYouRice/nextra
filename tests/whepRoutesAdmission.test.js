const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const config = require('../config');
const { createRoom, destroyRoom } = require('../lib/rooms');
const { createWhepRouter } = require('../lib/whepRoutes');

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

function makeStubRouter(transportTracker = { calls: 0 }) {
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
        transportTracker.calls += 1;
        throw new Error('createWebRtcTransport should not be called');
    };

    return { mediasoupRouter, createWebRtcTransport };
}

test('CORS preflight reflects trusted origin and omits denied origin', { concurrency: false }, async () => {
    let reqCounter = 0;
    const { mediasoupRouter, createWebRtcTransport } = makeStubRouter();
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        isAllowedOrigin: (origin) => origin === 'https://allowed.example',
        getClientIp: () => `whep-cors-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    try {
        // Allowed origin OPTIONS
        const allowedRes = await fetch(`${baseUrl}/whep/watch/ANYROOM`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://allowed.example' },
        });
        assert.equal(allowedRes.status, 204);
        assert.equal(allowedRes.headers.get('access-control-allow-origin'), 'https://allowed.example');
        assert.equal(allowedRes.headers.get('vary'), 'Origin');
        assert.equal(allowedRes.headers.get('access-control-allow-methods'), 'POST, DELETE, PATCH, OPTIONS');
        assert.equal(allowedRes.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');

        // Denied origin OPTIONS
        const deniedRes = await fetch(`${baseUrl}/whep/watch/ANYROOM`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://denied.example' },
        });
        assert.equal(deniedRes.status, 204);
        assert.equal(deniedRes.headers.get('access-control-allow-origin'), null);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('POST returns 404 when WHEP is disabled without creating transport', { concurrency: false }, async () => {
    const prevWhepEnabled = config.WHEP_ENABLED;
    const transportTracker = { calls: 0 };
    const { mediasoupRouter, createWebRtcTransport } = makeStubRouter(transportTracker);
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-disabled-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    try {
        config.WHEP_ENABLED = false;
        const res = await fetch(`${baseUrl}/whep/watch/NOROOM`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: 'WHEP is not enabled' });
        assert.equal(transportTracker.calls, 0);
    } finally {
        config.WHEP_ENABLED = prevWhepEnabled;
        await new Promise((resolve) => server.close(resolve));
    }
});

test('POST returns 404 when room is missing without creating transport', { concurrency: false }, async () => {
    const prevWhepEnabled = config.WHEP_ENABLED;
    const transportTracker = { calls: 0 };
    const { mediasoupRouter, createWebRtcTransport } = makeStubRouter(transportTracker);
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-missing-room-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    try {
        config.WHEP_ENABLED = true;
        const res = await fetch(`${baseUrl}/whep/watch/NONEXISTENT`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: 'Room not found' });
        assert.equal(transportTracker.calls, 0);
    } finally {
        config.WHEP_ENABLED = prevWhepEnabled;
        await new Promise((resolve) => server.close(resolve));
    }
});

test('POST returns 409 when room has no active video producer without creating transport', { concurrency: false }, async () => {
    const prevWhepEnabled = config.WHEP_ENABLED;
    const transportTracker = { calls: 0 };
    const { mediasoupRouter, createWebRtcTransport } = makeStubRouter(transportTracker);
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-no-producer-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('whep-no-producer-host');
        // No video producer assigned
        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(res.status, 409);
        assert.deepEqual(await res.json(), { error: 'No active video producer in this room' });
        assert.equal(transportTracker.calls, 0);
    } finally {
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhepEnabled;
        await new Promise((resolve) => server.close(resolve));
    }
});

test('POST validates room passphrase admission and requires Bearer authentication before capacity check', { concurrency: false }, async () => {
    const prevWhepEnabled = config.WHEP_ENABLED;
    const prevMaxViewers = config.MAX_VIEWERS_PER_ROOM;
    const prevGlobalSessions = config.WHEP_MAX_GLOBAL_SESSIONS;
    const prevRateLimit = config.WHEP_RATE_LIMIT_MAX;

    const transportTracker = { calls: 0 };
    const { mediasoupRouter, createWebRtcTransport } = makeStubRouter(transportTracker);
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-passphrase-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        config.MAX_VIEWERS_PER_ROOM = 0; // 0 room limit so valid passphrase hits 503 capacity
        config.WHEP_MAX_GLOBAL_SESSIONS = 100;
        config.WHEP_RATE_LIMIT_MAX = 100;

        room = await createRoom('whep-passphrase-host', { passphrase: 'open sesame' });
        room.producer = { id: 'video-producer-1', closed: false, close() {} };

        // Missing Authorization header -> 401
        const missingAuthRes = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(missingAuthRes.status, 401);
        assert.equal(missingAuthRes.headers.get('www-authenticate'), 'Bearer realm="Nextra room"');
        assert.deepEqual(await missingAuthRes.json(), { error: 'Room passphrase required or incorrect' });
        assert.equal(transportTracker.calls, 0);

        // Wrong passphrase in Bearer -> 401
        const wrongAuthRes = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/sdp',
                Authorization: 'Bearer wrong-passphrase',
            },
            body: VIDEO_OFFER,
        });
        assert.equal(wrongAuthRes.status, 401);
        assert.equal(wrongAuthRes.headers.get('www-authenticate'), 'Bearer realm="Nextra room"');
        assert.deepEqual(await wrongAuthRes.json(), { error: 'Room passphrase required or incorrect' });
        assert.equal(transportTracker.calls, 0);

        // Correct passphrase -> passes auth and reaches capacity gate 503
        const correctAuthRes = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/sdp',
                Authorization: 'Bearer open sesame',
            },
            body: VIDEO_OFFER,
        });
        assert.equal(correctAuthRes.status, 503);
        assert.deepEqual(await correctAuthRes.json(), { error: 'Room is full' });
        assert.equal(transportTracker.calls, 0);
    } finally {
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhepEnabled;
        config.MAX_VIEWERS_PER_ROOM = prevMaxViewers;
        config.WHEP_MAX_GLOBAL_SESSIONS = prevGlobalSessions;
        config.WHEP_RATE_LIMIT_MAX = prevRateLimit;
        await new Promise((resolve) => server.close(resolve));
    }
});
