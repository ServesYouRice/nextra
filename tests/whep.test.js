const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseViewerOffer, parseViewerDtls, createViewerAnswer, buildViewerRtpCapabilities } = require('../lib/whep');

// --- Sample SDP offer (recvonly, video + audio) ---
const SAMPLE_OFFER = [
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
    'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=mid:1',
    'a=recvonly',
    'a=rtcp-mux',
    'a=rtpmap:111 opus/48000/2',
    'a=extmap:4 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
    '',
].join('\r\n');

// Video-only offer (no audio m-line)
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

// --- Mock consumer objects ---
const mockVideoConsumer = {
    kind: 'video',
    rtpParameters: {
        codecs: [{
            payloadType: 96,
            mimeType: 'video/H264',
            clockRate: 90000,
            parameters: { 'profile-level-id': '42e01f', 'packetization-mode': 1 },
            rtcpFeedback: [
                { type: 'nack', parameter: '' },
                { type: 'nack', parameter: 'pli' },
                { type: 'transport-cc', parameter: '' },
            ],
        }],
        headerExtensions: [
            { id: 1, uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' },
            { id: 4, uri: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01' },
        ],
        encodings: [{ ssrc: 12345678 }],
    },
};

const mockAudioConsumer = {
    kind: 'audio',
    rtpParameters: {
        codecs: [{
            payloadType: 111,
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2,
            parameters: { useinbandfec: 1, minptime: 10 },
            rtcpFeedback: [],
        }],
        headerExtensions: [
            { id: 5, uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level' },
        ],
        encodings: [{ ssrc: 87654321 }],
    },
};

const mockTransportParams = {
    iceParameters: {
        usernameFragment: 'serverufrag',
        password: 'serverpwd',
    },
    iceCandidates: [
        { ip: '192.168.1.100', port: 40000, protocol: 'udp', type: 'host' },
    ],
    dtlsParameters: {
        fingerprints: [
            { algorithm: 'sha-256', value: 'SE:RV:ER:FP:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99' },
        ],
    },
};

// ====================================================================
// parseViewerOffer
// ====================================================================
describe('parseViewerOffer', () => {
    it('parses a basic recvonly video+audio SDP offer with H.264', () => {
        const parsed = parseViewerOffer(SAMPLE_OFFER);
        assert.ok(parsed.video, 'video section should exist');
        assert.ok(parsed.audio, 'audio section should exist');
        assert.equal(parsed.video.direction, 'recvonly');
        assert.equal(parsed.audio.direction, 'recvonly');
        assert.equal(parsed.video.codecs[0].name, 'H264');
        assert.equal(parsed.video.codecs[0].clockRate, 90000);
        assert.equal(parsed.audio.codecs[0].name, 'OPUS');
        assert.equal(parsed.audio.codecs[0].clockRate, 48000);
    });

    it('extracts fingerprint, setup, ice-ufrag, ice-pwd', () => {
        const parsed = parseViewerOffer(SAMPLE_OFFER);
        // Session-level attributes should be inherited into media sections
        assert.equal(parsed.video.fingerprint.algorithm, 'sha-256');
        assert.equal(
            parsed.video.fingerprint.value,
            'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
        );
        assert.equal(parsed.video.setup, 'actpass');
        assert.equal(parsed.video.iceUfrag, 'testufrag');
        assert.equal(parsed.video.icePwd, 'testpwd1234567890123456');
    });

    it('extracts extmap entries', () => {
        const parsed = parseViewerOffer(SAMPLE_OFFER);
        assert.equal(parsed.video.extmap.length, 1);
        assert.equal(parsed.video.extmap[0].id, 1);
        assert.equal(parsed.video.extmap[0].uri, 'urn:ietf:params:rtp-hdrext:sdes:mid');
        assert.equal(parsed.audio.extmap.length, 1);
        assert.equal(parsed.audio.extmap[0].id, 4);
        assert.equal(parsed.audio.extmap[0].uri, 'urn:ietf:params:rtp-hdrext:ssrc-audio-level');
    });

    it('inherits session-level attributes into media sections', () => {
        const parsed = parseViewerOffer(SAMPLE_OFFER);
        // Both video and audio should inherit the session-level fingerprint/setup/ice
        for (const section of [parsed.video, parsed.audio]) {
            assert.ok(section.fingerprint, `${section.kind} should have fingerprint`);
            assert.equal(section.setup, 'actpass');
            assert.equal(section.iceUfrag, 'testufrag');
            assert.equal(section.icePwd, 'testpwd1234567890123456');
        }
    });

    it('handles video-only offers (no audio m-line)', () => {
        const parsed = parseViewerOffer(VIDEO_ONLY_OFFER);
        assert.ok(parsed.video, 'video section should exist');
        assert.equal(parsed.audio, null, 'audio section should be null');
        assert.equal(parsed.video.codecs[0].name, 'H264');
    });

    it('preserves m-section order in _mediaSections', () => {
        const parsed = parseViewerOffer(SAMPLE_OFFER);
        assert.equal(parsed._mediaSections.length, 2);
        assert.equal(parsed._mediaSections[0].kind, 'video');
        assert.equal(parsed._mediaSections[1].kind, 'audio');
    });
});

// ====================================================================
// parseViewerDtls
// ====================================================================
describe('parseViewerDtls', () => {
    it('returns role=client when viewer offers a=setup:actpass', () => {
        const parsed = parseViewerOffer(SAMPLE_OFFER);
        const dtls = parseViewerDtls(parsed);
        assert.equal(dtls.role, 'client');
        assert.equal(dtls.fingerprints[0].algorithm, 'sha-256');
    });

    it('returns role=client when viewer offers a=setup:active', () => {
        const offer = SAMPLE_OFFER.replace('a=setup:actpass', 'a=setup:active');
        const parsed = parseViewerOffer(offer);
        const dtls = parseViewerDtls(parsed);
        assert.equal(dtls.role, 'client');
    });

    it('returns role=server when viewer offers a=setup:passive', () => {
        const offer = SAMPLE_OFFER.replace('a=setup:actpass', 'a=setup:passive');
        const parsed = parseViewerOffer(offer);
        const dtls = parseViewerDtls(parsed);
        assert.equal(dtls.role, 'server');
    });

    it('returns null when no fingerprint', () => {
        const noFpOffer = [
            'v=0',
            'o=- 123456 2 IN IP4 127.0.0.1',
            's=-',
            't=0 0',
            'a=setup:actpass',
            'a=ice-ufrag:testufrag',
            'a=ice-pwd:testpwd1234567890123456',
            'm=video 9 UDP/TLS/RTP/SAVPF 96',
            'c=IN IP4 0.0.0.0',
            'a=mid:0',
            'a=recvonly',
            'a=rtpmap:96 H264/90000',
            '',
        ].join('\r\n');
        const parsed = parseViewerOffer(noFpOffer);
        const dtls = parseViewerDtls(parsed);
        assert.equal(dtls, null);
    });
});

// ====================================================================
// createViewerAnswer
// ====================================================================
describe('createViewerAnswer', () => {
    function buildAnswer(consumers, offer) {
        const parsed = parseViewerOffer(offer || SAMPLE_OFFER);
        return createViewerAnswer(parsed, consumers, mockTransportParams);
    }

    it('produces valid SDP answer for video+audio consumers', () => {
        const answer = buildAnswer([mockVideoConsumer, mockAudioConsumer]);
        assert.ok(answer.startsWith('v=0'), 'should start with v=0');
        assert.ok(answer.includes('m=video 9'), 'should have video m-line');
        assert.ok(answer.includes('m=audio 9'), 'should have audio m-line');
        assert.ok(answer.includes('a=rtpmap:96 H264/90000'), 'should include video codec');
        assert.ok(answer.includes('a=rtpmap:111 opus/48000/2'), 'should include audio codec');
    });

    it('produces valid SDP answer for video-only (audio rejected with port 0)', () => {
        const answer = buildAnswer([mockVideoConsumer]);
        assert.ok(answer.includes('m=video 9'), 'should have active video m-line');
        assert.ok(answer.includes('m=audio 0'), 'audio should be rejected with port 0');
        assert.ok(answer.includes('a=inactive'), 'rejected section should be inactive');
    });

    it('BUNDLE group only contains active mids', () => {
        const answer = buildAnswer([mockVideoConsumer]);
        const bundleLine = answer.split('\r\n').find(l => l.startsWith('a=group:BUNDLE'));
        assert.ok(bundleLine, 'should have BUNDLE line');
        assert.equal(bundleLine, 'a=group:BUNDLE 0');
    });

    it('includes a=sendonly direction', () => {
        const answer = buildAnswer([mockVideoConsumer, mockAudioConsumer]);
        const lines = answer.split('\r\n');
        const sendonlyLines = lines.filter(l => l === 'a=sendonly');
        assert.ok(sendonlyLines.length >= 1, 'should have at least one sendonly line');
    });

    it('includes a=rtcp-mux and a=rtcp-rsize', () => {
        const answer = buildAnswer([mockVideoConsumer, mockAudioConsumer]);
        assert.ok(answer.includes('a=rtcp-mux'), 'should include rtcp-mux');
        assert.ok(answer.includes('a=rtcp-rsize'), 'should include rtcp-rsize');
    });

    it('includes a=end-of-candidates', () => {
        const answer = buildAnswer([mockVideoConsumer]);
        assert.ok(answer.includes('a=end-of-candidates'), 'should include end-of-candidates');
    });

    it('does NOT include a=ice-options:trickle', () => {
        const answer = buildAnswer([mockVideoConsumer, mockAudioConsumer]);
        assert.ok(!answer.includes('a=ice-options:trickle'), 'should not include ice-options:trickle');
    });

    it('includes extmap from consumer headerExtensions', () => {
        const answer = buildAnswer([mockVideoConsumer]);
        assert.ok(
            answer.includes('a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid'),
            'should include sdes:mid extmap'
        );
        // SAMPLE_OFFER lists no transport-wide-cc extension for video, so the answer must not add one.
        assert.ok(
            !answer.includes('transport-wide-cc-extensions-01'),
            'should not advertise a transport-cc extmap the offer did not list'
        );
    });

    it('includes SSRC lines from consumer encodings', () => {
        const answer = buildAnswer([mockVideoConsumer]);
        assert.ok(answer.includes('a=ssrc:12345678 cname:whep'), 'should include SSRC line');
    });

    it('includes ssrc-group:FID when RTX is present', () => {
        const consumerWithRtx = {
            kind: 'video',
            rtpParameters: {
                ...mockVideoConsumer.rtpParameters,
                encodings: [{ ssrc: 12345678, rtx: { ssrc: 87654321 } }],
            },
        };
        const answer = buildAnswer([consumerWithRtx]);
        assert.ok(answer.includes('a=ssrc-group:FID 12345678 87654321'), 'should include FID group');
        assert.ok(answer.includes('a=ssrc:12345678 cname:whep'), 'should include primary SSRC');
        assert.ok(answer.includes('a=ssrc:87654321 cname:whep'), 'should include RTX SSRC');
    });

    it('includes codec fmtp parameters', () => {
        const answer = buildAnswer([mockVideoConsumer]);
        assert.ok(answer.includes('a=fmtp:96'), 'should include fmtp line');
        const fmtpLine = answer.split('\r\n').find(l => l.startsWith('a=fmtp:96'));
        assert.ok(fmtpLine.includes('profile-level-id=42e01f'), 'fmtp should contain profile-level-id');
        assert.ok(fmtpLine.includes('packetization-mode=1'), 'fmtp should contain packetization-mode');
    });

    it('includes rtcp-fb lines', () => {
        // The offer lists the feedback: rtcp-fb is answered only for what the viewer offered.
        const offerWithFeedback = SAMPLE_OFFER.replace(
            'a=rtpmap:96 H264/90000',
            ['a=rtpmap:96 H264/90000', 'a=rtcp-fb:96 nack', 'a=rtcp-fb:96 nack pli', 'a=rtcp-fb:96 transport-cc'].join('\r\n')
        );
        const answer = buildAnswer([mockVideoConsumer], offerWithFeedback);
        assert.ok(answer.includes('a=rtcp-fb:96 nack'), 'should include nack feedback');
        assert.ok(answer.includes('a=rtcp-fb:96 nack pli'), 'should include nack pli feedback');
        assert.ok(answer.includes('a=rtcp-fb:96 transport-cc'), 'should include transport-cc feedback');
    });
});

// ====================================================================
// createViewerAnswer: which offer sections may receive a consumer
// ====================================================================
describe('createViewerAnswer section eligibility', () => {
    const OFFER_HEAD = [
        'v=0',
        'o=- 123456 2 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
        'a=setup:actpass',
        'a=ice-ufrag:testufrag',
        'a=ice-pwd:testpwd1234567890123456',
    ];

    // Build an offer from section descriptions: { kind, port, direction, mid }.
    // direction null leaves out the direction attribute; mid null leaves out a=mid.
    function buildOffer(sections) {
        const mids = sections.filter((s) => s.mid != null).map((s) => s.mid);
        const lines = [...OFFER_HEAD];
        if (mids.length > 0) lines.push(`a=group:BUNDLE ${mids.join(' ')}`);
        for (const s of sections) {
            const pt = s.kind === 'video' ? 96 : 111;
            lines.push(`m=${s.kind} ${s.port === undefined ? 9 : s.port} UDP/TLS/RTP/SAVPF ${pt}`);
            lines.push('c=IN IP4 0.0.0.0');
            if (s.mid != null) lines.push(`a=mid:${s.mid}`);
            if (s.direction) lines.push(`a=${s.direction}`);
            lines.push('a=rtcp-mux');
            lines.push(s.kind === 'video' ? 'a=rtpmap:96 H264/90000' : 'a=rtpmap:111 opus/48000/2');
            if (s.kind === 'video') lines.push('a=fmtp:96 profile-level-id=42e01f;packetization-mode=1');
        }
        lines.push('');
        return lines.join('\r\n');
    }

    // Split an SDP into its session part and one array of lines per m-section.
    function splitSdp(sdp) {
        const lines = sdp.split('\r\n').filter((l) => l !== '');
        const sessionLines = [];
        const sections = [];
        for (const line of lines) {
            if (line.startsWith('m=')) sections.push([line]);
            else if (sections.length > 0) sections[sections.length - 1].push(line);
            else sessionLines.push(line);
        }
        return { sessionLines, sections };
    }

    function answerFor(offer, consumers) {
        const answer = createViewerAnswer(parseViewerOffer(offer), consumers, mockTransportParams);
        return { answer, ...splitSdp(answer) };
    }

    function assertRejected(section, kind, mid) {
        assert.match(section[0], new RegExp(`^m=${kind} 0 `), `section should be rejected with port 0: ${section[0]}`);
        assert.ok(section.includes('a=inactive'), 'rejected section should be a=inactive');
        assert.ok(!section.some((l) => l.startsWith('a=ssrc')), 'rejected section must not carry ssrc lines');
        assert.ok(!section.some((l) => l.startsWith('a=ice-ufrag')), 'rejected section must not carry ICE lines');
        if (mid != null) assert.ok(section.includes(`a=mid:${mid}`), `rejected section should echo a=mid:${mid}`);
        else assert.ok(!section.some((l) => l.startsWith('a=mid:')), 'no a=mid when the offer had none');
    }

    function assertActive(section, kind, mid, ssrc) {
        assert.match(section[0], new RegExp(`^m=${kind} 9 `), `section should be active: ${section[0]}`);
        assert.ok(section.includes(`a=mid:${mid}`), `active section should carry a=mid:${mid}`);
        assert.ok(section.includes('a=sendonly'));
        assert.ok(section.includes(`a=ssrc:${ssrc} cname:whep`), 'active section should carry the consumer ssrc');
    }

    function bundleOf(sessionLines) {
        return sessionLines.find((l) => l.startsWith('a=group:BUNDLE')) || null;
    }

    it('gives the video consumer to the active video section when a disabled (port 0) one comes first', () => {
        const offer = buildOffer([
            { kind: 'video', port: 0, direction: 'recvonly', mid: '0' },
            { kind: 'video', port: 9, direction: 'recvonly', mid: '1' },
            { kind: 'audio', port: 9, direction: 'recvonly', mid: '2' },
        ]);
        const { sessionLines, sections } = answerFor(offer, [mockVideoConsumer, mockAudioConsumer]);

        assert.equal(sections.length, 3, 'answer m-line count must equal the offer m-line count');
        assertRejected(sections[0], 'video', '0');
        assertActive(sections[1], 'video', '1', 12345678);
        assertActive(sections[2], 'audio', '2', 87654321);
        assert.equal(bundleOf(sessionLines), 'a=group:BUNDLE 1 2', 'the rejected mid stays out of BUNDLE');
    });

    it('gives the audio consumer to the active audio section when an a=inactive one comes first', () => {
        const offer = buildOffer([
            { kind: 'video', port: 9, direction: 'recvonly', mid: '0' },
            { kind: 'audio', port: 9, direction: 'inactive', mid: '1' },
            { kind: 'audio', port: 9, direction: 'recvonly', mid: '2' },
        ]);
        const { sessionLines, sections } = answerFor(offer, [mockVideoConsumer, mockAudioConsumer]);

        assert.equal(sections.length, 3, 'answer m-line count must equal the offer m-line count');
        assertActive(sections[0], 'video', '0', 12345678);
        assertRejected(sections[1], 'audio', '1');
        assertActive(sections[2], 'audio', '2', 87654321);
        assert.equal(bundleOf(sessionLines), 'a=group:BUNDLE 0 2');
    });

    it('answers every section as rejected, with no BUNDLE group, when all sections are disabled or inactive', () => {
        const offer = buildOffer([
            { kind: 'video', port: 0, direction: 'recvonly', mid: '0' },
            { kind: 'audio', port: 9, direction: 'inactive', mid: '1' },
            { kind: 'video', port: 0, direction: 'recvonly', mid: '2' },
        ]);
        const { answer, sessionLines, sections } = answerFor(offer, [mockVideoConsumer, mockAudioConsumer]);

        assert.equal(sections.length, 3, 'answer m-line count must equal the offer m-line count');
        assertRejected(sections[0], 'video', '0');
        assertRejected(sections[1], 'audio', '1');
        assertRejected(sections[2], 'video', '2');
        assert.equal(bundleOf(sessionLines), null, 'no BUNDLE group when nothing is active');
        assert.ok(!answer.includes('a=sendonly'));
    });

    it('does not give a consumer to a section the viewer only sends on (sendonly)', () => {
        const offer = buildOffer([
            { kind: 'video', port: 9, direction: 'sendonly', mid: '0' },
            { kind: 'video', port: 9, direction: 'recvonly', mid: '1' },
        ]);
        const { sessionLines, sections } = answerFor(offer, [mockVideoConsumer]);

        assert.equal(sections.length, 2);
        assertRejected(sections[0], 'video', '0');
        assertActive(sections[1], 'video', '1', 12345678);
        assert.equal(bundleOf(sessionLines), 'a=group:BUNDLE 1');
    });

    it('treats a section without a direction attribute as sendrecv and gives it the consumer', () => {
        const offer = buildOffer([
            { kind: 'video', port: 9, direction: null, mid: '0' },
            { kind: 'video', port: 9, direction: 'sendrecv', mid: '1' },
        ]);
        const { sections } = answerFor(offer, [mockVideoConsumer]);

        assert.equal(sections.length, 2);
        assertActive(sections[0], 'video', '0', 12345678);
        assertRejected(sections[1], 'video', '1');
    });

    it('rejects an eligible section that has no consumer left and keeps its position and mid', () => {
        const offer = buildOffer([
            { kind: 'video', port: 9, direction: 'recvonly', mid: 'v-a' },
            { kind: 'video', port: 9, direction: 'recvonly', mid: 'v-b' },
        ]);
        const { sessionLines, sections } = answerFor(offer, [mockVideoConsumer]);

        assert.equal(sections.length, 2);
        assertActive(sections[0], 'video', 'v-a', 12345678);
        assertRejected(sections[1], 'video', 'v-b');
        assert.equal(bundleOf(sessionLines), 'a=group:BUNDLE v-a');
    });

    it('omits a=mid from a rejected section when the offer had no mid for it', () => {
        const offer = buildOffer([
            { kind: 'video', port: 0, direction: 'recvonly', mid: null },
            { kind: 'video', port: 9, direction: 'recvonly', mid: null },
        ]);
        const { sections } = answerFor(offer, [mockVideoConsumer]);

        assert.equal(sections.length, 2);
        assertRejected(sections[0], 'video', null);
        assert.match(sections[1][0], /^m=video 9 /);
        assert.ok(sections[1].includes('a=ssrc:12345678 cname:whep'));
    });

    it('leaves the answer unchanged for an offer with one active section per kind', () => {
        const offer = buildOffer([
            { kind: 'video', port: 9, direction: 'recvonly', mid: '0' },
            { kind: 'audio', port: 9, direction: 'recvonly', mid: '1' },
        ]);
        const { sessionLines, sections } = answerFor(offer, [mockVideoConsumer, mockAudioConsumer]);

        assert.equal(sections.length, 2);
        assertActive(sections[0], 'video', '0', 12345678);
        assertActive(sections[1], 'audio', '1', 87654321);
        assert.equal(bundleOf(sessionLines), 'a=group:BUNDLE 0 1');
    });
});

// ====================================================================
// WHEP header extension and RTCP feedback negotiation
// ====================================================================
describe('WHEP header extension and RTCP feedback negotiation', () => {
    const EXT = {
        mid: 'urn:ietf:params:rtp-hdrext:sdes:mid',
        absSendTime: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
        transportCc: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
        audioLevel: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level',
        toffset: 'urn:ietf:params:rtp-hdrext:toffset',
        videoOrientation: 'urn:3gpp:video-orientation',
        playoutDelay: 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay',
    };

    function routerExt(kind, uri, preferredId) {
        return { kind, uri, preferredId, preferredEncrypt: false, direction: 'sendrecv' };
    }

    // The router's own capabilities with the ids mediasoup gives them
    // (mediasoup supportedRtpCapabilities, as router.rtpCapabilities returns them).
    const ROUTER_CAPABILITIES = {
        codecs: [
            {
                kind: 'video',
                mimeType: 'video/H264',
                preferredPayloadType: 102,
                clockRate: 90000,
                parameters: { 'level-asymmetry-allowed': 1, 'packetization-mode': 1, 'profile-level-id': '42e01f' },
                rtcpFeedback: [
                    { type: 'nack', parameter: '' },
                    { type: 'nack', parameter: 'pli' },
                    { type: 'ccm', parameter: 'fir' },
                    { type: 'goog-remb', parameter: '' },
                    { type: 'transport-cc', parameter: '' },
                ],
            },
            {
                kind: 'audio',
                mimeType: 'audio/opus',
                preferredPayloadType: 110,
                clockRate: 48000,
                channels: 2,
                parameters: {},
                rtcpFeedback: [
                    { type: 'nack', parameter: '' },
                    { type: 'transport-cc', parameter: '' },
                ],
            },
        ],
        headerExtensions: [
            routerExt('audio', EXT.mid, 1),
            routerExt('video', EXT.mid, 1),
            routerExt('audio', EXT.absSendTime, 4),
            routerExt('video', EXT.absSendTime, 4),
            routerExt('audio', EXT.transportCc, 5),
            routerExt('video', EXT.transportCc, 5),
            routerExt('audio', EXT.audioLevel, 6),
            routerExt('video', EXT.videoOrientation, 8),
            routerExt('video', EXT.toffset, 9),
            routerExt('audio', EXT.playoutDelay, 11),
            routerExt('video', EXT.playoutDelay, 11),
        ],
    };

    const OFFER_HEAD = [
        'v=0',
        'o=- 123456 2 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
        'a=setup:actpass',
        'a=ice-ufrag:testufrag',
        'a=ice-pwd:testpwd1234567890123456',
    ];

    const VIDEO_CODEC_LINES = [
        'a=rtpmap:102 H264/90000',
        'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    ];
    const AUDIO_CODEC_LINES = ['a=rtpmap:111 opus/48000/2'];

    // Build an offer from section descriptions:
    // { kind, mid, port, direction, ext: [[id, uri]], fb: ['102 nack'], codecLines, payloadTypes }.
    function buildOffer(sections) {
        const lines = [...OFFER_HEAD];
        lines.push(`a=group:BUNDLE ${sections.filter((s) => s.port !== 0).map((s) => s.mid).join(' ')}`);
        for (const s of sections) {
            const isVideo = s.kind === 'video';
            lines.push(`m=${s.kind} ${s.port === undefined ? 9 : s.port} UDP/TLS/RTP/SAVPF ${s.payloadTypes || (isVideo ? '102' : '111')}`);
            lines.push('c=IN IP4 0.0.0.0');
            lines.push(`a=mid:${s.mid}`);
            lines.push(`a=${s.direction || 'recvonly'}`);
            lines.push('a=rtcp-mux');
            lines.push(...(s.codecLines || (isVideo ? VIDEO_CODEC_LINES : AUDIO_CODEC_LINES)));
            for (const fb of (s.fb || [])) lines.push(`a=rtcp-fb:${fb}`);
            for (const [id, uri] of (s.ext || [])) lines.push(`a=extmap:${id} ${uri}`);
        }
        lines.push('');
        return lines.join('\r\n');
    }

    // Stand-in for the consumer mediasoup builds (ortc.getConsumerRtpParameters): the
    // consumer keeps a producer header extension only when a capability entry has the same
    // uri and a preferredId equal to the router's id, whatever the entry's kind; its codecs
    // take the capability codec's rtcpFeedback, and transport-cc / goog-remb are dropped
    // unless the matching header extension survived.
    function fakeConsumer(kind, capabilities, ssrc) {
        const codecs = [];
        for (const routerCodec of ROUTER_CAPABILITIES.codecs.filter((c) => c.kind === kind)) {
            const cap = capabilities.codecs.find((c) => c.preferredPayloadType === routerCodec.preferredPayloadType
                && c.mimeType === routerCodec.mimeType);
            if (!cap) continue;
            codecs.push({
                payloadType: routerCodec.preferredPayloadType,
                mimeType: routerCodec.mimeType,
                clockRate: routerCodec.clockRate,
                channels: routerCodec.channels,
                parameters: { ...routerCodec.parameters },
                rtcpFeedback: cap.rtcpFeedback.map((fb) => ({ ...fb })),
            });
        }
        // The producer sends every extension the router has for the kind.
        const headerExtensions = ROUTER_CAPABILITIES.headerExtensions
            .filter((ext) => ext.kind === kind)
            .map((ext) => ({ uri: ext.uri, id: ext.preferredId }))
            .filter((ext) => capabilities.headerExtensions.some((c) => c.preferredId === ext.id && c.uri === ext.uri));
        const has = (uri) => headerExtensions.some((ext) => ext.uri === uri);
        for (const codec of codecs) {
            if (has(EXT.transportCc)) {
                codec.rtcpFeedback = codec.rtcpFeedback.filter((fb) => fb.type !== 'goog-remb');
            } else if (has(EXT.absSendTime)) {
                codec.rtcpFeedback = codec.rtcpFeedback.filter((fb) => fb.type !== 'transport-cc');
            } else {
                codec.rtcpFeedback = codec.rtcpFeedback.filter((fb) => fb.type !== 'transport-cc' && fb.type !== 'goog-remb');
            }
        }
        return { kind, rtpParameters: { codecs, headerExtensions, encodings: [{ ssrc }] } };
    }

    // Offer -> capabilities -> consumers -> answer, the way lib/whepRoutes.js chains them.
    function negotiate(offerText) {
        const parsed = parseViewerOffer(offerText);
        const capabilities = buildViewerRtpCapabilities(parsed, ROUTER_CAPABILITIES);
        const consumers = [];
        if (parsed.video) consumers.push(fakeConsumer('video', capabilities, 1111));
        if (parsed.audio) consumers.push(fakeConsumer('audio', capabilities, 2222));
        const answer = createViewerAnswer(parsed, consumers, mockTransportParams);
        const sections = [];
        for (const line of answer.split('\r\n').filter((l) => l !== '')) {
            if (line.startsWith('m=')) sections.push([line]);
            else if (sections.length > 0) sections[sections.length - 1].push(line);
        }
        return { parsed, capabilities, consumers, answer, sections };
    }

    function answerExtmaps(sectionLines) {
        return sectionLines
            .filter((l) => l.startsWith('a=extmap:'))
            .map((l) => {
                const m = l.match(/^a=extmap:(\d+)\s+(\S+)$/);
                return { id: Number(m[1]), uri: m[2] };
            });
    }

    function answerFeedback(sectionLines, pt) {
        return sectionLines
            .filter((l) => l.startsWith(`a=rtcp-fb:${pt} `))
            .map((l) => l.slice(`a=rtcp-fb:${pt} `.length));
    }

    function pairKey(ext) {
        return `${ext.id} ${ext.uri}`;
    }

    // VAL-033: every extmap in an active section is an (id, uri) the offer listed for it,
    // equals a header extension of that section's consumer, and no id repeats.
    function assertExtmapsMatchOfferAndConsumer(sectionLines, offerSection, consumer) {
        const emitted = answerExtmaps(sectionLines);
        const offered = new Set(offerSection.extmap.map(pairKey));
        const consumerPairs = consumer.rtpParameters.headerExtensions.map(pairKey);
        for (const ext of emitted) {
            assert.ok(offered.has(pairKey(ext)), `answer extmap ${pairKey(ext)} was not offered`);
            assert.ok(consumerPairs.includes(pairKey(ext)), `answer extmap ${pairKey(ext)} is not on the consumer`);
        }
        const ids = emitted.map((ext) => ext.id);
        assert.equal(new Set(ids).size, ids.length, `duplicate extmap ids in one section: ${ids.join(',')}`);
        const uris = emitted.map((ext) => ext.uri);
        assert.equal(new Set(uris).size, uris.length, `duplicate extmap uris in one section: ${uris.join(',')}`);
    }

    const mediasoupNumberedOffer = () => buildOffer([
        {
            kind: 'video',
            mid: '0',
            ext: [[1, EXT.mid], [4, EXT.absSendTime], [5, EXT.transportCc], [9, EXT.toffset]],
            fb: ['102 nack', '102 nack pli', '102 goog-remb', '102 transport-cc'],
        },
        {
            kind: 'audio',
            mid: '1',
            ext: [[1, EXT.mid], [4, EXT.absSendTime], [5, EXT.transportCc], [6, EXT.audioLevel]],
            fb: ['111 transport-cc'],
        },
    ]);

    // What Chrome offers for recvonly video and audio transceivers: ids chosen by the browser.
    const chromeLikeOffer = () => buildOffer([
        {
            kind: 'video',
            mid: '0',
            ext: [
                [14, EXT.toffset], [2, EXT.absSendTime], [13, EXT.videoOrientation], [3, EXT.transportCc],
                [5, EXT.playoutDelay], [4, EXT.mid],
            ],
            fb: ['102 goog-remb', '102 transport-cc', '102 ccm fir', '102 nack', '102 nack pli'],
        },
        {
            kind: 'audio',
            mid: '1',
            ext: [[1, EXT.audioLevel], [2, EXT.absSendTime], [3, EXT.transportCc], [4, EXT.mid]],
            fb: ['111 transport-cc'],
        },
    ]);

    describe('parseViewerOffer rtcp-fb', () => {
        it('keeps a wildcard rtcp-fb line as payload type *', () => {
            const parsed = parseViewerOffer(buildOffer([
                { kind: 'video', mid: '0', fb: ['* nack', '102 nack pli'] },
            ]));
            assert.deepEqual(parsed.video.rtcpFb, [
                { payloadType: '*', type: 'nack' },
                { payloadType: 102, type: 'nack pli' },
            ]);
        });
    });

    describe('buildViewerRtpCapabilities', () => {
        it('keeps only the router header extensions the offer lists, per section kind', () => {
            const parsed = parseViewerOffer(buildOffer([
                { kind: 'video', mid: '0', ext: [[1, EXT.mid], [5, EXT.transportCc]] },
                { kind: 'audio', mid: '1', ext: [[1, EXT.mid], [5, EXT.transportCc], [6, EXT.audioLevel]] },
            ]));
            const { headerExtensions } = buildViewerRtpCapabilities(parsed, ROUTER_CAPABILITIES);
            assert.deepEqual(
                headerExtensions.map((ext) => `${ext.kind} ${ext.uri} ${ext.preferredId}`).sort(),
                [
                    `audio ${EXT.mid} 1`,
                    `audio ${EXT.transportCc} 5`,
                    `audio ${EXT.audioLevel} 6`,
                    `video ${EXT.mid} 1`,
                    `video ${EXT.transportCc} 5`,
                ].sort(),
                'abs-send-time, video-orientation, toffset and playout-delay were not offered'
            );
        });

        it('adds no header extension for an offer that lists none', () => {
            const parsed = parseViewerOffer(buildOffer([{ kind: 'video', mid: '0' }]));
            assert.deepEqual(buildViewerRtpCapabilities(parsed, ROUTER_CAPABILITIES).headerExtensions, []);
        });

        it('sets preferredId to the offered id, so the consumer drops an extension whose router id differs', () => {
            const parsed = parseViewerOffer(buildOffer([
                { kind: 'video', mid: '0', ext: [[1, EXT.mid], [2, EXT.absSendTime]] },
            ]));
            const capabilities = buildViewerRtpCapabilities(parsed, ROUTER_CAPABILITIES);
            const abs = capabilities.headerExtensions.find((ext) => ext.uri === EXT.absSendTime);
            assert.equal(abs.preferredId, 2, 'the offered id, not the router id 4');

            const consumer = fakeConsumer('video', capabilities, 1111);
            assert.deepEqual(consumer.rtpParameters.headerExtensions, [{ uri: EXT.mid, id: 1 }]);
        });

        it('does not take codecs or extensions from disabled or send-only sections', () => {
            const parsed = parseViewerOffer(buildOffer([
                { kind: 'video', mid: '0', port: 0, ext: [[4, EXT.absSendTime]] },
                { kind: 'video', mid: '1', direction: 'sendonly', ext: [[5, EXT.transportCc]] },
                { kind: 'video', mid: '2', ext: [[1, EXT.mid]] },
            ]));
            const { headerExtensions } = buildViewerRtpCapabilities(parsed, ROUTER_CAPABILITIES);
            assert.deepEqual(headerExtensions.map((ext) => ext.uri), [EXT.mid]);

            const sendOnly = parseViewerOffer(buildOffer([{ kind: 'video', mid: '0', direction: 'sendonly' }]));
            assert.deepEqual(buildViewerRtpCapabilities(sendOnly, ROUTER_CAPABILITIES).codecs, []);

            const disabled = parseViewerOffer(buildOffer([
                { kind: 'video', mid: '0', port: 0 },
                { kind: 'audio', mid: '1' },
            ]));
            assert.deepEqual(
                buildViewerRtpCapabilities(disabled, ROUTER_CAPABILITIES).codecs.map((c) => c.kind),
                ['audio'],
                'a disabled video section does not make video an active kind'
            );
        });

        it('limits each codec rtcpFeedback to the feedback the matched offer codec lists, wildcard included', () => {
            const parsed = parseViewerOffer(buildOffer([
                {
                    kind: 'video',
                    mid: '0',
                    payloadTypes: '102 100',
                    codecLines: [...VIDEO_CODEC_LINES, 'a=rtpmap:100 VP8/90000'],
                    fb: ['102 nack', '102 nack pli', '100 transport-cc', '* goog-remb'],
                },
            ]));
            const { codecs } = buildViewerRtpCapabilities(parsed, ROUTER_CAPABILITIES);
            const h264 = codecs.find((c) => c.mimeType === 'video/H264');
            assert.deepEqual(
                h264.rtcpFeedback.map((fb) => (fb.parameter ? `${fb.type} ${fb.parameter}` : fb.type)),
                ['nack', 'nack pli', 'goog-remb'],
                'transport-cc was offered for the VP8 payload type only; ccm fir was not offered'
            );
        });

        it('returns copies and leaves the router capabilities untouched', () => {
            const before = structuredClone(ROUTER_CAPABILITIES);
            const parsed = parseViewerOffer(mediasoupNumberedOffer());
            const capabilities = buildViewerRtpCapabilities(parsed, ROUTER_CAPABILITIES);
            for (const codec of capabilities.codecs) {
                assert.ok(!ROUTER_CAPABILITIES.codecs.includes(codec), 'a router codec object must not be handed out');
            }
            assert.deepEqual(ROUTER_CAPABILITIES, before);
        });

        it('keeps the router codec and payload type selection', () => {
            const parsed = parseViewerOffer(mediasoupNumberedOffer());
            const { codecs } = buildViewerRtpCapabilities(parsed, ROUTER_CAPABILITIES);
            assert.deepEqual(
                codecs.map((c) => [c.mimeType, c.preferredPayloadType]),
                [['video/H264', 102], ['audio/opus', 110]]
            );
        });

        it('does not let an extension offered for one kind reach the other kind consumer', () => {
            // mediasoup matches a consumer extension by uri and id whatever the capability kind.
            // Video offers abs-send-time at the router id 4; audio does not offer it at all.
            const parsed = parseViewerOffer(buildOffer([
                { kind: 'video', mid: '0', ext: [[4, EXT.absSendTime], [1, EXT.mid]] },
                { kind: 'audio', mid: '1', ext: [[1, EXT.mid]] },
            ]));
            const capabilities = buildViewerRtpCapabilities(parsed, ROUTER_CAPABILITIES);
            assert.deepEqual(
                fakeConsumer('audio', capabilities, 2222).rtpParameters.headerExtensions,
                [{ uri: EXT.mid, id: 1 }],
                'the audio consumer must not stamp an extension its section did not offer'
            );
            assert.ok(
                fakeConsumer('video', capabilities, 1111).rtpParameters.headerExtensions
                    .some((ext) => ext.uri === EXT.mid)
            );
        });
    });

    describe('createViewerAnswer extmap', () => {
        it('never writes an extmap the offer did not list, so ids cannot collide', () => {
            // The offer binds id 4 to sdes:mid. The consumer carries the router's mid (id 1)
            // and abs-send-time (router id 4), which the viewer never offered.
            const offer = buildOffer([{ kind: 'video', mid: '0', ext: [[4, EXT.mid]] }]);
            const consumer = {
                kind: 'video',
                rtpParameters: {
                    ...mockVideoConsumer.rtpParameters,
                    headerExtensions: [
                        { id: 1, uri: EXT.mid },
                        { id: 4, uri: EXT.absSendTime },
                    ],
                },
            };
            const parsed = parseViewerOffer(offer);
            const answer = createViewerAnswer(parsed, [consumer], mockTransportParams);
            const extmapLines = answer.split('\r\n').filter((l) => l.startsWith('a=extmap:'));
            assert.deepEqual(extmapLines, [], `nothing both offered and id-compatible, got ${extmapLines.join(' | ')}`);
        });

        it('writes an extmap only when the offer lists that uri with the id the consumer stamps', () => {
            const offer = buildOffer([
                { kind: 'video', mid: '0', ext: [[1, EXT.mid], [4, EXT.absSendTime], [7, EXT.toffset]] },
            ]);
            const consumer = {
                kind: 'video',
                rtpParameters: {
                    ...mockVideoConsumer.rtpParameters,
                    headerExtensions: [
                        { id: 1, uri: EXT.mid },
                        { id: 4, uri: EXT.absSendTime },
                        { id: 5, uri: EXT.transportCc },
                        { id: 9, uri: EXT.toffset },
                    ],
                },
            };
            const parsed = parseViewerOffer(offer);
            const answer = createViewerAnswer(parsed, [consumer], mockTransportParams);
            const [section] = answer.split('\r\nm=').slice(1).map((s) => `m=${s}`.split('\r\n'));
            assert.deepEqual(answerExtmaps(section), [
                { id: 1, uri: EXT.mid },
                { id: 4, uri: EXT.absSendTime },
            ]);
            assertExtmapsMatchOfferAndConsumer(section, parsed.video, consumer);
        });

        it('writes one line per id even when the consumer lists a repeated id', () => {
            const offer = buildOffer([
                { kind: 'video', mid: '0', ext: [[1, EXT.mid], [1, EXT.absSendTime]] },
            ]);
            const consumer = {
                kind: 'video',
                rtpParameters: {
                    ...mockVideoConsumer.rtpParameters,
                    headerExtensions: [
                        { id: 1, uri: EXT.mid },
                        { id: 1, uri: EXT.absSendTime },
                    ],
                },
            };
            const answer = createViewerAnswer(parseViewerOffer(offer), [consumer], mockTransportParams);
            assert.deepEqual(
                answer.split('\r\n').filter((l) => l.startsWith('a=extmap:')),
                [`a=extmap:1 ${EXT.mid}`]
            );
        });
    });

    describe('createViewerAnswer rtcp-fb', () => {
        it('writes only feedback the offer lists for the answered payload type or by wildcard, and the consumer has', () => {
            const offer = buildOffer([
                {
                    kind: 'video',
                    mid: '0',
                    payloadTypes: '102 100',
                    codecLines: [...VIDEO_CODEC_LINES, 'a=rtpmap:100 VP8/90000'],
                    // transport-cc is offered for the VP8 payload type only; ccm fir the consumer lacks.
                    fb: ['102 nack', '102 nack pli', '102 ccm fir', '100 transport-cc', '* goog-remb'],
                },
            ]);
            const consumer = {
                kind: 'video',
                rtpParameters: {
                    ...mockVideoConsumer.rtpParameters,
                    codecs: [{
                        payloadType: 102,
                        mimeType: 'video/H264',
                        clockRate: 90000,
                        parameters: { 'profile-level-id': '42e01f', 'packetization-mode': 1 },
                        rtcpFeedback: [
                            { type: 'nack', parameter: '' },
                            { type: 'nack', parameter: 'pli' },
                            { type: 'goog-remb', parameter: '' },
                            { type: 'transport-cc', parameter: '' },
                        ],
                    }],
                    headerExtensions: [],
                },
            };
            const answer = createViewerAnswer(parseViewerOffer(offer), [consumer], mockTransportParams);
            const [section] = answer.split('\r\nm=').slice(1).map((s) => `m=${s}`.split('\r\n'));
            assert.deepEqual(answerFeedback(section, 102), ['nack', 'nack pli', 'goog-remb']);
        });

        it('writes no rtcp-fb when the offer lists none', () => {
            const offer = buildOffer([{ kind: 'video', mid: '0' }]);
            const answer = createViewerAnswer(parseViewerOffer(offer), [mockVideoConsumer], mockTransportParams);
            assert.ok(!answer.includes('a=rtcp-fb:'), 'feedback the viewer never offered must not be advertised');
        });
    });

    describe('offer to answer with consumers shaped like mediasoup builds them', () => {
        it('negotiates every offered extension whose id equals the router id, with consistent ids', () => {
            const { parsed, consumers, sections } = negotiate(mediasoupNumberedOffer());
            assert.equal(sections.length, 2);

            const videoExt = answerExtmaps(sections[0]);
            assert.deepEqual(videoExt, [
                { id: 1, uri: EXT.mid },
                { id: 4, uri: EXT.absSendTime },
                { id: 5, uri: EXT.transportCc },
                { id: 9, uri: EXT.toffset },
            ]);
            assertExtmapsMatchOfferAndConsumer(sections[0], parsed.video, consumers[0]);
            assert.deepEqual(consumers[0].rtpParameters.headerExtensions.map(pairKey), videoExt.map(pairKey));

            const audioExt = answerExtmaps(sections[1]);
            assert.deepEqual(audioExt, [
                { id: 1, uri: EXT.mid },
                { id: 4, uri: EXT.absSendTime },
                { id: 5, uri: EXT.transportCc },
                { id: 6, uri: EXT.audioLevel },
            ]);
            assertExtmapsMatchOfferAndConsumer(sections[1], parsed.audio, consumers[1]);

            // transport-cc is negotiated, so goog-remb is dropped by the consumer and stays out.
            assert.deepEqual(answerFeedback(sections[0], 102), ['nack', 'nack pli', 'transport-cc']);
            assert.deepEqual(answerFeedback(sections[1], 111), ['transport-cc']);
        });

        it('negotiates no extension for a Chrome-like offer whose ids differ from the router ids, and says nothing unoffered', () => {
            // Chrome numbers mid 4, abs-send-time 2, transport-wide-cc 3 and so on. The consumer stamps
            // the router's ids, so none can be answered honestly: mid, abs-send-time and transport-wide-cc
            // are all dropped for this offer.
            const { parsed, consumers, sections } = negotiate(chromeLikeOffer());
            assert.equal(sections.length, 2);
            for (let i = 0; i < 2; i += 1) {
                assert.deepEqual(consumers[i].rtpParameters.headerExtensions, []);
                assert.deepEqual(answerExtmaps(sections[i]), []);
            }
            assertExtmapsMatchOfferAndConsumer(sections[0], parsed.video, consumers[0]);
            assertExtmapsMatchOfferAndConsumer(sections[1], parsed.audio, consumers[1]);

            // Without transport-cc or abs-send-time the consumer drops transport-cc and goog-remb feedback.
            assert.deepEqual(answerFeedback(sections[0], 102), ['nack', 'nack pli', 'ccm fir']);
            assert.deepEqual(answerFeedback(sections[1], 111), []);
        });

        it('keeps the answered payload types and codecs when extensions and feedback are filtered', () => {
            const { sections } = negotiate(chromeLikeOffer());
            assert.match(sections[0][0], /^m=video 9 UDP\/TLS\/RTP\/SAVPF 102$/);
            assert.ok(sections[0].includes('a=rtpmap:102 H264/90000'));
            assert.match(sections[1][0], /^m=audio 9 UDP\/TLS\/RTP\/SAVPF 111$/);
            assert.ok(sections[1].includes('a=rtpmap:111 opus/48000/2'));
        });
    });
});
