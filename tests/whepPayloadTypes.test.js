const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const mediasoup = require('mediasoup');
const ortc = require('mediasoup/ortc');

const config = require('../config');
const { createRoom, destroyRoom } = require('../lib/rooms');
const { createWhepRouter } = require('../lib/whepRoutes');
const { parseViewerOffer } = require('../lib/whep');
const { CHROMIUM_153_RECVONLY_OFFER, FIREFOX_155_RECVONLY_OFFER } = require('./whepBrowserOffers');

// A WHEP player is the SDP offerer and receives only: browsers decode a payload type only as
// the codec their own offer gave it (RFC 3264 section 5.1; Chromium 153 and Firefox 155 decode
// nothing on other numbers, whatever the answer says). So a WHEP consumer must send each codec,
// and its RTX, on the numbers of the viewer's offer. These tests run the WHEP route on a real
// mediasoup worker and router built from config.MEDIA_CODECS, with the room's producers on a
// DirectTransport, and read what each consumer really sends (consumer.rtpParameters).
// Transports are DirectTransports, which bind no ports; the pipes that carry a room's media to
// another router bind loopback UDP ports.

let worker = null;

before(async () => {
    worker = await mediasoup.createWorker({ logLevel: 'error' });
});

after(() => {
    worker?.close();
});

const VIDEO_FEEDBACK = [
    { type: 'goog-remb' },
    { type: 'transport-cc' },
    { type: 'ccm', parameter: 'fir' },
    { type: 'nack' },
    { type: 'nack', parameter: 'pli' },
];

// What the host page (mediasoup-client in Chromium) produces: three simulcast layers with RTX,
// and opus. The producer's own numbering does not matter; mediasoup maps it to the router's.
const HOST_PRODUCERS = {
    vp8: () => ({
        kind: 'video',
        rtpParameters: {
            mid: '0',
            codecs: [
                { mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, parameters: {}, rtcpFeedback: VIDEO_FEEDBACK },
                { mimeType: 'video/rtx', payloadType: 97, clockRate: 90000, parameters: { apt: 96 }, rtcpFeedback: [] },
            ],
            headerExtensions: [],
            encodings: [
                { ssrc: 1001, rtx: { ssrc: 1002 } },
                { ssrc: 1003, rtx: { ssrc: 1004 } },
                { ssrc: 1005, rtx: { ssrc: 1006 } },
            ],
            rtcp: { cname: 'host' },
        },
    }),
    h264: () => ({
        kind: 'video',
        rtpParameters: {
            mid: '0',
            codecs: [
                {
                    mimeType: 'video/H264',
                    payloadType: 108,
                    clockRate: 90000,
                    parameters: { 'level-asymmetry-allowed': 1, 'packetization-mode': 1, 'profile-level-id': '42e01f' },
                    rtcpFeedback: VIDEO_FEEDBACK,
                },
                { mimeType: 'video/rtx', payloadType: 109, clockRate: 90000, parameters: { apt: 108 }, rtcpFeedback: [] },
            ],
            headerExtensions: [],
            encodings: [{ ssrc: 2001, rtx: { ssrc: 2002 } }],
            rtcp: { cname: 'host' },
        },
    }),
    opus: () => ({
        kind: 'audio',
        rtpParameters: {
            mid: '1',
            codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2, parameters: { minptime: 10, useinbandfec: 1 }, rtcpFeedback: [] }],
            headerExtensions: [],
            encodings: [{ ssrc: 3001 }],
            rtcp: { cname: 'host' },
        },
    }),
};

function listen(app) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

async function waitFor(predicate, label) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

let ipCounter = 0;

/**
 * A room on a real router with the given host producers, and the WHEP route on it.
 * Records every router the route creates and every consumer it makes.
 */
async function withWhep({ video = 'vp8', audio = true, routeOptions = {} } = {}, callback) {
    const previous = { WHEP_ENABLED: config.WHEP_ENABLED, WHEP_RATE_LIMIT_MAX: config.WHEP_RATE_LIMIT_MAX };
    config.WHEP_ENABLED = true;
    config.WHEP_RATE_LIMIT_MAX = 1000;

    const mainRouter = await worker.createRouter({ mediaCodecs: config.MEDIA_CODECS });
    const hostTransport = await mainRouter.createDirectTransport();
    const createdRouters = [];
    const consumers = [];
    const createRouter = async (mediaCodecs) => {
        const router = await worker.createRouter({ mediaCodecs });
        createdRouters.push(router);
        return router;
    };
    const createWebRtcTransport = async (router) => {
        const transport = await router.createDirectTransport();
        const consume = transport.consume.bind(transport);
        transport.consume = async (args) => {
            const consumer = await consume(args);
            consumers.push({ router, consumer });
            return consumer;
        };
        return {
            transport,
            params: {
                id: transport.id,
                iceParameters: { usernameFragment: 'serverufrag', password: 'serverpwd' },
                iceCandidates: [{ protocol: 'udp', ip: '127.0.0.1', port: 40000, type: 'host' }],
                dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB:CC' }] },
            },
        };
    };

    const app = express();
    app.use('/whep', createWhepRouter(mainRouter, {
        getClientIp: () => `whep-pt-${ipCounter++}`,
        createWebRtcTransport,
        createRouter,
        ...routeOptions,
    }));
    const { server, baseUrl } = await listen(app);

    const room = await createRoom(`whep-pt-host-${ipCounter++}`);
    room.producer = await hostTransport.produce(HOST_PRODUCERS[video]());
    if (audio) room.audioProducer = await hostTransport.produce(HOST_PRODUCERS.opus());

    const post = async (offer) => {
        const res = await fetch(`${baseUrl}/whep/watch/${room.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: offer,
        });
        const text = await res.text();
        return { status: res.status, text, location: res.headers.get('location') };
    };
    const remove = async (location) => {
        const res = await fetch(`${baseUrl}${location}`, { method: 'DELETE' });
        assert.equal(res.status, 200);
    };

    try {
        await callback({ mainRouter, hostTransport, room, post, remove, consumers, createdRouters });
    } finally {
        destroyRoom(room.code);
        await new Promise((resolve) => server.close(resolve));
        mainRouter.close();
        for (const router of createdRouters) router.close();
        Object.assign(config, previous);
    }
}

function answerSections(answer) {
    const sections = [];
    for (const line of answer.split('\r\n')) {
        if (line.startsWith('m=')) sections.push([line]);
        else if (sections.length > 0 && line) sections[sections.length - 1].push(line);
    }
    return sections;
}

const summary = (consumer) => consumer.rtpParameters.codecs
    .map((c) => `${c.payloadType} ${c.mimeType}${c.parameters?.apt !== undefined ? ` apt=${c.parameters.apt}` : ''}`);

/**
 * Every payload type the consumer sends is the one the offer gives that very codec (an RTX
 * included: the offer's entry at that number is rtx with the same apt), in the offer section
 * the answer gives the consumer to.
 */
function assertSendsTheOfferPayloadTypes(offer, consumer) {
    const parsed = parseViewerOffer(offer);
    const section = parsed._mediaSections.find((s) => s.kind === consumer.kind && s.port !== 0 && /recvonly|sendrecv/.test(s.direction));
    for (const codec of consumer.rtpParameters.codecs) {
        const name = codec.mimeType.split('/')[1].toUpperCase();
        const offered = section.codecs.find((c) => c.payloadType === codec.payloadType);
        assert.ok(offered, `the offer has payload type ${codec.payloadType} (${codec.mimeType})`);
        assert.equal(offered.name, name, `payload type ${codec.payloadType} is ${offered.name} in the offer, the consumer sends ${codec.mimeType} on it`);
        assert.equal(offered.clockRate, codec.clockRate);
        if (name === 'RTX') {
            assert.equal(Number(section.fmtp[codec.payloadType]?.apt), codec.parameters.apt, `rtx ${codec.payloadType} has the same apt in the offer`);
        }
        if (name === 'H264') {
            const fmtp = section.fmtp[codec.payloadType] || {};
            assert.equal(String(fmtp['packetization-mode'] ?? '0'), String(codec.parameters['packetization-mode'] ?? '0'));
            assert.equal(String(fmtp['profile-level-id']).toLowerCase(), String(codec.parameters['profile-level-id']).toLowerCase());
        }
    }
}

describe('WHEP consumers send on the payload types of the viewer offer', () => {
    const CASES = [
        { browser: 'Chromium 153', offer: CHROMIUM_153_RECVONLY_OFFER, video: 'vp8', expected: { video: ['96 video/VP8', '97 video/rtx apt=96'], audio: ['111 audio/opus'] } },
        { browser: 'Chromium 153', offer: CHROMIUM_153_RECVONLY_OFFER, video: 'h264', expected: { video: ['108 video/H264', '109 video/rtx apt=108'], audio: ['111 audio/opus'] } },
        { browser: 'Firefox 155', offer: FIREFOX_155_RECVONLY_OFFER, video: 'vp8', expected: { video: ['120 video/VP8', '124 video/rtx apt=120'], audio: ['109 audio/opus'] } },
        { browser: 'Firefox 155', offer: FIREFOX_155_RECVONLY_OFFER, video: 'h264', expected: { video: ['126 video/H264', '127 video/rtx apt=126'], audio: ['109 audio/opus'] } },
    ];

    for (const { browser, offer, video, expected } of CASES) {
        it(`${browser} offer, host ${video === 'vp8' ? 'VP8' : 'H.264'} + opus: the consumers send the offer's numbers, and the answer names them`, async () => {
            await withWhep({ video }, async ({ post, consumers }) => {
                const res = await post(offer);
                assert.equal(res.status, 201, res.text);
                const videoConsumer = consumers.find((c) => c.consumer.kind === 'video').consumer;
                const audioConsumer = consumers.find((c) => c.consumer.kind === 'audio').consumer;
                assert.deepEqual(summary(videoConsumer), expected.video);
                assert.deepEqual(summary(audioConsumer), expected.audio);
                assertSendsTheOfferPayloadTypes(offer, videoConsumer);
                assertSendsTheOfferPayloadTypes(offer, audioConsumer);

                const [videoSection, audioSection] = answerSections(res.text);
                assert.equal(videoSection[0], `m=video 9 UDP/TLS/RTP/SAVPF ${videoConsumer.rtpParameters.codecs.map((c) => c.payloadType).join(' ')}`);
                assert.equal(audioSection[0], `m=audio 9 UDP/TLS/RTP/SAVPF ${audioConsumer.rtpParameters.codecs.map((c) => c.payloadType).join(' ')}`);
                // NACK retransmission is kept, on the RTX stream.
                const mediaPt = videoConsumer.rtpParameters.codecs[0].payloadType;
                assert.ok(videoSection.includes(`a=rtcp-fb:${mediaPt} nack`), videoSection.join('\n'));
                assert.ok(videoConsumer.rtpParameters.encodings[0].rtx?.ssrc, 'the video consumer has an RTX stream');
            });
        });
    }

    it('an offer numbered like the router is served by the main router, with the router numbers', async () => {
        const offer = CHROMIUM_153_RECVONLY_OFFER;
        // VP8 100 / rtx 101 and opus 110, as config.MEDIA_CODECS numbers them; the codecs that
        // had those numbers move to free ones.
        const renumbered = offer
            .replace(/\b100\b/g, 'X100').replace(/\b101\b/g, 'X101').replace(/\b110\b/g, 'X110')
            .replace(/\b96\b/g, '100').replace(/\b97\b/g, '101').replace(/\b111\b/g, '110')
            .replace(/X100/g, '50').replace(/X101/g, '51').replace(/X110/g, '52')
            .replace(/apt=96\b/g, 'apt=100')
            .replace('a=fmtp:63 111/111', 'a=fmtp:63 110/110');
        await withWhep({}, async ({ mainRouter, post, consumers, createdRouters }) => {
            const res = await post(renumbered);
            assert.equal(res.status, 201, res.text);
            assert.equal(createdRouters.length, 0, 'no other router is created');
            assert.ok(consumers.every((c) => c.router === mainRouter));
            assert.deepEqual(summary(consumers[0].consumer), ['100 video/VP8', '101 video/rtx apt=100']);
            assert.deepEqual(summary(consumers[1].consumer), ['110 audio/opus']);
        });
    });

    it('a video RTX number mediasoup cannot give (outside 96-127) leaves RTX out and keeps NACK on the media stream', async () => {
        // Chromium numbers some codecs from 35 up; give VP8's RTX such a number (50 is free in its offer).
        const offer = CHROMIUM_153_RECVONLY_OFFER
            .replace('SAVPF 96 97 98', 'SAVPF 96 50 98')
            .replace('a=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96', 'a=rtpmap:50 rtx/90000\r\na=fmtp:50 apt=96');
        await withWhep({}, async ({ post, consumers }) => {
            const res = await post(offer);
            assert.equal(res.status, 201, res.text);
            const videoConsumer = consumers.find((c) => c.consumer.kind === 'video').consumer;
            assert.deepEqual(summary(videoConsumer), ['96 video/VP8']);
            assert.equal(videoConsumer.rtpParameters.encodings[0].rtx, undefined);
            assert.ok(videoConsumer.rtpParameters.codecs[0].rtcpFeedback.some((fb) => fb.type === 'nack' && !fb.parameter), 'plain NACK is kept');
            const [videoSection] = answerSections(res.text);
            assert.equal(videoSection[0], 'm=video 9 UDP/TLS/RTP/SAVPF 96');
            assert.ok(videoSection.includes('a=rtcp-fb:96 nack'));
        });
    });

    it('an offer that gives one payload type to both video and audio is answered 400, with nothing left open', async () => {
        const offer = CHROMIUM_153_RECVONLY_OFFER
            .replace('m=audio 9 UDP/TLS/RTP/SAVPF 111 ', 'm=audio 9 UDP/TLS/RTP/SAVPF 96 ')
            .replace('a=rtpmap:111 opus', 'a=rtpmap:96 opus')
            .replace('a=rtcp-fb:111 transport-cc', 'a=rtcp-fb:96 transport-cc')
            .replace('a=fmtp:111 minptime', 'a=fmtp:96 minptime');
        await withWhep({}, async ({ post, consumers, createdRouters }) => {
            const res = await post(offer);
            assert.equal(res.status, 400, res.text);
            assert.match(JSON.parse(res.text).error, /96/);
            assert.equal(consumers.length, 0);
            assert.ok(createdRouters.every((router) => router.closed));
        });
    });
});

describe('WHEP routers per offer numbering', () => {
    it('viewers with the same numbering share one router, another numbering gets its own, and each closes with its last viewer', async () => {
        await withWhep({}, async ({ mainRouter, post, remove, consumers, createdRouters }) => {
            // The main router's ends of the pipes.
            const pipeTransports = [];
            mainRouter.observer.on('newtransport', (transport) => {
                if (transport.type === 'pipe') pipeTransports.push(transport);
            });
            const chromiumA = await post(CHROMIUM_153_RECVONLY_OFFER);
            const chromiumB = await post(CHROMIUM_153_RECVONLY_OFFER);
            assert.equal(chromiumA.status, 201, chromiumA.text);
            assert.equal(chromiumB.status, 201, chromiumB.text);
            assert.equal(createdRouters.length, 1, 'both Chromium viewers use one router');
            const firefox = await post(FIREFOX_155_RECVONLY_OFFER);
            assert.equal(firefox.status, 201, firefox.text);
            assert.equal(createdRouters.length, 2, 'Firefox numbers differently and gets its own router');
            assert.deepEqual(consumers.map((c) => createdRouters.indexOf(c.router)), [0, 0, 0, 0, 1, 1]);

            await remove(chromiumA.location);
            assert.equal(createdRouters[0].closed, false, 'one Chromium viewer is left');
            await remove(chromiumB.location);
            assert.equal(createdRouters[0].closed, true, 'closed with its last viewer');
            assert.equal(createdRouters[1].closed, false);
            await remove(firefox.location);
            assert.equal(createdRouters[1].closed, true);
            assert.equal(pipeTransports.length, 2, 'one pipe per router, shared by its producers');
            assert.ok(pipeTransports.every((transport) => transport.closed), 'the main router keeps no pipe open');
        });
    });

    it('viewers of one numbering that arrive together still share one router', async () => {
        await withWhep({}, async ({ post, consumers, createdRouters }) => {
            const results = await Promise.all([post(CHROMIUM_153_RECVONLY_OFFER), post(CHROMIUM_153_RECVONLY_OFFER), post(CHROMIUM_153_RECVONLY_OFFER)]);
            assert.deepEqual(results.map((r) => r.status), [201, 201, 201]);
            assert.equal(createdRouters.length, 1);
            assert.equal(consumers.length, 6);
            assert.ok(consumers.every((c) => c.router === createdRouters[0]));
        });
    });

    it('closing the room closes its routers', async () => {
        await withWhep({}, async ({ room, post, createdRouters }) => {
            assert.equal((await post(CHROMIUM_153_RECVONLY_OFFER)).status, 201);
            assert.equal((await post(FIREFOX_155_RECVONLY_OFFER)).status, 201);
            assert.equal(createdRouters.length, 2);
            destroyRoom(room.code);
            await waitFor(() => createdRouters.every((router) => router.closed), 'the routers to close');
        });
    });

    it('a viewer that comes after the host replaced a producer gets the new one through the router still in use', async () => {
        const videoOnly = CHROMIUM_153_RECVONLY_OFFER.slice(0, CHROMIUM_153_RECVONLY_OFFER.indexOf('m=audio'))
            .replace('a=group:BUNDLE 0 1', 'a=group:BUNDLE 0');
        await withWhep({}, async ({ room, hostTransport, post, consumers, createdRouters }) => {
            const full = await post(CHROMIUM_153_RECVONLY_OFFER);
            const video = await post(videoOnly);
            assert.equal(full.status, 201, full.text);
            assert.equal(video.status, 201, video.text);
            assert.equal(createdRouters.length, 1, 'the video-only viewer is served by the same router');
            const firstAudio = consumers.find((c) => c.consumer.kind === 'audio').consumer;

            // The host turns the microphone off and on: a new audio producer.
            room.audioProducer.close();
            room.audioProducer = await hostTransport.produce(HOST_PRODUCERS.opus());
            await waitFor(() => firstAudio.closed, 'the first viewer to lose its audio');
            assert.equal(createdRouters[0].closed, false, 'the video-only viewer keeps the router open');

            const again = await post(CHROMIUM_153_RECVONLY_OFFER);
            assert.equal(again.status, 201, again.text);
            assert.equal(createdRouters.length, 1, 'no second router');
            const newAudio = consumers.filter((c) => c.consumer.kind === 'audio').at(-1);
            assert.equal(newAudio.router, createdRouters[0]);
            assert.equal(newAudio.consumer.closed, false);
            assert.deepEqual(summary(newAudio.consumer), ['111 audio/opus']);
        });
    });

    it('a room serves a limited number of numberings; the next one is answered 503 and leaves nothing open', async () => {
        await withWhep({ routeOptions: { maxLayoutRoutersPerRoom: 1 } }, async ({ post, consumers, createdRouters }) => {
            assert.equal((await post(CHROMIUM_153_RECVONLY_OFFER)).status, 201);
            const res = await post(FIREFOX_155_RECVONLY_OFFER);
            assert.equal(res.status, 503, res.text);
            assert.equal(createdRouters.length, 1);
            assert.equal(consumers.length, 2);
        });
    });
});

describe('layout router codecs steer mediasoup to the offer numbers', () => {
    const { buildLayoutMediaCodecs } = require('../lib/whep');
    const routerCodec = (mimeType, extra = {}) => ({ kind: mimeType.startsWith('audio') ? 'audio' : 'video', mimeType, clockRate: mimeType.startsWith('audio') ? 48000 : 90000, ...extra });
    const VP8 = routerCodec('video/VP8', { parameters: {} });
    const OPUS = routerCodec('audio/opus', { channels: 2, parameters: { useinbandfec: 1 } });

    for (const [videoPt, rtxPt, opusPt] of [[96, 97, 111], [120, 124, 109], [126, 127, 109], [108, 109, 111], [100, 101, 110], [127, 99, 96], [96, 100, 101]]) {
        it(`video ${videoPt} with RTX ${rtxPt}, opus ${opusPt}`, () => {
            const plan = {
                entries: [
                    { kind: 'video', codec: VP8, payloadType: videoPt, rtxPayloadType: rtxPt },
                    { kind: 'audio', codec: OPUS, payloadType: opusPt, rtxPayloadType: null },
                ],
            };
            const caps = ortc.generateRouterRtpCapabilities(buildLayoutMediaCodecs(plan));
            const at = (pt) => caps.codecs.find((c) => c.preferredPayloadType === pt);
            assert.equal(at(videoPt).mimeType, 'video/VP8');
            assert.equal(at(rtxPt).mimeType, 'video/rtx');
            assert.equal(at(rtxPt).parameters.apt, videoPt);
            assert.equal(at(opusPt).mimeType, 'audio/opus');
        });
    }
});
