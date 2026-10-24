const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { createWhipRouter, setIo, setMediaLifecycle } = require('../lib/whipRoutes');
const { createRoom, destroyRoom } = require('../lib/rooms');
const { sessionRegistry } = require('../lib/sessionRegistry');
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

// ── Session generations: a stale startup or producer completion never touches a newer session ──

// OBS's video + audio offer, with sprop-parameter-sets so going live does not start the stream capture.
const LIVE_OFFER = obsOffer().replace(
    'level-asymmetry-allowed=1',
    'level-asymmetry-allowed=1;sprop-parameter-sets=Z0LgH9oBQBbsBEAAAAMAQAAADyPGDKA=,aM4G4g==',
);

const FAKE_TRANSPORT_PARAMS = {
    iceParameters: { usernameFragment: 'srvufrag', password: 'srvpassword12345678901234' },
    iceCandidates: [{ ip: '127.0.0.1', port: 40000, protocol: 'udp', type: 'host' }],
    dtlsParameters: { role: 'auto', fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB:CC:DD' }] },
};

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// Lets pending promise continuations and socket I/O run (setImmediate is never mocked here).
async function flush(rounds = 10) {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(condition, what, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setImmediate(resolve));
    }
}

// A mediasoup WebRtcTransport stand-in. plan.connect and plan.produce[kind] are optional
// functions whose promise connect() / produce() wait for (a rejection fails the call).
// As in mediasoup 3.27, close() drops the DTLS state subscription without emitting
// anything, and a connect() or produce() already pending still completes afterwards.
function createFakeTransport(id, plan = {}) {
    const transport = new EventEmitter();
    transport.id = id;
    transport.closed = false;
    transport.producers = [];
    transport.close = () => {
        transport.closed = true;
        transport.removeAllListeners('dtlsstatechange');
    };
    transport.connect = async () => {
        if (plan.connect) await plan.connect();
    };
    transport.produce = async ({ kind, rtpParameters }) => {
        if (plan.produce?.[kind]) await plan.produce[kind]();
        const producer = {
            id: `${id}-${kind}`,
            kind,
            rtpParameters,
            closed: false,
            close() { producer.closed = true; },
        };
        transport.producers.push(producer);
        return producer;
    };
    return transport;
}

// A WHIP router on a real HTTP server with fake transports (one plan per POST, in order), a
// fake Socket.IO server, spies for host metrics and relay prewarm, and a spy on the room's
// media-pipeline ownWhip().
async function startWhipHarness(hostId, transportPlans = []) {
    const originalWhipEnabled = config.WHIP_ENABLED;
    config.WHIP_ENABLED = true;
    const room = await createRoom(hostId, { ingestMode: 'obs' });
    const transports = [];
    const emitted = [];
    const hostMetrics = [];
    const relayStarts = [];
    const ownWhipCalls = [];

    const pipeline = room._mediaPipeline;
    const realOwnWhip = pipeline.ownWhip.bind(pipeline);
    pipeline.ownWhip = (name, resource, close) => {
        ownWhipCalls.push({ name, resource });
        return realOwnWhip(name, resource, close);
    };

    setIo({ to: (target) => ({ emit: (event, data) => emitted.push({ target, event, data }) }) });
    setMediaLifecycle({
        emitHostMetrics: (_io, roomCode) => hostMetrics.push({
            roomCode,
            whipConnected: room.whipConnected,
            whipReconnecting: room.whipReconnecting,
            whipSessionId: room.whipSessionId,
        }),
        startFallbackRelay: async (relayRoom) => { relayStarts.push(relayRoom.code); },
    });

    const app = express();
    app.use('/whip', createWhipRouter({}, {
        createWebRtcTransport: async () => {
            const transport = createFakeTransport(`transport-${transports.length + 1}`, transportPlans[transports.length]);
            transports.push(transport);
            return { transport, params: FAKE_TRANSPORT_PARAMS };
        },
    }));
    const { server, baseUrl } = await listen(app);

    return {
        room,
        transports,
        emitted,
        hostMetrics,
        relayStarts,
        ownWhipCalls,
        post: (signal, body = LIVE_OFFER) => fetch(`${baseUrl}/whip/broadcast/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${room.hostToken}` },
            body,
            signal,
        }),
        resourceIdOf: (response) => response.headers.get('location').split('/').pop(),
        resourcesForRoom: () => [...sessionRegistry.whipResources]
            .filter(([, roomCode]) => roomCode === room.code)
            .map(([resourceId]) => resourceId),
        newProducerEvents: () => emitted
            .filter(({ event }) => event === 'new-producer')
            .map(({ target, data }) => ({ target, ...data })),
        async close() {
            destroyRoom(room.code);
            setIo(null);
            setMediaLifecycle({ emitHostMetrics: () => {}, startFallbackRelay: async () => {} });
            config.WHIP_ENABLED = originalWhipEnabled;
            // After an aborted fetch the client opens a fresh idle connection; do not wait
            // for its keep-alive timeout.
            const closed = new Promise((resolve) => server.close(resolve));
            server.closeAllConnections();
            await closed;
        },
    };
}

// The generation is gone: transport closed, nothing registered, no producers, host told last.
function assertSessionTornDown(h, transport, resourceId) {
    assert.equal(transport.closed, true, 'the transport is closed');
    assert.equal(h.room.whipTransport, null);
    assert.equal(h.room.whipProducer, null);
    assert.equal(h.room.whipAudioProducer, null);
    assert.equal(h.room.whipSessionId, null);
    assert.equal(h.room.whipResourceId, null);
    assert.equal(sessionRegistry.roomCodeForWhipResource(resourceId), null, 'the WHIP resource is unregistered');
    assert.equal(h.room.whipConnected, false);
    assert.equal(h.room.whipReconnecting, false);
    assert.equal(h.room.fallbackAvailable, false);
    assert.equal(h.room.whipGraceTimer, null);
    for (const name of ['transport', 'video-producer', 'audio-producer']) {
        assert.equal(h.room._mediaPipeline.releaseWhip(name), false, `the media pipeline no longer owns the WHIP ${name}`);
    }
    for (const producer of transport.producers) assert.equal(producer.closed, true, `${producer.kind} producer is closed`);
    assert.deepEqual(h.hostMetrics.at(-1), {
        roomCode: h.room.code, whipConnected: false, whipReconnecting: false, whipSessionId: null,
    }, 'host metrics are emitted after the teardown');
}

test('WHIP happy path: 201, then DTLS connected creates both producers and goes live', { concurrency: false }, async () => {
    const h = await startWhipHarness('whip-happy-path', [{}]);
    try {
        const response = await h.post();
        assert.equal(response.status, 201);
        assert.match(response.headers.get('content-type'), /^application\/sdp\b/);
        const resourceId = h.resourceIdOf(response);
        assert.equal(sessionRegistry.roomCodeForWhipResource(resourceId), h.room.code);
        const [transport] = h.transports;
        assert.equal(h.room.whipTransport, transport);
        assert.equal(h.room.whipResourceId, resourceId);
        assert.equal(h.room.whipStarting, false);
        assert.equal(h.room.whipConnected, false);

        transport.emit('dtlsstatechange', 'connected');
        await flush();

        const [video, audio] = transport.producers;
        assert.equal(h.room.whipProducer, video);
        assert.equal(h.room.whipAudioProducer, audio);
        assert.equal(h.room.whipConnected, true);
        assert.deepEqual(h.ownWhipCalls.map(({ name, resource }) => [name, resource]), [
            ['transport', transport], ['video-producer', video], ['audio-producer', audio],
        ]);
        assert.deepEqual(h.newProducerEvents(), [
            { target: h.room.code, producerId: video.id, kind: 'video' },
            { target: h.room.code, producerId: audio.id, kind: 'audio' },
        ]);
        assert.equal(h.hostMetrics.at(-1).whipConnected, true);
        assert.deepEqual(h.relayStarts, [h.room.code]);
        assert.equal(transport.closed, false);
    } finally {
        await h.close();
    }
});

// POSTs with a connect() that waits for the returned gate, aborts the request once connect()
// is pending, and waits until the server has cancelled the start.
async function abortStartDuringConnect(hostId, extraPlans = []) {
    const connectGate = deferred();
    const connectEntered = deferred();
    const h = await startWhipHarness(hostId, [
        { connect: () => { connectEntered.resolve(); return connectGate.promise; } },
        ...extraPlans,
    ]);
    try {
        const controller = new AbortController();
        const request = h.post(controller.signal).catch((err) => err);
        await connectEntered.promise;
        const [transport] = h.transports;
        assert.equal(h.room.whipTransport, transport);
        controller.abort();
        assert.equal((await request).name, 'AbortError');
        await waitFor(() => h.room.whipStarting === false, 'the aborted start to release the room');
        return { h, transport, connectGate };
    } catch (err) {
        connectGate.resolve();
        await h.close();
        throw err;
    }
}

test('a WHIP start aborted while transport.connect() is pending gives its transport up at once', { concurrency: false }, async () => {
    const { h, transport, connectGate } = await abortStartDuringConnect('whip-aborted-connect-release');
    try {
        assert.equal(transport.closed, true);
        assert.equal(h.room.whipTransport, null, 'the room no longer points at the cancelled transport');
        assert.equal(h.room._mediaPipeline.releaseWhip('transport'), false, 'the media pipeline no longer owns it');
        assert.equal(h.room.whipGeneration, null);
    } finally {
        connectGate.resolve();
        await h.close();
    }
});

test('a WHIP start aborted while transport.connect() is pending publishes no session when connect() completes', { concurrency: false }, async () => {
    const { h, connectGate } = await abortStartDuringConnect('whip-aborted-connect-publish');
    try {
        connectGate.resolve();
        await flush();

        assert.equal(h.room.whipSessionId, null);
        assert.equal(h.room.whipResourceId, null);
        assert.deepEqual(h.resourcesForRoom(), [], 'no WHIP resource is registered for the room');
        assert.equal(h.room.whipTransport, null);
        assert.equal(h.room.whipStarting, false);
    } finally {
        connectGate.resolve();
        await h.close();
    }
});

test('a WHIP offer without a DTLS fingerprint gets 400 and leaves no transport on the room or in its media pipeline', { concurrency: false }, async () => {
    const h = await startWhipHarness('whip-no-fingerprint', [{}]);
    try {
        const offer = LIVE_OFFER.split('\r\n').filter((line) => !line.startsWith('a=fingerprint:')).join('\r\n');
        const response = await h.post(undefined, offer);
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /DTLS fingerprint/);
        const [transport] = h.transports;
        assert.equal(transport.closed, true);
        assert.equal(h.room.whipTransport, null);
        assert.equal(h.room._mediaPipeline.releaseWhip('transport'), false);
        assert.equal(h.room.whipStarting, false);
        assert.deepEqual(h.resourcesForRoom(), []);
    } finally {
        await h.close();
    }
});

test('a stale transport.connect() completion after a replacement WHIP start leaves the replacement session as it is', { concurrency: false }, async () => {
    const { h, transport: staleTransport, connectGate: staleConnect } = await abortStartDuringConnect('whip-stale-connect', [{}]);
    try {
        // OBS retries: the replacement start completes first
        const replacement = await h.post();
        assert.equal(replacement.status, 201);
        const replacementResource = h.resourceIdOf(replacement);
        const replacementTransport = h.transports[1];
        const replacementSession = h.room.whipSessionId;
        assert.equal(h.room.whipTransport, replacementTransport);

        // ... then the aborted start's connect() resolves
        staleConnect.resolve();
        await flush();

        assert.equal(h.room.whipTransport, replacementTransport);
        assert.equal(h.room.whipSessionId, replacementSession);
        assert.equal(h.room.whipResourceId, replacementResource);
        assert.deepEqual(h.resourcesForRoom(), [replacementResource], 'only the replacement resource is registered');
        assert.equal(staleTransport.closed, true);
        assert.equal(replacementTransport.closed, false);

        // and the replacement still goes live
        replacementTransport.emit('dtlsstatechange', 'connected');
        await flush();
        assert.equal(h.room.whipConnected, true);
        assert.equal(h.room.whipProducer, replacementTransport.producers[0]);
    } finally {
        staleConnect.resolve();
        await h.close();
    }
});

for (const kind of ['video', 'audio']) {
    test(`a stale ${kind} produce() completion closes only its own producer and never touches the replacement session`, { concurrency: false }, async () => {
        const staleProduce = deferred();
        const h = await startWhipHarness(`whip-stale-${kind}-produce`, [
            { produce: { [kind]: () => staleProduce.promise } },
            {},
        ]);
        try {
            assert.equal((await h.post()).status, 201);
            const [staleTransport] = h.transports;
            staleTransport.emit('dtlsstatechange', 'connected');
            await flush();

            // OBS reconnects: a new POST replaces the session while the old produce() is pending
            const replacement = await h.post();
            assert.equal(replacement.status, 201);
            assert.equal(staleTransport.closed, true);
            const liveTransport = h.transports[1];
            liveTransport.emit('dtlsstatechange', 'connected');
            await flush();
            const [liveVideo, liveAudio] = liveTransport.producers;
            assert.equal(h.room.whipConnected, true);
            const ownWhipCallsBefore = h.ownWhipCalls.length;
            const eventsBefore = h.emitted.length;
            const metricsBefore = h.hostMetrics.length;

            staleProduce.resolve();
            await flush();

            const staleProducer = staleTransport.producers.find((producer) => producer.kind === kind);
            assert.ok(staleProducer, `the stale ${kind} producer was created`);
            assert.equal(staleProducer.closed, true, 'the stale producer is closed');
            assert.deepEqual(h.ownWhipCalls.slice(ownWhipCallsBefore), [], 'ownWhip is not called for the stale producer');
            assert.equal(h.room.whipProducer, liveVideo);
            assert.equal(h.room.whipAudioProducer, liveAudio);
            assert.equal(liveVideo.closed, false);
            assert.equal(liveAudio.closed, false);
            assert.equal(h.room.whipTransport, liveTransport);
            assert.equal(h.room.whipConnected, true);
            assert.equal(h.emitted.length, eventsBefore, 'no events for the stale producer');
            assert.equal(h.hostMetrics.length, metricsBefore);
        } finally {
            staleProduce.resolve();
            await h.close();
        }
    });
}

test('a rejected video produce() tears the WHIP session down instead of leaving it half started', { concurrency: false }, async () => {
    const h = await startWhipHarness('whip-video-produce-rejects', [
        { produce: { video: () => Promise.reject(new Error('router rejected the video rtpParameters')) } },
    ]);
    try {
        const response = await h.post();
        assert.equal(response.status, 201);
        const resourceId = h.resourceIdOf(response);
        const [transport] = h.transports;

        transport.emit('dtlsstatechange', 'connected');
        await flush();

        assert.deepEqual(transport.producers, []);
        assertSessionTornDown(h, transport, resourceId);
        assert.deepEqual(h.newProducerEvents(), []);
        assert.deepEqual(h.relayStarts, []);
    } finally {
        await h.close();
    }
});

test('a rejected audio produce() after the video producer tears the whole WHIP session down, video producer included', { concurrency: false }, async () => {
    const h = await startWhipHarness('whip-audio-produce-rejects', [
        { produce: { audio: () => Promise.reject(new Error('router rejected the audio rtpParameters')) } },
    ]);
    try {
        const response = await h.post();
        assert.equal(response.status, 201);
        const resourceId = h.resourceIdOf(response);
        const [transport] = h.transports;

        transport.emit('dtlsstatechange', 'connected');
        await flush();

        assert.deepEqual(transport.producers.map((producer) => producer.kind), ['video']);
        assertSessionTornDown(h, transport, resourceId);
        assert.deepEqual(h.newProducerEvents(), []);
        assert.deepEqual(h.relayStarts, []);
    } finally {
        await h.close();
    }
});

test('DTLS failing while produce() is pending leaves the session disconnected, and the grace timer then closes it', { concurrency: false }, async (t) => {
    const pendingVideo = deferred();
    const h = await startWhipHarness('whip-dtls-fails-mid-produce', [
        { produce: { video: () => pendingVideo.promise } },
    ]);
    try {
        const response = await h.post();
        assert.equal(response.status, 201);
        const resourceId = h.resourceIdOf(response);
        const [transport] = h.transports;
        transport.emit('dtlsstatechange', 'connected');
        await flush();

        t.mock.timers.enable({ apis: ['setTimeout'] });
        transport.emit('dtlsstatechange', 'failed');
        assert.equal(h.room.whipConnected, false);
        assert.equal(h.room.whipReconnecting, true);
        assert.notEqual(h.room.whipGraceTimer, null);

        pendingVideo.resolve();
        await flush();
        assert.equal(h.room.whipConnected, false, 'a produce() that completes after DTLS failed does not mark the session connected');
        assert.deepEqual(h.newProducerEvents(), []);
        assert.deepEqual(h.relayStarts, []);

        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS + 1);
        assertSessionTornDown(h, transport, resourceId);
    } finally {
        t.mock.timers.reset();
        pendingVideo.resolve();
        await h.close();
    }
});
