const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const config = require('../config');
const { createRoom, destroyRoom } = require('../lib/rooms');
const { createWhepRouter } = require('../lib/whepRoutes');
const { sessionRegistry } = require('../lib/sessionRegistry');

const VIDEO_PLUS_AUDIO_OFFER = [
    'v=0',
    'o=- 123456 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1',
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
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=mid:1',
    'a=recvonly',
    'a=rtcp-mux',
    'a=rtpmap:111 opus/48000/2',
    '',
].join('\r\n');

const VIDEO_ONLY_OFFER = [
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

const NO_FINGERPRINT_OFFER = [
    'v=0',
    'o=- 123456 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
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

const UNSUPPORTED_CODEC_OFFER = [
    'v=0',
    'o=- 123456 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    'a=setup:actpass',
    'a=ice-ufrag:testufrag',
    'a=ice-pwd:testpwd1234567890123456',
    'm=video 9 UDP/TLS/RTP/SAVPF 97',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=recvonly',
    'a=rtcp-mux',
    'a=rtpmap:97 VP8/90000',
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

/**
 * Split an SDP into its session-level lines and its media sections.
 * A section is { mline, lines }: the 'm=' line and the lines up to the next one.
 * Lines are split on CRLF only, so an answer that uses bare LF stays one line and fails.
 */
function splitSdp(sdp) {
    const session = [];
    const sections = [];
    let current = null;
    for (const line of sdp.split('\r\n')) {
        if (line === '') continue;
        if (line.startsWith('m=')) {
            current = { mline: line, lines: [] };
            sections.push(current);
        } else if (current) {
            current.lines.push(line);
        } else {
            session.push(line);
        }
    }
    return { session, sections };
}

/** The media kind and port of an 'm=<kind> <port> ...' line. */
function parseMline(mline) {
    const match = mline.match(/^m=(\S+) (\d+) /);
    assert.ok(match, `malformed m-line: ${mline}`);
    return { kind: match[1], port: Number(match[2]) };
}

/** The values of every 'a=<name>:<value>' line in a list, in order. */
function attributeValues(lines, name) {
    const prefix = `a=${name}:`;
    return lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
}

/** The direction attributes of a section (sendrecv, sendonly, recvonly, inactive). */
function directionLines(lines) {
    return lines.filter((line) => /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line));
}

/** The a=setup value a section answers with: its own, or the session-level one. */
function effectiveSetup(session, section) {
    const own = attributeValues(section.lines, 'setup');
    assert.ok(own.length <= 1, `section has more than one a=setup line: ${own.join(', ')}`);
    if (own.length === 1) return own[0];
    const inherited = attributeValues(session, 'setup');
    return inherited.length === 1 ? inherited[0] : undefined;
}

function createConfigurableHarness({
    onFactory = null,
    connectFails = false,
    canConsumeVideo = true,
    canConsumeAudio = true,
    videoConsumeFails = false,
    audioConsumeFails = false,
    videoResumeFails = false,
} = {}) {
    const stats = {
        factoryCalls: 0,
        factoryOptions: [],
        transportsCreated: 0,
        transportCloses: 0,
        connectedDtls: null,
        videoConsumer: null,
        audioConsumer: null,
        videoCloses: 0,
        audioCloses: 0,
        videoResumes: 0,
        audioResumes: 0,
    };

    const mediasoupRouter = {
        rtpCapabilities: {
            codecs: [
                {
                    kind: 'video',
                    mimeType: 'video/H264',
                    preferredPayloadType: 96,
                    clockRate: 90000,
                    parameters: { 'profile-level-id': '42e01f', 'packetization-mode': 1 },
                    rtcpFeedback: [],
                },
                {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    preferredPayloadType: 111,
                    clockRate: 48000,
                    channels: 2,
                    parameters: {},
                    rtcpFeedback: [],
                },
            ],
            headerExtensions: [],
        },
        canConsume: ({ producerId }) => {
            if (producerId === 'prod-video') return canConsumeVideo;
            if (producerId === 'prod-audio') return canConsumeAudio;
            return true;
        },
    };

    const createWebRtcTransport = async (routerInstance, options) => {
        stats.factoryCalls += 1;
        stats.factoryOptions.push(options);
        if (onFactory) {
            await onFactory(options);
        }

        stats.transportsCreated += 1;
        const transport = new EventEmitter();
        transport.id = `transport-${stats.transportsCreated}`;
        transport.close = () => { stats.transportCloses += 1; };
        transport.connect = async ({ dtlsParameters }) => {
            stats.connectedDtls = dtlsParameters;
            if (connectFails) throw new Error('Injected transport.connect failure');
        };
        transport.consume = async ({ producerId, paused }) => {
            if (producerId === 'prod-video') {
                if (videoConsumeFails) throw new Error('Injected video consume failure');
                const c = new EventEmitter();
                c.id = 'consumer-video-1';
                c.kind = 'video';
                c.paused = paused;
                c.rtpParameters = {
                    codecs: [{
                        payloadType: 96,
                        mimeType: 'video/H264',
                        clockRate: 90000,
                        parameters: { 'profile-level-id': '42e01f', 'packetization-mode': 1 },
                        rtcpFeedback: [],
                    }],
                    headerExtensions: [],
                    encodings: [{ ssrc: 11111111 }],
                };
                c.resume = async () => {
                    stats.videoResumes += 1;
                    if (videoResumeFails) throw new Error('Injected video resume failure');
                    c.paused = false;
                };
                c.close = () => { stats.videoCloses += 1; };
                stats.videoConsumer = c;
                return c;
            }
            if (producerId === 'prod-audio') {
                if (audioConsumeFails) throw new Error('Injected audio consume failure');
                const c = new EventEmitter();
                c.id = 'consumer-audio-1';
                c.kind = 'audio';
                c.paused = paused;
                c.rtpParameters = {
                    codecs: [{
                        payloadType: 111,
                        mimeType: 'audio/opus',
                        clockRate: 48000,
                        channels: 2,
                        parameters: {},
                        rtcpFeedback: [],
                    }],
                    headerExtensions: [],
                    encodings: [{ ssrc: 22222222 }],
                };
                c.resume = async () => {
                    stats.audioResumes += 1;
                    c.paused = false;
                };
                c.close = () => { stats.audioCloses += 1; };
                stats.audioConsumer = c;
                return c;
            }
            throw new Error(`Unknown producer ${producerId}`);
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

test('WHEP POST success with video and audio asserts contract, registration, and clean lifecycle', { concurrency: false }, async () => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobalPending = sessionRegistry.pendingWhepGlobal;
    const initialGlobalActive = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createConfigurableHarness();
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-success-ip-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('whep-success-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };
        room.audioProducer = { id: 'prod-audio', closed: false, close() {} };

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_PLUS_AUDIO_OFFER,
        });

        assert.equal(res.status, 201);
        assert.match(res.headers.get('content-type'), /^application\/sdp/);
        const location = res.headers.get('location');
        assert.match(location, /^\/whep\/watch\/[0-9a-f]{32}$/);
        const sessionId = location.split('/whep/watch/')[1];

        const sdpAnswer = await res.text();
        assert.match(sdpAnswer, /v=0/);
        assert.match(sdpAnswer, /a=sendonly/);

        // One m-section per offered m-section, in offer order (video mid 0, audio mid 1)
        assert.ok(!/(?<!\r)\n/.test(sdpAnswer), 'answer lines must end in CRLF');
        const { session, sections } = splitSdp(sdpAnswer);
        assert.equal(sections.length, 2);
        assert.equal(session.filter((line) => line.startsWith('a=group:')).length, 1);
        assert.ok(session.includes('a=group:BUNDLE 0 1'), `BUNDLE group: ${session.join(' | ')}`);

        const [videoSection, audioSection] = sections;
        const video = parseMline(videoSection.mline);
        assert.equal(video.kind, 'video');
        assert.notEqual(video.port, 0);
        assert.deepEqual(attributeValues(videoSection.lines, 'mid'), ['0']);
        assert.deepEqual(directionLines(videoSection.lines), ['a=sendonly']);
        assert.ok(videoSection.lines.includes('a=ssrc:11111111 cname:whep'));
        assert.deepEqual(attributeValues(videoSection.lines, 'ssrc').map((v) => v.split(' ')[0]), ['11111111']);

        const audio = parseMline(audioSection.mline);
        assert.equal(audio.kind, 'audio');
        assert.notEqual(audio.port, 0);
        assert.deepEqual(attributeValues(audioSection.lines, 'mid'), ['1']);
        assert.deepEqual(directionLines(audioSection.lines), ['a=sendonly']);
        assert.ok(audioSection.lines.includes('a=ssrc:22222222 cname:whep'));
        assert.deepEqual(attributeValues(audioSection.lines, 'ssrc').map((v) => v.split(' ')[0]), ['22222222']);

        // The remote DTLS role handed to mediasoup is 'client', so the answer is passive
        // wherever it states a setup role, and states one for every section.
        const allSetups = [
            ...attributeValues(session, 'setup'),
            ...sections.flatMap((section) => attributeValues(section.lines, 'setup')),
        ];
        assert.ok(allSetups.length > 0, 'answer states no a=setup');
        assert.deepEqual([...new Set(allSetups)], ['passive']);
        assert.equal(effectiveSetup(session, videoSection), 'passive');
        assert.equal(effectiveSetup(session, audioSection), 'passive');

        assert.deepEqual(stats.factoryOptions, [{ purpose: 'whep' }]);
        assert.ok(stats.connectedDtls);
        assert.equal(stats.connectedDtls.role, 'client');
        assert.equal(stats.videoResumes, 1);
        assert.equal(stats.audioResumes, 1);

        assert.equal(room.whepPendingReservations, 0);
        assert.equal(sessionRegistry.pendingWhepGlobal, 0);
        assert.equal(room.whepSessions.size, 1);
        assert.equal(room.whepViewerCount, 1);
        assert.ok(sessionRegistry.getWhepSession(sessionId));
        assert.equal(sessionRegistry.getWhepSession(sessionId), room.whepSessions.get(sessionId));
    } finally {
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhep;
        await new Promise((resolve) => server.close(resolve));

        assert.equal(stats.transportCloses, 1);
        assert.equal(stats.videoCloses, 1);
        assert.equal(stats.audioCloses, 1);
        assert.equal(sessionRegistry.pendingWhepGlobal, initialGlobalPending);
        assert.equal(sessionRegistry.whepSessions.size, initialGlobalActive);
    }
});

test('failure: offer without DTLS fingerprint returns 400 and releases reservations without transport allocation', { concurrency: false }, async () => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobalPending = sessionRegistry.pendingWhepGlobal;
    const initialGlobalActive = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createConfigurableHarness();
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-nodtls-ip-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('whep-nodtls-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: NO_FINGERPRINT_OFFER,
        });

        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: 'No DTLS fingerprint in offer' });
        assert.equal(stats.factoryCalls, 0);
        assert.equal(room.whepPendingReservations, 0);
        assert.equal(room.whepSessions.size, 0);
        assert.equal(room.whepViewerCount, 0);
    } finally {
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhep;
        await new Promise((resolve) => server.close(resolve));
        assert.equal(sessionRegistry.pendingWhepGlobal, initialGlobalPending);
        assert.equal(sessionRegistry.whepSessions.size, initialGlobalActive);
    }
});

test('failure: no shared video codec returns 415 and releases reservations without transport allocation', { concurrency: false }, async () => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobalPending = sessionRegistry.pendingWhepGlobal;
    const initialGlobalActive = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createConfigurableHarness();
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-nocodec-ip-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('whep-nocodec-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: UNSUPPORTED_CODEC_OFFER,
        });

        assert.equal(res.status, 415);
        assert.deepEqual(await res.json(), { error: 'Viewer offer does not support any video codec the server produces' });
        assert.equal(stats.factoryCalls, 0);
        assert.equal(room.whepPendingReservations, 0);
        assert.equal(room.whepSessions.size, 0);
        assert.equal(room.whepViewerCount, 0);
    } finally {
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhep;
        await new Promise((resolve) => server.close(resolve));
        assert.equal(sessionRegistry.pendingWhepGlobal, initialGlobalPending);
        assert.equal(sessionRegistry.whepSessions.size, initialGlobalActive);
    }
});

test('failure: transport factory rejection returns 500 and releases reservation', { concurrency: false }, async () => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobalPending = sessionRegistry.pendingWhepGlobal;
    const initialGlobalActive = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createConfigurableHarness({
        onFactory: async () => { throw new Error('Factory creation failed'); },
    });
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-factfail-ip-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('whep-factfail-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_ONLY_OFFER,
        });

        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { error: 'Internal server error' });
        assert.equal(stats.factoryCalls, 1);
        assert.equal(room.whepPendingReservations, 0);
        assert.equal(room.whepSessions.size, 0);
        assert.equal(room.whepViewerCount, 0);
    } finally {
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhep;
        await new Promise((resolve) => server.close(resolve));
        assert.equal(sessionRegistry.pendingWhepGlobal, initialGlobalPending);
        assert.equal(sessionRegistry.whepSessions.size, initialGlobalActive);
    }
});

test('failure: transport.connect() rejection returns 500 and closes transport once', { concurrency: false }, async () => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobalPending = sessionRegistry.pendingWhepGlobal;
    const initialGlobalActive = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createConfigurableHarness({
        connectFails: true,
    });
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-connfail-ip-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('whep-connfail-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_ONLY_OFFER,
        });

        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { error: 'Transport connect failed' });
        assert.equal(stats.transportCloses, 1);
        assert.equal(room.whepPendingReservations, 0);
        assert.equal(room.whepSessions.size, 0);
        assert.equal(room.whepViewerCount, 0);
    } finally {
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhep;
        await new Promise((resolve) => server.close(resolve));
        assert.equal(sessionRegistry.pendingWhepGlobal, initialGlobalPending);
        assert.equal(sessionRegistry.whepSessions.size, initialGlobalActive);
    }
});

test('failure: canConsume false for video returns 415 and closes transport', { concurrency: false }, async () => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobalPending = sessionRegistry.pendingWhepGlobal;
    const initialGlobalActive = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createConfigurableHarness({
        canConsumeVideo: false,
    });
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-cantconsume-ip-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('whep-cantconsume-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_ONLY_OFFER,
        });

        assert.equal(res.status, 415);
        assert.deepEqual(await res.json(), { error: 'Cannot consume video producer — codec mismatch with viewer' });
        assert.equal(stats.transportCloses, 1);
        assert.equal(room.whepPendingReservations, 0);
        assert.equal(room.whepSessions.size, 0);
        assert.equal(room.whepViewerCount, 0);
    } finally {
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhep;
        await new Promise((resolve) => server.close(resolve));
        assert.equal(sessionRegistry.pendingWhepGlobal, initialGlobalPending);
        assert.equal(sessionRegistry.whepSessions.size, initialGlobalActive);
    }
});

test('failure: required video consume() rejection returns 500 and closes transport', { concurrency: false }, async () => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobalPending = sessionRegistry.pendingWhepGlobal;
    const initialGlobalActive = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createConfigurableHarness({
        videoConsumeFails: true,
    });
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-vidconsumefail-ip-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('whep-vidconsumefail-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_ONLY_OFFER,
        });

        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { error: 'Internal server error' });
        assert.equal(stats.transportCloses, 1);
        assert.equal(room.whepPendingReservations, 0);
        assert.equal(room.whepSessions.size, 0);
        assert.equal(room.whepViewerCount, 0);
    } finally {
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhep;
        await new Promise((resolve) => server.close(resolve));
        assert.equal(sessionRegistry.pendingWhepGlobal, initialGlobalPending);
        assert.equal(sessionRegistry.whepSessions.size, initialGlobalActive);
    }
});

test('partial failure: audio consume() rejection continues as 201 video-only and resumes video', { concurrency: false }, async () => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobalPending = sessionRegistry.pendingWhepGlobal;
    const initialGlobalActive = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createConfigurableHarness({
        audioConsumeFails: true,
    });
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-audfail-ip-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('whep-audfail-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };
        room.audioProducer = { id: 'prod-audio', closed: false, close() {} };

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_PLUS_AUDIO_OFFER,
        });

        assert.equal(res.status, 201);

        // The answer still has one m-section per offered m-section, in offer order. The
        // audio section whose consume() failed is rejected in place (RFC 3264 section 6),
        // carries no media and stays out of the BUNDLE group.
        const sdpAnswer = await res.text();
        assert.ok(!/(?<!\r)\n/.test(sdpAnswer), 'answer lines must end in CRLF');
        const { session, sections } = splitSdp(sdpAnswer);
        assert.equal(sections.length, 2);
        assert.equal(session.filter((line) => line.startsWith('a=group:')).length, 1);
        assert.ok(session.includes('a=group:BUNDLE 0'), `BUNDLE group: ${session.join(' | ')}`);

        const [videoSection, audioSection] = sections;
        const video = parseMline(videoSection.mline);
        assert.equal(video.kind, 'video');
        assert.notEqual(video.port, 0);
        assert.deepEqual(attributeValues(videoSection.lines, 'mid'), ['0']);
        assert.deepEqual(directionLines(videoSection.lines), ['a=sendonly']);
        assert.deepEqual(attributeValues(videoSection.lines, 'ssrc').map((v) => v.split(' ')[0]), ['11111111']);
        assert.equal(effectiveSetup(session, videoSection), 'passive');

        const audio = parseMline(audioSection.mline);
        assert.equal(audio.kind, 'audio');
        assert.equal(audio.port, 0, `audio section is not rejected: ${audioSection.mline}`);
        assert.deepEqual(attributeValues(audioSection.lines, 'mid'), ['1']);
        assert.deepEqual(directionLines(audioSection.lines), ['a=inactive']);
        assert.ok(!audioSection.lines.some((line) => line.startsWith('a=ssrc')), 'rejected audio section carries an SSRC');
        assert.ok(!audioSection.lines.includes('a=sendonly'));
        for (const setup of attributeValues(audioSection.lines, 'setup')) {
            assert.equal(setup, 'passive');
        }

        assert.equal(stats.videoResumes, 1);
        assert.equal(stats.audioResumes, 0);
        assert.equal(room.whepSessions.size, 1);
        assert.equal(room.whepViewerCount, 1);
        assert.equal(room.whepPendingReservations, 0);
        assert.equal(sessionRegistry.pendingWhepGlobal, 0);
    } finally {
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhep;
        await new Promise((resolve) => server.close(resolve));

        assert.equal(stats.transportCloses, 1);
        assert.equal(stats.videoCloses, 1);
        assert.equal(sessionRegistry.pendingWhepGlobal, initialGlobalPending);
        assert.equal(sessionRegistry.whepSessions.size, initialGlobalActive);
    }
});

test('failure: post-registration video resume() rejection cleans registered session, maps, and closes resources exactly once', { concurrency: false }, async () => {
    const prevWhep = config.WHEP_ENABLED;
    const initialGlobalPending = sessionRegistry.pendingWhepGlobal;
    const initialGlobalActive = sessionRegistry.whepSessions.size;

    const { mediasoupRouter, createWebRtcTransport, stats } = createConfigurableHarness({
        videoResumeFails: true,
    });
    let reqCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-resumefail-ip-${reqCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    let room = null;
    try {
        config.WHEP_ENABLED = true;
        room = await createRoom('whep-resumefail-room');
        room.producer = { id: 'prod-video', closed: false, close() {} };

        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: VIDEO_ONLY_OFFER,
        });

        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { error: 'Internal server error' });
        assert.equal(stats.transportCloses, 1);
        assert.equal(stats.videoCloses, 1);
        assert.equal(room.whepPendingReservations, 0);
        assert.equal(room.whepSessions.size, 0);
        assert.equal(room.whepViewerCount, 0);
        assert.equal(sessionRegistry.pendingWhepGlobal, 0);
        assert.equal(sessionRegistry.whepSessions.size, 0);
    } finally {
        if (room) destroyRoom(room.code);
        config.WHEP_ENABLED = prevWhep;
        await new Promise((resolve) => server.close(resolve));
        assert.equal(sessionRegistry.pendingWhepGlobal, initialGlobalPending);
        assert.equal(sessionRegistry.whepSessions.size, initialGlobalActive);
    }
});
