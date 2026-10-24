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
    const room = await createRoom('whip-race-host', { ingestMode: 'obs' });
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

test('public WHIP enforces per-IP and global pending-start limits before media allocation', { concurrency: false }, async () => {
    const previous = {
        enabled: config.WHIP_ENABLED,
        publicEnabled: config.PUBLIC_WHIP_ENABLED,
        rateMax: config.PUBLIC_WHIP_RATE_LIMIT_MAX,
        pendingMax: config.PUBLIC_WHIP_MAX_PENDING_STARTS,
    };
    config.WHIP_ENABLED = true;
    config.PUBLIC_WHIP_ENABLED = true;
    config.PUBLIC_WHIP_RATE_LIMIT_MAX = 10;
    config.PUBLIC_WHIP_MAX_PENDING_STARTS = 1;
    const firstRoom = await createRoom('public-whip-a', { ingestMode: 'obs' });
    const secondRoom = await createRoom('public-whip-b', { ingestMode: 'obs' });
    const releases = [];
    let enteredCount = 0;
    let notifyEntered = null;
    const waitForEntered = () => new Promise((resolve) => { notifyEntered = resolve; });
    const app = express();
    app.use('/whip', createWhipRouter({}, {
        publicEndpoint: true,
        getClientIp: (req) => req.headers['x-test-ip'] || 'unknown',
        createWebRtcTransport: async () => {
            enteredCount += 1;
            notifyEntered?.();
            notifyEntered = null;
            await new Promise((resolve) => releases.push(resolve));
            throw new Error('injected public transport failure');
        },
    }));
    const { server, baseUrl } = await listen(app);
    const postRoom = (room, ip) => fetch(`${baseUrl}/whip/broadcast/${room.code}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/sdp',
            Authorization: `Bearer ${room.hostToken}`,
            'x-test-ip': ip,
        },
        body: VIDEO_OFFER,
    });

    try {
        const firstEntered = waitForEntered();
        const firstRequest = postRoom(firstRoom, '198.51.100.1');
        await firstEntered;
        assert.equal(enteredCount, 1);

        const overlap = await postRoom(secondRoom, '198.51.100.2');
        assert.equal(overlap.status, 503);
        assert.match((await overlap.json()).error, /capacity/);
        assert.equal(enteredCount, 1);

        releases.shift()?.();
        assert.equal((await firstRequest).status, 500);
        assert.equal(firstRoom.whipStarting, false);

        const secondEntered = waitForEntered();
        const afterRelease = postRoom(secondRoom, '198.51.100.3');
        await secondEntered;
        assert.equal(enteredCount, 2);
        releases.shift()?.();
        assert.equal((await afterRelease).status, 500);

        config.PUBLIC_WHIP_RATE_LIMIT_MAX = 1;
        const missingRoom = { code: 'ZZZZZZ', hostToken: 'unused-token' };
        const firstLimited = await postRoom(missingRoom, '198.51.100.99');
        assert.equal(firstLimited.status, 404);
        const secondLimited = await postRoom(missingRoom, '198.51.100.99');
        assert.equal(secondLimited.status, 429);
    } finally {
        releases.splice(0).forEach((release) => release());
        destroyRoom(firstRoom.code);
        destroyRoom(secondRoom.code);
        config.WHIP_ENABLED = previous.enabled;
        config.PUBLIC_WHIP_ENABLED = previous.publicEnabled;
        config.PUBLIC_WHIP_RATE_LIMIT_MAX = previous.rateMax;
        config.PUBLIC_WHIP_MAX_PENDING_STARTS = previous.pendingMax;
        await new Promise((resolve) => server.close(resolve));
    }
});

// ── An offer whose produced section has no a=ssrc is rejected before any transport exists ──

const OFFER_HEAD = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'a=ice-ufrag:testufrag',
    'a=ice-pwd:testpwd1234567890123456',
    'a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
    'a=setup:actpass',
];

// An OBS-style H.264 video + Opus audio offer. An SSRC set to null leaves out that section's a=ssrc.
function obsOffer({ videoSsrc = 1111, audioSsrc = 2222, audioLines = null } = {}) {
    return [
        ...OFFER_HEAD,
        'm=video 9 UDP/TLS/RTP/SAVPF 96',
        'c=IN IP4 0.0.0.0',
        'a=mid:0',
        'a=sendonly',
        'a=rtpmap:96 H264/90000',
        'a=fmtp:96 profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1',
        ...(videoSsrc == null ? [] : [`a=ssrc:${videoSsrc} cname:test`]),
        ...(audioLines || [
            'm=audio 9 UDP/TLS/RTP/SAVPF 111',
            'c=IN IP4 0.0.0.0',
            'a=mid:1',
            'a=sendonly',
            'a=rtpmap:111 opus/48000/2',
            'a=fmtp:111 minptime=10;useinbandfec=1',
            ...(audioSsrc == null ? [] : [`a=ssrc:${audioSsrc} cname:test`]),
        ]),
        '',
    ].join('\r\n');
}

const SSRC_LESS_CASES = [
    { name: 'video section', offer: obsOffer({ videoSsrc: null }), sections: ['video'] },
    { name: 'audio section', offer: obsOffer({ audioSsrc: null }), sections: ['audio'] },
    { name: 'video and audio sections', offer: obsOffer({ videoSsrc: null, audioSsrc: null }), sections: ['video', 'audio'] },
];

for (const { name, offer, sections } of SSRC_LESS_CASES) {
    test(`WHIP rejects an offer with no a=ssrc in its ${name} (400, no transport created)`, { concurrency: false }, async () => {
        const originalWhipEnabled = config.WHIP_ENABLED;
        config.WHIP_ENABLED = true;
        const room = await createRoom(`whip-no-ssrc-${sections.join('-')}`, { ingestMode: 'obs' });
        let transportCalls = 0;
        const app = express();
        app.use('/whip', createWhipRouter({}, {
            isAllowedOrigin: (origin) => origin === 'https://allowed.example',
            createWebRtcTransport: async () => {
                transportCalls += 1;
                throw new Error('the transport must not be created for an SSRC-less offer');
            },
        }));
        const { server, baseUrl } = await listen(app);

        try {
            const response = await fetch(`${baseUrl}/whip/broadcast/${room.code}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/sdp',
                    Authorization: `Bearer ${room.hostToken}`,
                    Origin: 'https://allowed.example',
                },
                body: offer,
            });
            const body = await response.json();

            assert.equal(response.status, 400, JSON.stringify(body));
            assert.match(body.error, /a=ssrc/);
            for (const section of sections) assert.match(body.error, new RegExp(section));
            assert.deepEqual(body.sections, sections);
            assert.equal(response.headers.get('access-control-allow-origin'), 'https://allowed.example');
            assert.equal(response.headers.get('access-control-allow-methods'), 'POST, DELETE, OPTIONS');

            assert.equal(transportCalls, 0);
            assert.equal(room.whipStarting, false);
            assert.equal(room.whipTransport, null);
            assert.equal(room.whipSessionId ?? null, null);
            assert.equal(room.whipResourceId ?? null, null);
        } finally {
            destroyRoom(room.code);
            config.WHIP_ENABLED = originalWhipEnabled;
            await new Promise((resolve) => server.close(resolve));
        }
    });
}

test('WHIP offers with a=ssrc for every produced section still reach the transport, and a rejected SSRC-less offer frees the public start slot', { concurrency: false }, async () => {
    const previous = {
        enabled: config.WHIP_ENABLED,
        publicEnabled: config.PUBLIC_WHIP_ENABLED,
        rateMax: config.PUBLIC_WHIP_RATE_LIMIT_MAX,
        pendingMax: config.PUBLIC_WHIP_MAX_PENDING_STARTS,
    };
    config.WHIP_ENABLED = true;
    config.PUBLIC_WHIP_ENABLED = true;
    config.PUBLIC_WHIP_RATE_LIMIT_MAX = 100;
    config.PUBLIC_WHIP_MAX_PENDING_STARTS = 1;
    const room = await createRoom('whip-ssrc-public', { ingestMode: 'obs' });
    let transportCalls = 0;
    const app = express();
    app.use('/whip', createWhipRouter({}, {
        publicEndpoint: true,
        createWebRtcTransport: async () => {
            transportCalls += 1;
            throw new Error('injected transport failure');
        },
    }));
    const { server, baseUrl } = await listen(app);
    const post = (offer) => fetch(`${baseUrl}/whip/broadcast/${room.code}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${room.hostToken}` },
        body: offer,
    });

    try {
        // Rejected on its SSRC: no transport, and the single public start slot is given back
        assert.equal((await post(obsOffer({ videoSsrc: null }))).status, 400);
        assert.equal(transportCalls, 0);
        assert.equal(room.whipStarting, false);

        // OBS's own offer (a=ssrc in video and audio) goes on to create the transport (500: the injected failure)
        assert.equal((await post(obsOffer())).status, 500);
        assert.equal(transportCalls, 1);

        // An audio section that is not produced (no Opus) needs no a=ssrc
        const pcmuAudio = [
            'm=audio 9 UDP/TLS/RTP/SAVPF 0',
            'c=IN IP4 0.0.0.0',
            'a=mid:1',
            'a=sendonly',
            'a=rtpmap:0 PCMU/8000',
        ];
        assert.equal((await post(obsOffer({ audioLines: pcmuAudio }))).status, 500);
        assert.equal(transportCalls, 2);
        assert.equal(room.whipStarting, false);
    } finally {
        destroyRoom(room.code);
        config.WHIP_ENABLED = previous.enabled;
        config.PUBLIC_WHIP_ENABLED = previous.publicEnabled;
        config.PUBLIC_WHIP_RATE_LIMIT_MAX = previous.rateMax;
        config.PUBLIC_WHIP_MAX_PENDING_STARTS = previous.pendingMax;
        await new Promise((resolve) => server.close(resolve));
    }
});
