const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { createWhipRouter } = require('../lib/whipRoutes');
const { createRoom, destroyRoom } = require('../lib/rooms');
const config = require('../config');

const VIDEO_OFFER = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=ice-ufrag:testufrag',
    'a=ice-pwd:testpwd1234567890123456',
    'a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
    'a=setup:actpass',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=sendonly',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1',
    'a=ssrc:1111 cname:test',
    '',
].join('\r\n');

function listen(app) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
}

test('WHIP CORS reflects only trusted browser origins', async () => {
    const app = express();
    app.use('/whip', createWhipRouter({}, {
        isAllowedOrigin: (origin) => origin === 'https://allowed.example',
    }));

    const { server, baseUrl } = await listen(app);
    try {
        const allowed = await fetch(`${baseUrl}/whip/broadcast/ABC123`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://allowed.example' },
        });
        assert.equal(allowed.status, 204);
        assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://allowed.example');
        assert.equal(allowed.headers.get('vary'), 'Origin');

        const denied = await fetch(`${baseUrl}/whip/broadcast/ABC123`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://evil.example' },
        });
        assert.equal(denied.status, 204);
        assert.equal(denied.headers.get('access-control-allow-origin'), null);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('parallel WHIP starts admit one owner and clear the synchronous claim after failure', { concurrency: false }, async () => {
    const originalWhipEnabled = config.WHIP_ENABLED;
    config.WHIP_ENABLED = true;
    const room = createRoom('whip-race-host', { ingestMode: 'obs' });
    let releaseTransport;
    const transportRelease = new Promise((resolve) => { releaseTransport = resolve; });
    let markTransportEntered;
    const transportEntered = new Promise((resolve) => { markTransportEntered = resolve; });
    const app = express();
    app.use('/whip', createWhipRouter({}, {
        createWebRtcTransport: async () => {
            markTransportEntered();
            await transportRelease;
            throw new Error('injected transport failure');
        },
    }));
    const { server, baseUrl } = await listen(app);
    const requestOptions = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/sdp',
            Authorization: `Bearer ${room.hostToken}`,
        },
        body: VIDEO_OFFER,
    };

    try {
        const firstRequest = fetch(`${baseUrl}/whip/broadcast/${room.code}`, requestOptions);
        await transportEntered;
        assert.equal(room.whipStarting, true);

        const secondResponse = await fetch(`${baseUrl}/whip/broadcast/${room.code}`, requestOptions);
        assert.equal(secondResponse.status, 409);
        assert.match((await secondResponse.json()).error, /already starting/);

        releaseTransport();
        const firstResponse = await firstRequest;
        assert.equal(firstResponse.status, 500);
        assert.equal(room.whipStarting, false);
        assert.equal(room.whipTransport, null);
    } finally {
        releaseTransport?.();
        destroyRoom(room.code);
        config.WHIP_ENABLED = originalWhipEnabled;
        await new Promise((resolve) => server.close(resolve));
    }
});
