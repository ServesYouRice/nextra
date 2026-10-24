const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { createWhipRouter, closeWhipSession, setIo, setMediaLifecycle } = require('../lib/whipRoutes');
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
        transport.removeAllListeners('icestatechange');
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
async function startWhipHarness(hostId, transportPlans = [], mediasoupRouter = {}) {
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
    app.use('/whip', createWhipRouter(mediasoupRouter, {
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
        // Sends the host's bearer token unless the caller passes its own headers ({} for none).
        delete: (resourceId, headers = { Authorization: `Bearer ${room.hostToken}` }) => fetch(
            `${baseUrl}/whip/broadcast/${resourceId}`,
            { method: 'DELETE', headers },
        ),
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

// ── ICE liveness and the establishment timeout ──

// POSTs, brings DTLS up and waits for the session to go live. The session is the newest transport's.
async function startLiveSession(h) {
    const response = await h.post();
    assert.equal(response.status, 201);
    const transport = h.transports.at(-1);
    transport.emit('dtlsstatechange', 'connected');
    await flush();
    assert.equal(h.room.whipConnected, true);
    return { resourceId: h.resourceIdOf(response), transport };
}

function assertSessionLive(h, transport, resourceId) {
    assert.equal(transport.closed, false, 'the transport is open');
    assert.equal(h.room.whipTransport, transport);
    assert.equal(h.room.whipResourceId, resourceId);
    assert.equal(sessionRegistry.roomCodeForWhipResource(resourceId), h.room.code);
    assert.equal(h.room.whipConnected, true);
    assert.equal(h.room.whipReconnecting, false);
    assert.equal(h.room.whipGraceTimer, null);
    for (const producer of transport.producers) assert.equal(producer.closed, false, `${producer.kind} producer is open`);
}

test('ICE disconnecting while DTLS stays connected starts the grace period, and the grace timer then closes the session', { concurrency: false }, async (t) => {
    const h = await startWhipHarness('whip-ice-disconnect-teardown', [{}]);
    try {
        const { resourceId, transport } = await startLiveSession(h);
        const metricsBefore = h.hostMetrics.length;

        t.mock.timers.enable({ apis: ['setTimeout'] });
        transport.emit('icestatechange', 'disconnected');
        assert.equal(h.room.whipConnected, false);
        assert.equal(h.room.whipReconnecting, true);
        assert.notEqual(h.room.whipGraceTimer, null);
        assert.equal(h.hostMetrics.length, metricsBefore + 1, 'the host is told at once');
        assert.deepEqual(h.hostMetrics.at(-1), {
            roomCode: h.room.code, whipConnected: false, whipReconnecting: true, whipSessionId: h.room.whipSessionId,
        });

        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS - 1);
        assert.equal(transport.closed, false, 'the session is kept for the whole grace period');
        t.mock.timers.tick(2);
        assertSessionTornDown(h, transport, resourceId);
    } finally {
        t.mock.timers.reset();
        await h.close();
    }
});

for (const recovered of ['connected', 'completed']) {
    test(`ICE returning to '${recovered}' within the grace period cancels the teardown and restores the connected state`, { concurrency: false }, async (t) => {
        const h = await startWhipHarness(`whip-ice-recovers-${recovered}`, [{}]);
        try {
            const { resourceId, transport } = await startLiveSession(h);

            t.mock.timers.enable({ apis: ['setTimeout'] });
            transport.emit('icestatechange', 'disconnected');
            assert.equal(h.room.whipConnected, false);
            t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS - 1000);
            const metricsBefore = h.hostMetrics.length;

            transport.emit('icestatechange', recovered);
            assert.equal(h.room.whipConnected, true);
            assert.equal(h.room.whipReconnecting, false);
            assert.equal(h.room.whipGraceTimer, null);
            assert.equal(h.hostMetrics.length, metricsBefore + 1, 'the host is told it is back');
            assert.deepEqual(h.hostMetrics.at(-1), {
                roomCode: h.room.code, whipConnected: true, whipReconnecting: false, whipSessionId: h.room.whipSessionId,
            });

            t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS * 2);
            assertSessionLive(h, transport, resourceId);
        } finally {
            t.mock.timers.reset();
            await h.close();
        }
    });
}

test('a second ICE outage after a recovery starts a new grace period', { concurrency: false }, async (t) => {
    const h = await startWhipHarness('whip-ice-second-outage', [{}]);
    try {
        const { resourceId, transport } = await startLiveSession(h);

        t.mock.timers.enable({ apis: ['setTimeout'] });
        transport.emit('icestatechange', 'disconnected');
        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS - 1000);
        transport.emit('icestatechange', 'connected');
        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS - 1000);
        assertSessionLive(h, transport, resourceId);

        transport.emit('icestatechange', 'disconnected');
        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS - 1000);
        assert.equal(transport.closed, false, 'the first outage\'s deadline is gone');
        t.mock.timers.tick(1001);
        assertSessionTornDown(h, transport, resourceId);
    } finally {
        t.mock.timers.reset();
        await h.close();
    }
});

test('ICE disconnecting while produce() is pending still lets the session go live, but disconnected until ICE returns', { concurrency: false }, async (t) => {
    const pendingVideo = deferred();
    const h = await startWhipHarness('whip-ice-disconnect-mid-produce', [
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
        transport.emit('icestatechange', 'disconnected');
        pendingVideo.resolve();
        await flush();
        assert.equal(h.room.whipProducer, transport.producers[0], 'the producers are committed');
        assert.equal(h.room.whipConnected, false, 'a session whose ICE is down is not marked connected');
        assert.equal(h.room.whipReconnecting, true);
        assert.notEqual(h.room.whipGraceTimer, null);

        transport.emit('icestatechange', 'connected');
        assert.equal(h.room.whipConnected, true);
        assert.equal(h.room.whipReconnecting, false);
        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS * 2);
        assertSessionLive(h, transport, resourceId);
    } finally {
        t.mock.timers.reset();
        pendingVideo.resolve();
        await h.close();
    }
});

test('ICE recovery does not undo a DTLS failure: the grace period still closes the session', { concurrency: false }, async (t) => {
    const h = await startWhipHarness('whip-ice-recovery-after-dtls-failed', [{}]);
    try {
        const { resourceId, transport } = await startLiveSession(h);

        t.mock.timers.enable({ apis: ['setTimeout'] });
        transport.emit('dtlsstatechange', 'failed');
        transport.emit('icestatechange', 'connected');
        assert.equal(h.room.whipConnected, false);
        assert.equal(h.room.whipReconnecting, true);
        assert.notEqual(h.room.whipGraceTimer, null);

        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS + 1);
        assertSessionTornDown(h, transport, resourceId);
    } finally {
        t.mock.timers.reset();
        await h.close();
    }
});

test('a WHIP session whose DTLS never connects after the 201 is closed when the establishment timeout expires', { concurrency: false }, async (t) => {
    const h = await startWhipHarness('whip-establish-timeout', [{}]);
    try {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const response = await h.post();
        assert.equal(response.status, 201);
        const resourceId = h.resourceIdOf(response);
        const [transport] = h.transports;
        assert.ok(h.room.whipEstablishTimer, 'the timer runs once the 201 is out');
        const metricsBefore = h.hostMetrics.length;

        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS - 1);
        assert.equal(transport.closed, false, 'the session has the whole timeout to establish');
        assert.equal(sessionRegistry.roomCodeForWhipResource(resourceId), h.room.code);
        t.mock.timers.tick(2);

        assertSessionTornDown(h, transport, resourceId);
        assert.equal(h.room.whipEstablishTimer, null);
        assert.equal(h.hostMetrics.length, metricsBefore + 1, 'the host is told once');
        assert.deepEqual(transport.producers, []);
        assert.deepEqual(h.relayStarts, []);
    } finally {
        t.mock.timers.reset();
        await h.close();
    }
});

test('DTLS connecting stops the establishment timer, so a session that went live is not closed by it', { concurrency: false }, async (t) => {
    const h = await startWhipHarness('whip-establish-timer-cleared-by-dtls', [{}]);
    try {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const response = await h.post();
        assert.equal(response.status, 201);
        const resourceId = h.resourceIdOf(response);
        const [transport] = h.transports;
        assert.ok(h.room.whipEstablishTimer);

        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS - 1000);
        transport.emit('dtlsstatechange', 'connected');
        await flush();
        assert.equal(h.room.whipEstablishTimer, null);
        assert.equal(h.room.whipConnected, true);

        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS * 2);
        assertSessionLive(h, transport, resourceId);
    } finally {
        t.mock.timers.reset();
        await h.close();
    }
});

test('the establishment timer does not outlive the session: closeWhipSession and the OBS DELETE clear it', { concurrency: false }, async (t) => {
    const h = await startWhipHarness('whip-establish-timer-cleared-by-close', [{}, {}]);
    try {
        t.mock.timers.enable({ apis: ['setTimeout'] });

        const first = await h.post();
        assert.equal(first.status, 201);
        assert.ok(h.room.whipEstablishTimer);
        closeWhipSession(h.room);
        assert.equal(h.room.whipEstablishTimer, null);

        const second = await h.post();
        assert.equal(second.status, 201);
        assert.ok(h.room.whipEstablishTimer);
        const deleted = await h.delete(h.resourceIdOf(second));
        assert.equal(deleted.status, 200);
        assert.equal(h.room.whipEstablishTimer, null);
        assert.equal(h.room.whipSessionId, null);
        assert.deepEqual(h.resourcesForRoom(), []);
        assert.equal(h.transports[1].closed, true);

        const metricsBefore = h.hostMetrics.length;
        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS * 2);
        assert.equal(h.hostMetrics.length, metricsBefore, 'no timer fires for a session that is gone');
    } finally {
        t.mock.timers.reset();
        await h.close();
    }
});

test('a replaced session\'s establishment timer never closes the session that replaced it', { concurrency: false }, async (t) => {
    const h = await startWhipHarness('whip-establish-timer-replaced', [{}, {}]);
    try {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const first = await h.post();
        assert.equal(first.status, 201);
        const [staleTransport] = h.transports;

        // OBS retries before the first offer ever connected
        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS - 1000);
        const { resourceId, transport } = await startLiveSession(h);
        assert.equal(staleTransport.closed, true);
        assert.notEqual(transport, staleTransport);

        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS * 2);
        assertSessionLive(h, transport, resourceId);
    } finally {
        t.mock.timers.reset();
        await h.close();
    }
});

test('a replaced session\'s grace timer never closes the session that replaced it', { concurrency: false }, async (t) => {
    const h = await startWhipHarness('whip-grace-timer-replaced', [{}, {}]);
    try {
        const { transport: staleTransport } = await startLiveSession(h);
        t.mock.timers.enable({ apis: ['setTimeout'] });
        staleTransport.emit('icestatechange', 'disconnected');
        assert.notEqual(h.room.whipGraceTimer, null);

        // OBS reconnects with a new POST while the old session is in its grace period
        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS - 1000);
        const replacement = await h.post();
        assert.equal(replacement.status, 201);
        const liveTransport = h.transports.at(-1);
        liveTransport.emit('dtlsstatechange', 'connected');
        await flush();
        assert.equal(staleTransport.closed, true);
        assert.equal(h.room.whipGraceTimer, null);

        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS * 2);
        assertSessionLive(h, liveTransport, h.resourceIdOf(replacement));
    } finally {
        t.mock.timers.reset();
        await h.close();
    }
});

test('ICE flapping before DTLS connects leaves no grace period or reconnecting flag behind once ICE is back', { concurrency: false }, async (t) => {
    const h = await startWhipHarness('whip-ice-flap-before-dtls', [{}]);
    try {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const response = await h.post();
        assert.equal(response.status, 201);
        const resourceId = h.resourceIdOf(response);
        const [transport] = h.transports;

        transport.emit('icestatechange', 'connected');
        t.mock.timers.tick(5000);
        transport.emit('icestatechange', 'disconnected');
        assert.equal(h.room.whipReconnecting, true);
        t.mock.timers.tick(3000);
        transport.emit('icestatechange', 'connected');
        assert.equal(h.room.whipReconnecting, false);
        assert.equal(h.room.whipGraceTimer, null);

        // DTLS completes inside the establishment timeout, and the flap leaves nothing behind
        t.mock.timers.tick(2000);
        transport.emit('dtlsstatechange', 'connected');
        await flush();
        t.mock.timers.tick(config.WHIP_GRACE_TIMEOUT_MS * 2);
        assertSessionLive(h, transport, resourceId);
    } finally {
        t.mock.timers.reset();
        await h.close();
    }
});

// Raw SPS/PPS and sprop as an earlier session's stream capture left them on the room.
function seedPreviousSessionParameterSets(room) {
    room.fallbackH264Sprop = 'c3BzLXByZXZpb3Vz,cHBzLXByZXZpb3Vz';
    room.fallbackH264Sps = Buffer.from([0x67, 0x42, 0xe0, 0x1f]);
    room.fallbackH264Pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
}

test('closeWhipSession clears the SPS/PPS and sprop a session captured', { concurrency: false }, async () => {
    const h = await startWhipHarness('whip-close-clears-sps', [{}]);
    try {
        seedPreviousSessionParameterSets(h.room);
        closeWhipSession(h.room);
        assert.equal(h.room.fallbackH264Sprop, null);
        assert.equal(h.room.fallbackH264Sps, null);
        assert.equal(h.room.fallbackH264Pps, null);
    } finally {
        await h.close();
    }
});

test('a new WHIP session whose offer carries sprop starts its fallback relay without the previous session\'s SPS/PPS', { concurrency: false }, async () => {
    const h = await startWhipHarness('whip-new-session-no-old-sps', [{}]);
    const relayInputs = [];
    try {
        seedPreviousSessionParameterSets(h.room);
        setMediaLifecycle({
            startFallbackRelay: async (room) => {
                relayInputs.push({ sprop: room.fallbackH264Sprop, sps: room.fallbackH264Sps, pps: room.fallbackH264Pps });
            },
        });
        const response = await h.post();
        assert.equal(response.status, 201);
        const [transport] = h.transports;
        transport.emit('dtlsstatechange', 'connected');
        await flush();
        assert.equal(relayInputs.length, 1, 'the fallback relay is prewarmed once');
        assert.deepEqual(relayInputs[0], {
            sprop: 'Z0LgH9oBQBbsBEAAAAMAQAAADyPGDKA=,aM4G4g==',
            sps: null,
            pps: null,
        });
    } finally {
        await h.close();
    }
});

// An RTP packet carrying SPS and PPS in one STAP-A aggregate.
function spsPpsRtpPacket() {
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x1f, 0xda, 0x01, 0x40, 0x16, 0xe8, 0x40]);
    const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
    const head = Buffer.alloc(12);
    head[0] = 0x80;
    head[1] = 96;
    return Buffer.concat([head, Buffer.from([0x78, 0x00, sps.length]), sps, Buffer.from([0x00, pps.length]), pps]);
}

test('a sprop stream capture whose producer was replaced writes no SPS/PPS to the room and stops', { concurrency: false }, async () => {
    const directConsumers = [];
    const mediasoupRouter = {
        createDirectTransport: async () => ({
            consume: async () => {
                const consumer = new EventEmitter();
                consumer.closed = false;
                consumer.requestKeyFrame = async () => {};
                consumer.close = () => { consumer.closed = true; };
                directConsumers.push(consumer);
                return consumer;
            },
            close() {},
        }),
    };
    const h = await startWhipHarness('whip-capture-replaced-producer', [{}], mediasoupRouter);
    try {
        // An offer without sprop-parameter-sets, so the capture runs after the session connects.
        const response = await h.post(undefined, obsOffer());
        assert.equal(response.status, 201);
        h.transports[0].emit('dtlsstatechange', 'connected');
        await flush();
        await waitFor(() => directConsumers.length === 1, 'the sprop stream capture to consume the producer');
        await flush();
        const [consumer] = directConsumers;

        // The session is replaced while the capture is still listening.
        closeWhipSession(h.room);
        consumer.emit('rtp', spsPpsRtpPacket());
        await flush();

        assert.equal(h.room.fallbackH264Sprop, null);
        assert.equal(h.room.fallbackH264Sps, null);
        assert.equal(h.room.fallbackH264Pps, null);
        assert.equal(consumer.closed, true, 'the stale capture is stopped');
    } finally {
        await h.close();
    }
});

// DELETE needs the host's bearer token, exactly as POST does.
async function startLiveSessionWithRelay(hostId) {
    const h = await startWhipHarness(hostId, [{}]);
    const { resourceId, transport } = await startLiveSession(h);
    const relay = { stops: 0, stop() { relay.stops += 1; } };
    h.room.fallbackWorker = relay;
    const metricsBefore = h.hostMetrics.length;
    return {
        h,
        resourceId,
        transport,
        relay,
        assertUntouched() {
            assertSessionLive(h, transport, resourceId);
            assert.equal(relay.stops, 0, 'the fallback relay is not stopped');
            assert.equal(h.room.fallbackWorker, relay, 'the fallback relay stays on the room');
            assert.deepEqual(h.resourcesForRoom(), [resourceId], 'the WHIP resource stays registered');
            assert.equal(h.room.whipSessionId !== null, true);
            assert.equal(h.hostMetrics.length, metricsBefore, 'the host is not told of a teardown');
        },
    };
}

for (const [name, headersFor] of [
    ['no Authorization header', () => ({})],
    ['an empty bearer token', () => ({ Authorization: 'Bearer ' })],
    ['a wrong bearer token', () => ({ Authorization: 'Bearer not-the-host-token' })],
    ['a bearer token of the right length that is wrong', (room) => ({ Authorization: `Bearer ${'x'.repeat(room.hostToken.length)}` })],
    ['the host token without the Bearer scheme', (room) => ({ Authorization: room.hostToken })],
    ['the host token under another scheme', (room) => ({ Authorization: `Basic ${room.hostToken}` })],
]) {
    test(`WHIP DELETE with ${name} gets 403 and leaves the session, relay and registry alone`, { concurrency: false }, async () => {
        const { h, resourceId, assertUntouched } = await startLiveSessionWithRelay(`whip-delete-refused-${name.replace(/\W+/g, '-')}`);
        try {
            const response = await h.delete(resourceId, headersFor(h.room));
            assert.equal(response.status, 403);
            assert.deepEqual(await response.json(), { error: 'Invalid or missing authorization token' });
            assert.equal(response.headers.get('access-control-allow-methods'), 'POST, DELETE, OPTIONS');
            assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');
            assertUntouched();
        } finally {
            await h.close();
        }
    });
}

test('WHIP DELETE with another room\'s host token gets 403 and leaves the session alone', { concurrency: false }, async () => {
    const { h, resourceId, assertUntouched } = await startLiveSessionWithRelay('whip-delete-other-rooms-token');
    const other = await createRoom('whip-delete-other-room', { ingestMode: 'obs' });
    try {
        assert.notEqual(other.hostToken, h.room.hostToken);
        const response = await h.delete(resourceId, { Authorization: `Bearer ${other.hostToken}` });
        assert.equal(response.status, 403);
        assertUntouched();
    } finally {
        destroyRoom(other.code);
        await h.close();
    }
});

test('WHIP DELETE with the host token returns 200 { ok: true } and tears the session down, once', { concurrency: false }, async () => {
    const { h, resourceId, transport, relay } = await startLiveSessionWithRelay('whip-delete-authorized');
    try {
        // A refused attempt first: the same resource is still there for the host to delete.
        assert.equal((await h.delete(resourceId, {})).status, 403);

        const response = await h.delete(resourceId);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
        assert.equal(response.headers.get('access-control-allow-methods'), 'POST, DELETE, OPTIONS');
        assert.equal(transport.closed, true, 'the transport is closed');
        for (const producer of transport.producers) assert.equal(producer.closed, true, `${producer.kind} producer is closed`);
        assert.equal(h.room.whipTransport, null);
        assert.equal(h.room.whipProducer, null);
        assert.equal(h.room.whipAudioProducer, null);
        assert.equal(h.room.whipSessionId, null);
        assert.equal(h.room.whipResourceId, null);
        assert.equal(h.room.whipConnected, false);
        assert.equal(sessionRegistry.roomCodeForWhipResource(resourceId), null, 'the WHIP resource is unregistered');
        assert.equal(relay.stops, 1, 'the fallback relay is stopped');
        assert.equal(h.room.fallbackWorker, null);
        assert.deepEqual(h.resourcesForRoom(), []);

        const again = await h.delete(resourceId);
        assert.equal(again.status, 404, 'the resource is gone after the delete');
    } finally {
        await h.close();
    }
});

// Host metrics after a WHIP DELETE: the host page learns that OBS is gone from the metrics event, as it does
// for every other teardown (ICE, DTLS, timers), instead of showing a live ingest until the next broadcast.
test('WHIP DELETE with the host token emits host metrics for that room once, after the teardown', { concurrency: false }, async () => {
    const { h, resourceId } = await startLiveSessionWithRelay('whip-delete-host-metrics');
    try {
        const metricsBefore = h.hostMetrics.length;
        const response = await h.delete(resourceId);
        assert.equal(response.status, 200);
        assert.deepEqual(h.hostMetrics.slice(metricsBefore), [{
            roomCode: h.room.code, whipConnected: false, whipReconnecting: false, whipSessionId: null,
        }], 'one metrics emit for the room, made after the session was torn down');

        // A repeated DELETE finds no session and tells no one.
        assert.equal((await h.delete(resourceId)).status, 404);
        assert.equal(h.hostMetrics.length, metricsBefore + 1);
    } finally {
        await h.close();
    }
});

test('a WHIP DELETE that is refused or finds no session emits no host metrics', { concurrency: false }, async () => {
    const { h, resourceId, assertUntouched } = await startLiveSessionWithRelay('whip-delete-no-host-metrics');
    const metricsBefore = h.hostMetrics.length;
    sessionRegistry.registerWhipResource('stale-metrics-resource-id', h.room.code);
    sessionRegistry.registerWhipResource('orphan-metrics-resource-id', 'NOROOM');
    try {
        for (const headers of [{}, { Authorization: 'Bearer not-the-host-token' }]) {
            assert.equal((await h.delete(resourceId, headers)).status, 403);
        }
        for (const id of ['no-such-resource', 'stale-metrics-resource-id', 'orphan-metrics-resource-id']) {
            assert.equal((await h.delete(id)).status, 404);
        }
        assert.equal(h.hostMetrics.length, metricsBefore, 'no metrics were emitted');
        // Only the registrations this test added are left over; the live session itself is untouched.
        sessionRegistry.unregisterWhipResource('stale-metrics-resource-id');
        assertUntouched();
    } finally {
        sessionRegistry.unregisterWhipResource('stale-metrics-resource-id');
        sessionRegistry.unregisterWhipResource('orphan-metrics-resource-id');
        await h.close();
    }
});

test('WHIP DELETE answers 404 for an unknown or stale resource without asking for a token', { concurrency: false }, async () => {
    const { h, resourceId, assertUntouched } = await startLiveSessionWithRelay('whip-delete-unknown-resource');
    sessionRegistry.registerWhipResource('stale-resource-id', h.room.code);
    try {
        for (const headers of [{}, { Authorization: 'Bearer not-the-host-token' }, { Authorization: `Bearer ${h.room.hostToken}` }]) {
            const unknown = await h.delete('no-such-resource', headers);
            assert.equal(unknown.status, 404);
            assert.deepEqual(await unknown.json(), { error: 'WHIP session not found' });
            assert.equal(unknown.headers.get('access-control-allow-methods'), 'POST, DELETE, OPTIONS');

            // Registered for the room but no longer the room's session: also 404, and the live session is untouched.
            const stale = await h.delete('stale-resource-id', headers);
            assert.equal(stale.status, 404);
            assert.deepEqual(await stale.json(), { error: 'WHIP session not found' });
        }
        sessionRegistry.unregisterWhipResource('stale-resource-id');
        assertUntouched();
        assert.equal(h.room.whipResourceId, resourceId);
    } finally {
        sessionRegistry.unregisterWhipResource('stale-resource-id');
        await h.close();
    }
});

// ── Public WHIP rate limiting keeps bounded state and buckets by the trusted client ──

const { createClientRateLimiter, rateLimitBucketKey, MAX_TRACKED_RATE_LIMIT_CLIENTS } = require('../lib/whipRoutes');

/** A clock the test moves by hand, in place of Date.now. */
function manualClock(start = 1_000_000) {
    const clock = { value: start, now: () => clock.value, advance: (ms) => { clock.value += ms; } };
    return clock;
}

function overridePublicWhipConfig(t, values) {
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, config[key]]));
    Object.assign(config, values);
    t.after(() => Object.assign(config, previous));
}

function makeLimiter(clock, { max = 2, windowMs = 100, maxTracked = 3 } = {}) {
    return createClientRateLimiter({
        getMax: () => max,
        getWindowMs: () => windowMs,
        maxTracked,
        now: clock.now,
    });
}

test('the client rate limiter limits one address after max attempts in a window and counts a new window afresh', () => {
    const clock = manualClock();
    const limiter = makeLimiter(clock, { max: 2, windowMs: 100, maxTracked: 10 });
    assert.equal(limiter.isLimited('198.51.100.1'), false);
    assert.equal(limiter.isLimited('198.51.100.1'), false);
    assert.equal(limiter.isLimited('198.51.100.1'), true);
    assert.equal(limiter.isLimited('198.51.100.2'), false, 'another address has its own budget');
    clock.advance(100);
    assert.equal(limiter.isLimited('198.51.100.1'), true, 'the window ends after resetAt, not at it');
    clock.advance(1);
    assert.equal(limiter.isLimited('198.51.100.1'), false, 'a new window starts with a fresh count');
});

test('a flood of distinct addresses never leaves the limiter holding more than its cap', () => {
    const clock = manualClock();
    const limiter = makeLimiter(clock, { max: 5, windowMs: 60_000, maxTracked: 50 });
    for (let i = 0; i < 500; i += 1) {
        limiter.isLimited(`2001:db8:${i.toString(16)}::1`);
        clock.advance(1);
        assert.ok(limiter.size <= 50, `after ${i + 1} distinct addresses the limiter held ${limiter.size}`);
    }
    assert.equal(limiter.size, 50);

    // The default cap is a named constant of about ten thousand.
    assert.equal(MAX_TRACKED_RATE_LIMIT_CLIENTS, 10_000);
    const defaulted = createClientRateLimiter({ getMax: () => 1, getWindowMs: () => 60_000, now: clock.now });
    for (let i = 0; i < MAX_TRACKED_RATE_LIMIT_CLIENTS + 25; i += 1) defaulted.isLimited(`ip-${i}`);
    assert.equal(defaulted.size, MAX_TRACKED_RATE_LIMIT_CLIENTS);
});

test('expired entries are pruned after the window without their addresses returning', () => {
    const clock = manualClock();
    const limiter = makeLimiter(clock, { max: 2, windowMs: 100, maxTracked: 1000 });
    for (let i = 0; i < 20; i += 1) limiter.isLimited(`198.51.100.${i}`);
    assert.equal(limiter.size, 20);

    clock.advance(50);
    limiter.isLimited('203.0.113.1');
    assert.equal(limiter.size, 21, 'nothing has expired yet');

    clock.advance(51);
    limiter.isLimited('203.0.113.2');
    assert.equal(limiter.size, 2, 'the 20 expired addresses went; the two live ones stayed');
});

test('at the cap the limiter evicts an expired entry before a live one', () => {
    const clock = manualClock();
    const limiter = makeLimiter(clock, { max: 1, windowMs: 100, maxTracked: 2 });
    limiter.isLimited('a');       // t+0, window to t+100
    clock.advance(40);
    limiter.isLimited('b');       // t+40, window to t+140
    clock.advance(60);
    limiter.isLimited('b');       // t+100: the periodic sweep runs here and finds nothing expired
    clock.advance(1);
    limiter.isLimited('c');       // t+101: full, and a has expired; only the cap can make room, so a goes and b stays
    assert.equal(limiter.size, 2);
    assert.equal(limiter.isLimited('b'), true, 'the live entry kept its count');
    assert.equal(limiter.isLimited('c'), true, 'the new entry counted its first attempt');
});

test('at the cap with every entry live the limiter evicts the oldest, and a window reset makes an entry the newest', () => {
    const clock = manualClock();
    const limiter = makeLimiter(clock, { max: 1, windowMs: 100, maxTracked: 2 });
    limiter.isLimited('a');     // t+0, window to t+100
    clock.advance(10);
    limiter.isLimited('b');     // t+10, window to t+110
    clock.advance(95);          // a expired, b still live
    assert.equal(limiter.isLimited('a'), false, 'a returned after its window: reset, and now the newest entry');
    clock.advance(1);
    limiter.isLimited('c');     // full with b (live until t+110) and a (reset): b is the oldest
    assert.equal(limiter.size, 2);
    assert.equal(limiter.isLimited('a'), true, 'a, reset after b, was kept');
    assert.equal(limiter.isLimited('b'), false, 'b was the oldest and was evicted, so it counts afresh');
});

test('the limiter buckets IPv6 clients by their /64 and leaves other identities as they are', () => {
    assert.equal(rateLimitBucketKey('2001:db8:1:2:3:4:5:6'), rateLimitBucketKey('2001:db8:1:2::ffff'));
    assert.equal(rateLimitBucketKey('2001:DB8:1:2:aaaa:bbbb:cccc:dddd'), rateLimitBucketKey('2001:db8:1:2::1'));
    assert.notEqual(rateLimitBucketKey('2001:db8:1:2::1'), rateLimitBucketKey('2001:db8:1:3::1'));
    assert.equal(rateLimitBucketKey('2001:db8::1'), rateLimitBucketKey('2001:db8:0:0:9::1'));
    assert.equal(rateLimitBucketKey('fe80::1%eth0'), rateLimitBucketKey('fe80::2'));
    assert.equal(rateLimitBucketKey('64:ff9b::198.51.100.7'), rateLimitBucketKey('64:ff9b::1'));
    assert.equal(rateLimitBucketKey('::ffff:198.51.100.7'), '198.51.100.7', 'an IPv4-mapped address is that IPv4 address, not one shared /64');
    assert.equal(rateLimitBucketKey('::ffff:c633:6407'), '198.51.100.7');
    for (const other of ['198.51.100.7', 'unknown', 'public-share-proxy', 'public-share:203.0.113.9', '']) {
        assert.equal(rateLimitBucketKey(other), other);
    }

    const clock = manualClock();
    const limiter = makeLimiter(clock, { max: 1, windowMs: 100, maxTracked: 10 });
    assert.equal(limiter.isLimited('2001:db8:1:2::1'), false);
    assert.equal(limiter.isLimited('2001:db8:1:2:dead:beef::7'), true, 'a second address of the same /64 shares the first one\'s budget');
    assert.equal(limiter.size, 1);
    assert.equal(limiter.isLimited('2001:db8:1:3::1'), false, 'another /64 has its own');
});

test('the public WHIP router drops the oldest tracked address at its cap and keeps limiting the others', { concurrency: false }, async (t) => {
    overridePublicWhipConfig(t, {
        WHIP_ENABLED: true,
        PUBLIC_WHIP_ENABLED: true,
        PUBLIC_WHIP_RATE_LIMIT_MAX: 1,
        PUBLIC_WHIP_RATE_LIMIT_WINDOW_MS: 600_000,
    });
    const app = express();
    app.use('/whip', createWhipRouter({}, {
        publicEndpoint: true,
        getClientIp: (req) => req.headers['x-test-ip'] || 'unknown',
        maxTrackedClients: 2,
    }));
    const { server, baseUrl } = await listen(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    // No room has this code: 404 is past the limit (and before authentication), 429 is the per-IP limit.
    const post = (ip) => fetch(`${baseUrl}/whip/broadcast/ZZZZZZ`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', Authorization: 'Bearer unused-token', 'x-test-ip': ip },
        body: VIDEO_OFFER,
    }).then((response) => response.status);

    assert.equal(await post('198.51.100.1'), 404);
    assert.equal(await post('198.51.100.1'), 429, 'the second attempt inside the window is limited');
    assert.equal(await post('198.51.100.2'), 404);
    assert.equal(await post('198.51.100.3'), 404, 'a third address pushes the cap, so the oldest (198.51.100.1) is dropped');
    assert.equal(await post('198.51.100.1'), 404, 'the dropped address counts afresh: the map holds at most two addresses');
    assert.equal(await post('198.51.100.3'), 429, 'an address that stayed tracked is still limited');
});

async function startFallbackPublicRouter(t) {
    const app = express();
    // No getClientIp option: the router resolves the client itself.
    app.use('/whip', createWhipRouter({}, { publicEndpoint: true }));
    const { server, baseUrl } = await listen(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    // 404 is a missing room, past the limit; 429 is the per-IP limit.
    return (headers) => fetch(`${baseUrl}/whip/broadcast/ZZZZZZ`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', Authorization: 'Bearer unused-token', ...headers },
        body: VIDEO_OFFER,
    }).then((response) => response.status);
}

test('the public WHIP router\'s own IP fallback buckets by the client behind TRUST_PROXY proxies, not by the proxy', { concurrency: false }, async (t) => {
    overridePublicWhipConfig(t, {
        WHIP_ENABLED: true,
        PUBLIC_WHIP_ENABLED: true,
        PUBLIC_WHIP_RATE_LIMIT_MAX: 1,
        PUBLIC_WHIP_RATE_LIMIT_WINDOW_MS: 600_000,
        TRUST_X_FORWARDED_HEADERS: true,
        TRUST_PROXY: 2,
        TRUST_CLOUDFLARE_CONNECTING_IP: false,
    });
    const post = await startFallbackPublicRouter(t);

    assert.equal(await post({ 'x-forwarded-for': '198.51.100.41, 10.0.0.2' }), 404);
    assert.equal(await post({ 'x-forwarded-for': '198.51.100.42, 10.0.0.2' }), 404, 'a second client behind the same proxies shared the first one\'s bucket');
    assert.equal(await post({ 'x-forwarded-for': '203.0.113.98, 198.51.100.41, 10.0.0.3' }), 429, 'a spoofed leftmost entry gave the first client a fresh bucket');
    assert.equal(await post({ 'x-forwarded-for': '198.51.100.41, 10.0.0.2', 'cf-connecting-ip': '198.51.100.43' }), 429, 'CF-Connecting-IP chose the client with the flag off');
    config.TRUST_CLOUDFLARE_CONNECTING_IP = true;
    assert.equal(await post({ 'x-forwarded-for': '198.51.100.41, 10.0.0.2', 'cf-connecting-ip': '198.51.100.44' }), 404, 'CF-Connecting-IP was ignored with the flag on');
});

test('the public WHIP router\'s own IP fallback uses the connecting address when no proxy is trusted', { concurrency: false }, async (t) => {
    overridePublicWhipConfig(t, {
        WHIP_ENABLED: true,
        PUBLIC_WHIP_ENABLED: true,
        PUBLIC_WHIP_RATE_LIMIT_MAX: 1,
        PUBLIC_WHIP_RATE_LIMIT_WINDOW_MS: 600_000,
        TRUST_X_FORWARDED_HEADERS: false,
        TRUST_CLOUDFLARE_CONNECTING_IP: true,
    });
    const post = await startFallbackPublicRouter(t);

    assert.equal(await post({ 'x-forwarded-for': '198.51.100.41' }), 404);
    assert.equal(await post({ 'x-forwarded-for': '198.51.100.42', 'cf-connecting-ip': '198.51.100.43' }), 429, 'forwarded headers named the client although they are not trusted');
});
