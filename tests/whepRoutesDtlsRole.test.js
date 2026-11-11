const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const config = require('../config');
const { createRoom, destroyRoom } = require('../lib/rooms');
const { createWhepRouter } = require('../lib/whepRoutes');

// The DTLS role the WHEP route hands to mediasoup (transport.connect's remote role) and the
// a=setup its answer states are two views of one decision (RFC 4145 section 4.1, RFC 5763
// section 5): a passive offer makes the viewer the DTLS server, mediasoup the client, and the
// answer says active; actpass, active or no setup makes the viewer the client, and the answer
// says passive. These tests drive the real route with a fake transport that records connect().

const FINGERPRINT = 'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

/**
 * A video + audio WHEP offer. setups maps a level ('session', 'video', 'audio') to the
 * a=setup value written there; a level left out writes none.
 */
function buildOffer(setups) {
    const lines = [
        'v=0',
        'o=- 123456 2 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        'a=group:BUNDLE 0 1',
        FINGERPRINT,
    ];
    if (setups.session) lines.push(`a=setup:${setups.session}`);
    lines.push(
        'a=ice-ufrag:testufrag',
        'a=ice-pwd:testpwd1234567890123456',
        'm=video 9 UDP/TLS/RTP/SAVPF 96',
        'c=IN IP4 0.0.0.0',
        'a=mid:0',
    );
    if (setups.video) lines.push(`a=setup:${setups.video}`);
    lines.push(
        'a=recvonly',
        'a=rtcp-mux',
        'a=rtpmap:96 H264/90000',
        'a=fmtp:96 profile-level-id=42e01f;packetization-mode=1',
        'm=audio 9 UDP/TLS/RTP/SAVPF 111',
        'c=IN IP4 0.0.0.0',
        'a=mid:1',
    );
    if (setups.audio) lines.push(`a=setup:${setups.audio}`);
    lines.push(
        'a=recvonly',
        'a=rtcp-mux',
        'a=rtpmap:111 opus/48000/2',
        '',
    );
    return lines.join('\r\n');
}

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
    const connects = [];
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
        canConsume: () => true,
    };

    const createWebRtcTransport = async () => {
        const transport = new EventEmitter();
        transport.close = () => {};
        transport.connect = async (args) => { connects.push(args); };
        transport.consume = async ({ producerId }) => {
            const video = producerId === 'prod-video';
            const consumer = new EventEmitter();
            consumer.id = video ? 'consumer-video' : 'consumer-audio';
            consumer.kind = video ? 'video' : 'audio';
            consumer.rtpParameters = {
                codecs: [video
                    ? {
                        payloadType: 96,
                        mimeType: 'video/H264',
                        clockRate: 90000,
                        parameters: { 'profile-level-id': '42e01f', 'packetization-mode': 1 },
                        rtcpFeedback: [],
                    }
                    : {
                        payloadType: 111,
                        mimeType: 'audio/opus',
                        clockRate: 48000,
                        channels: 2,
                        parameters: {},
                        rtcpFeedback: [],
                    }],
                headerExtensions: [],
                encodings: [{ ssrc: video ? 11111111 : 22222222 }],
            };
            consumer.resume = async () => {};
            consumer.close = () => {};
            return consumer;
        };
        return {
            transport,
            params: {
                iceParameters: { usernameFragment: 'serverufrag', password: 'serverpwd' },
                iceCandidates: [{ protocol: 'udp', ip: '127.0.0.1', port: 40000, type: 'host' }],
                dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB:CC' }] },
            },
        };
    };

    return { mediasoupRouter, createWebRtcTransport, connects };
}

/** POST each offer to a real WHEP route over a fake transport; resolve to what the answer and connect() say. */
async function postOffers(offers) {
    const previousEnabled = config.WHEP_ENABLED;
    const { mediasoupRouter, createWebRtcTransport, connects } = createHarness();
    let requestCounter = 0;
    const app = express();
    app.use('/whep', createWhepRouter(mediasoupRouter, {
        getClientIp: () => `whep-dtls-role-ip-${requestCounter++}`,
        createWebRtcTransport,
    }));
    const { server, baseUrl } = await listen(app);

    const rooms = [];
    try {
        config.WHEP_ENABLED = true;
        const results = [];
        for (const offer of offers) {
            const room = await createRoom(`whep-dtls-role-${rooms.length}`);
            rooms.push(room);
            room.producer = { id: 'prod-video', closed: false, close() {} };
            room.audioProducer = { id: 'prod-audio', closed: false, close() {} };

            const connectsBefore = connects.length;
            const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/sdp' },
                body: offer,
            });
            assert.equal(res.status, 201);
            const answer = await res.text();
            assert.equal(connects.length, connectsBefore + 1, 'transport.connect() is called once per offer');
            const setups = answer.split('\r\n')
                .filter((line) => line.startsWith('a=setup:'))
                .map((line) => line.slice('a=setup:'.length));
            results.push({ role: connects[connectsBefore].dtlsParameters.role, setups });
        }
        return results;
    } finally {
        for (const room of rooms) destroyRoom(room.code);
        config.WHEP_ENABLED = previousEnabled;
        await new Promise((resolve) => server.close(resolve));
    }
}

const CASES = [
    { offered: 'actpass', role: 'client', answer: 'passive' },
    { offered: 'active', role: 'client', answer: 'passive' },
    { offered: 'passive', role: 'server', answer: 'active' },
];

for (const { offered, role, answer } of CASES) {
    test(`WHEP route: a=setup:${offered} offer is connected with remote role '${role}' and answered a=setup:${answer} in both sections`, { concurrency: false }, async () => {
        const [sessionLevel, mediaLevel] = await postOffers([
            buildOffer({ session: offered }),
            buildOffer({ video: offered, audio: offered }),
        ]);
        assert.deepEqual(sessionLevel, { role, setups: [answer, answer] });
        assert.deepEqual(mediaLevel, { role, setups: [answer, answer] });
    });
}

test("WHEP route: an offer with no a=setup is connected with remote role 'client' and answered a=setup:passive", { concurrency: false }, async () => {
    const [result] = await postOffers([buildOffer({})]);
    assert.deepEqual(result, { role: 'client', setups: ['passive', 'passive'] });
});

test('WHEP route: one DTLS role for the bundle, taken from the video section when the sections disagree', { concurrency: false }, async () => {
    const [videoPassive, audioPassive] = await postOffers([
        buildOffer({ video: 'passive', audio: 'actpass' }),
        buildOffer({ video: 'actpass', audio: 'passive' }),
    ]);
    assert.deepEqual(videoPassive, { role: 'server', setups: ['active', 'active'] });
    assert.deepEqual(audioPassive, { role: 'client', setups: ['passive', 'passive'] });
});
