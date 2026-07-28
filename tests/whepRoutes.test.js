const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { EventEmitter } = require('node:events');

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

test('parallel WHEP admission reserves room capacity before asynchronous transport creation', { concurrency: false }, async () => {
    const original = {
        WHEP_ENABLED: config.WHEP_ENABLED,
        MAX_VIEWERS_PER_ROOM: config.MAX_VIEWERS_PER_ROOM,
        WHEP_MAX_GLOBAL_SESSIONS: config.WHEP_MAX_GLOBAL_SESSIONS,
        WHEP_RATE_LIMIT_MAX: config.WHEP_RATE_LIMIT_MAX,
    };
    config.WHEP_ENABLED = true;
    config.MAX_VIEWERS_PER_ROOM = 1;
    config.WHEP_MAX_GLOBAL_SESSIONS = 10;
    config.WHEP_RATE_LIMIT_MAX = 100;

    const room = await createRoom('whep-race-host');
    room.producer = { id: 'video-producer', closed: false, close() {} };
    const closed = { transports: 0, consumers: 0 };
    let releaseTransport;
    const transportRelease = new Promise((resolve) => { releaseTransport = resolve; });
    let markTransportEntered;
    const transportEntered = new Promise((resolve) => { markTransportEntered = resolve; });
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
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-race-${Date.now()}`,
        createWebRtcTransport: async () => {
            markTransportEntered();
            await transportRelease;
            return {
                transport: createFakeTransport(closed),
                params: {
                    iceParameters: { usernameFragment: 'server', password: 'server-password' },
                    iceCandidates: [{ protocol: 'udp', ip: '127.0.0.1', port: 40000, type: 'host' }],
                    dtlsParameters: {
                        fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB:CC' }],
                    },
                },
            };
        },
    }));
    const { server, baseUrl } = await listen(app);

    try {
        const firstRequest = fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        await transportEntered;
        assert.equal(room.whepPendingReservations, 1);

        const secondResponse = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_OFFER,
        });
        assert.equal(secondResponse.status, 503);
        assert.match((await secondResponse.json()).error, /Room is full/);

        releaseTransport();
        const firstResponse = await firstRequest;
        assert.equal(firstResponse.status, 201);
        assert.match(firstResponse.headers.get('location') || '', /^\/whep\/watch\//);
        assert.equal(room.whepPendingReservations, 0);
        assert.equal(room.whepSessions.size, 1);
    } finally {
        releaseTransport?.();
        destroyRoom(room.code);
        await new Promise((resolve) => server.close(resolve));
        Object.assign(config, original);
    }

    assert.equal(closed.transports, 1);
    assert.equal(closed.consumers, 1);
});
