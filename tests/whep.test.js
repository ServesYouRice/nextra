const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseViewerOffer, parseViewerDtls, createViewerAnswer } = require('../lib/whep');

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
        assert.ok(
            answer.includes('a=extmap:4 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'),
            'should include transport-cc extmap'
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
        const answer = buildAnswer([mockVideoConsumer]);
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
