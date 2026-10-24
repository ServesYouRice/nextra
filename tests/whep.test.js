const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    parseViewerOffer, parseViewerDtls, createViewerAnswer, buildViewerRtpCapabilities,
    parseH264ProfileLevelId, isSameH264Profile, isH264Compatible,
} = require('../lib/whep');
const config = require('../config');
const ortc = require('mediasoup/ortc');

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
// a=setup in the answer
// ====================================================================
describe('WHEP answer a=setup matches the DTLS role given to mediasoup', () => {
    // parseViewerDtls gives transport.connect() the viewer's role; mediasoup then takes
    // the opposite one. The answer's a=setup states the server's role, so a remote role
    // 'server' (viewer offered passive) must be answered active, and 'client' passive
    // (RFC 4145 section 4.1: passive -> active, active -> passive, actpass -> either).
    const CASES = [
        { offered: 'actpass', role: 'client', answer: 'passive' },
        { offered: 'active', role: 'client', answer: 'passive' },
        { offered: 'passive', role: 'server', answer: 'active' },
    ];

    // SAMPLE_OFFER with its session-level a=setup:actpass replaced; setups maps a level
    // ('session') or a mid ('0' video, '1' audio) to the value written there.
    function offerWithSetups(setups) {
        const lines = SAMPLE_OFFER.split('\r\n').filter((line) => line !== 'a=setup:actpass');
        if (setups.session) lines.splice(lines.indexOf('a=ice-ufrag:testufrag'), 0, `a=setup:${setups.session}`);
        for (const mid of ['0', '1']) {
            if (setups[mid]) lines.splice(lines.indexOf(`a=mid:${mid}`) + 1, 0, `a=setup:${setups[mid]}`);
        }
        return lines.join('\r\n');
    }

    function answerSetups(answer) {
        return answer.split('\r\n')
            .filter((line) => line.startsWith('a=setup:'))
            .map((line) => line.slice('a=setup:'.length));
    }

    function answerFor(offer) {
        const parsed = parseViewerOffer(offer);
        return {
            role: parseViewerDtls(parsed).role,
            setups: answerSetups(createViewerAnswer(parsed, [mockVideoConsumer, mockAudioConsumer], mockTransportParams)),
        };
    }

    for (const { offered, role, answer } of CASES) {
        it(`answers a=setup:${answer} in every section for a session-level a=setup:${offered} offer, with remote role '${role}'`, () => {
            assert.deepEqual(answerFor(offerWithSetups({ session: offered })), { role, setups: [answer, answer] });
        });

        it(`answers a=setup:${answer} in every section for a media-level a=setup:${offered} offer, with remote role '${role}'`, () => {
            assert.deepEqual(answerFor(offerWithSetups({ 0: offered, 1: offered })), { role, setups: [answer, answer] });
        });
    }

    it("answers a=setup:passive for an offer with no a=setup, with remote role 'client'", () => {
        assert.deepEqual(answerFor(offerWithSetups({})), { role: 'client', setups: ['passive', 'passive'] });
    });

    it('reads the offered setup value case-insensitively (ABNF strings, RFC 5234 section 2.3)', () => {
        assert.deepEqual(answerFor(offerWithSetups({ session: 'PASSIVE' })), { role: 'server', setups: ['active', 'active'] });
    });

    it('takes one a=setup for every section from the section that supplies the DTLS parameters', () => {
        // One bundled transport, one DTLS role: the video section decides, as in parseViewerDtls.
        assert.deepEqual(answerFor(offerWithSetups({ 0: 'passive', 1: 'actpass' })), { role: 'server', setups: ['active', 'active'] });
        assert.deepEqual(answerFor(offerWithSetups({ 0: 'actpass', 1: 'passive' })), { role: 'client', setups: ['passive', 'passive'] });
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

    // The "(id uri)" pairs of the a=extmap lines in each m-section of an answer, in section order.
    function extmapPairsBySection(answer) {
        const sections = [];
        for (const line of answer.split('\r\n')) {
            if (line.startsWith('m=')) sections.push([]);
            else if (sections.length > 0) sections[sections.length - 1].push(line);
        }
        return sections.map((lines) => lines
            .map((line) => line.match(/^a=extmap:(\d+)\s+(\S+)$/))
            .filter(Boolean)
            .map((match) => `${match[1]} ${match[2]}`));
    }

    // RFC 8829 section 5.3.1: an answer lists only extensions its offer section lists, under the offered id.
    function assertExtmapsAreOffered(answer, parsed) {
        const answered = extmapPairsBySection(answer);
        assert.equal(answered.length, parsed._mediaSections.length, 'one answer section per offer section');
        answered.forEach((pairs, i) => {
            const offered = parsed._mediaSections[i].extmap.map((ext) => `${ext.id} ${ext.uri}`);
            for (const pair of pairs) {
                assert.ok(
                    offered.includes(pair),
                    `${parsed._mediaSections[i].kind} section answers extmap ${pair}, offered: ${offered.join(', ') || 'none'}`
                );
            }
        });
        return answered;
    }

    it('answers only extmaps that its offer section lists, with the offered id', () => {
        // mockVideoConsumer carries transport-wide-cc under id 4, which the offer's video section does not list.
        // mockAudioConsumer carries ssrc-audio-level under id 5, where the offer's audio section lists id 4.
        const parsed = parseViewerOffer(SAMPLE_OFFER);
        const answer = createViewerAnswer(parsed, [mockVideoConsumer, mockAudioConsumer], mockTransportParams);
        const [video] = assertExtmapsAreOffered(answer, parsed);
        assert.ok(video.includes('1 urn:ietf:params:rtp-hdrext:sdes:mid'), 'the offered sdes:mid stays in the video section');
    });

    it('answers the offered extension in its own section when the consumer carries the offered id', () => {
        const withExtensions = (consumer, headerExtensions) => ({
            ...consumer,
            rtpParameters: { ...consumer.rtpParameters, headerExtensions },
        });
        const video = withExtensions(mockVideoConsumer, [{ id: 1, uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' }]);
        const audio = withExtensions(mockAudioConsumer, [{ id: 4, uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level' }]);
        const parsed = parseViewerOffer(SAMPLE_OFFER);
        const answer = createViewerAnswer(parsed, [video, audio], mockTransportParams);
        assert.deepEqual(assertExtmapsAreOffered(answer, parsed), [
            ['1 urn:ietf:params:rtp-hdrext:sdes:mid'],
            ['4 urn:ietf:params:rtp-hdrext:ssrc-audio-level'],
        ]);
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
            assert.deepEqual(answerFeedback(sections[1], 110), ['transport-cc']);
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
            assert.deepEqual(answerFeedback(sections[1], 110), []);
        });

        it('keeps the answered payload types and codecs when extensions and feedback are filtered', () => {
            const { sections } = negotiate(chromeLikeOffer());
            assert.match(sections[0][0], /^m=video 9 UDP\/TLS\/RTP\/SAVPF 102$/);
            assert.ok(sections[0].includes('a=rtpmap:102 H264/90000'));
            assert.match(sections[1][0], /^m=audio 9 UDP\/TLS\/RTP\/SAVPF 110$/);
            assert.ok(sections[1].includes('a=rtpmap:110 opus/48000/2'));
        });
    });
});

// ====================================================================
// H.264 profile-level-id matching (answer matcher and capability filter)
// ====================================================================
describe('WHEP H.264 profile-level-id matching', () => {
    const OFFER_HEAD = [
        'v=0',
        'o=- 123456 2 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        'a=group:BUNDLE 0',
        'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
        'a=setup:actpass',
        'a=ice-ufrag:testufrag',
        'a=ice-pwd:testpwd1234567890123456',
    ];

    // A video-only recvonly offer. entries: [{ pt, params }] where params is the fmtp key/value
    // object of that H.264 payload type (an empty object writes no fmtp line).
    function h264Offer(entries, extraCodecLines = [], extraPayloadTypes = []) {
        const lines = [...OFFER_HEAD];
        lines.push(`m=video 9 UDP/TLS/RTP/SAVPF ${[...entries.map((e) => e.pt), ...extraPayloadTypes].join(' ')}`);
        lines.push('c=IN IP4 0.0.0.0', 'a=mid:0', 'a=recvonly', 'a=rtcp-mux');
        for (const { pt, params } of entries) {
            lines.push(`a=rtpmap:${pt} H264/90000`);
            const pairs = Object.entries(params).map(([k, v]) => `${k}=${v}`);
            if (pairs.length > 0) lines.push(`a=fmtp:${pt} ${pairs.join(';')}`);
        }
        lines.push(...extraCodecLines, '');
        return lines.join('\r\n');
    }

    // Parameters with a key only when its value is given ("absent" is a missing key).
    function fmtp(profileLevelId, packetizationMode, levelAsymmetryAllowed) {
        const params = {};
        if (profileLevelId !== undefined) params['profile-level-id'] = profileLevelId;
        if (packetizationMode !== undefined) params['packetization-mode'] = packetizationMode;
        if (levelAsymmetryAllowed !== undefined) params['level-asymmetry-allowed'] = levelAsymmetryAllowed;
        return params;
    }

    function h264RouterCodec(parameters, preferredPayloadType = 102) {
        return {
            kind: 'video',
            mimeType: 'video/H264',
            preferredPayloadType,
            clockRate: 90000,
            parameters,
            rtcpFeedback: [],
        };
    }

    const routerCapabilitiesOf = (...codecs) => ({ codecs, headerExtensions: [] });

    function consumerOf(codecParameters) {
        return {
            kind: 'video',
            rtpParameters: {
                codecs: [{
                    payloadType: 102,
                    mimeType: 'video/H264',
                    clockRate: 90000,
                    parameters: codecParameters,
                    rtcpFeedback: [],
                }],
                headerExtensions: [],
                encodings: [{ ssrc: 1111 }],
            },
        };
    }

    // Each row: the viewer's offered profile-level-id and the router's, and whether they match.
    // packetization-mode is 1 on both sides unless a row gives offerPm / routerPm (null = absent).
    // sameProfile is the profile comparison alone; it equals match unless the row differs in mode only.
    const PROFILE_ROWS = [
        { name: 'absent vs 42e01f', offer: undefined, router: '42e01f', match: true },
        { name: 'empty vs 42e01f', offer: '', router: '42e01f', match: true },
        { name: 'absent vs 42001f (Baseline)', offer: undefined, router: '42001f', match: false },
        { name: 'absent vs 640032 (High)', offer: undefined, router: '640032', match: false },
        { name: '42e01f vs 42001f (Constrained Baseline vs Baseline)', offer: '42e01f', router: '42001f', match: false },
        { name: '42E01F vs 42e01f (case)', offer: '42E01F', router: '42e01f', match: true },
        { name: '42e01f vs 42e034 (level ignored)', offer: '42e01f', router: '42e034', match: true },
        { name: '4d801f vs 42e01f (Constrained Baseline by 4d)', offer: '4d801f', router: '42e01f', match: true },
        { name: '640c1f vs 64001f (Constrained High vs High)', offer: '640c1f', router: '64001f', match: false },
        { name: '640032 vs 64001f (High, level ignored)', offer: '640032', router: '64001f', match: true },
        {
            name: '42e01f packetization-mode=1 vs 42e01f packetization-mode absent',
            offer: '42e01f', router: '42e01f', offerPm: '1', routerPm: null, match: false, sameProfile: true,
        },
        { name: 'zzzzzz vs 42e01f (unparseable)', offer: 'zzzzzz', router: '42e01f', match: false },
        { name: '4d001f vs 4d0032 (Main, level ignored)', offer: '4d001f', router: '4d0032', match: true },
        { name: '42001f vs 42001f (Baseline)', offer: '42001f', router: '42001f', match: true },
        { name: '42e0ff vs 42e01f (level mediasoup does not know)', offer: '42e0ff', router: '42e01f', match: false },
        { name: '42e01f0 vs 42e01f (seven digits)', offer: '42e01f0', router: '42e01f', match: false },
    ];

    function rowParams(row) {
        const offerPm = row.offerPm === undefined ? '1' : row.offerPm;
        const routerPm = row.routerPm === undefined ? 1 : row.routerPm;
        return {
            offer: fmtp(row.offer, offerPm === null ? undefined : offerPm),
            router: fmtp(row.router, routerPm === null ? undefined : routerPm, 1),
        };
    }

    describe('parseH264ProfileLevelId', () => {
        it('reads the profile from profile_idc and the profile-iop bits and defaults to 42e01f', () => {
            const cases = [
                [undefined, 'ConstrainedBaseline'],
                ['', 'ConstrainedBaseline'],
                ['42e01f', 'ConstrainedBaseline'],
                ['42401f', 'ConstrainedBaseline'],
                ['4d801f', 'ConstrainedBaseline'],
                ['58c01f', 'ConstrainedBaseline'],
                ['42001f', 'Baseline'],
                ['42801f', 'Baseline'],
                ['58801f', 'Baseline'],
                ['4d001f', 'Main'],
                ['4d401f', 'Main'],
                ['64001f', 'High'],
                ['640c1f', 'ConstrainedHigh'],
            ];
            for (const [value, profile] of cases) {
                const parsed = parseH264ProfileLevelId(value);
                assert.ok(parsed, `${JSON.stringify(value)} should parse`);
                assert.equal(parsed.profile, profile, `${JSON.stringify(value)} is ${profile}`);
            }
        });

        it('treats an absent or empty value as 42e01f (Constrained Baseline), not 42001f', () => {
            assert.deepEqual(parseH264ProfileLevelId(undefined), parseH264ProfileLevelId('42e01f'));
            assert.deepEqual(parseH264ProfileLevelId(''), parseH264ProfileLevelId('42e01f'));
            assert.notDeepEqual(parseH264ProfileLevelId(undefined), parseH264ProfileLevelId('42001f'));
        });

        it('returns null for anything that is not six hex digits of a known profile', () => {
            // null is not "absent" either: only undefined and the empty string take the default.
            for (const value of ['zzzzzz', '42e01', '42e01f0', '640c', '000000', '4e001f', '64001d', '64011f', 'f4001f', 12345, null]) {
                assert.equal(parseH264ProfileLevelId(value), null, `${JSON.stringify(value)} should not parse`);
            }
        });

        it('keeps the level apart from the profile', () => {
            assert.equal(parseH264ProfileLevelId('42e01f').profile, parseH264ProfileLevelId('42e034').profile);
            assert.notEqual(parseH264ProfileLevelId('42e01f').level, parseH264ProfileLevelId('42e034').level);
        });
    });

    describe('table of offer vs router profile-level-id', () => {
        for (const row of PROFILE_ROWS) {
            const { offer, router } = rowParams(row);
            const sameProfile = row.sameProfile === undefined ? row.match : row.sameProfile;

            it(`helper: ${row.name} => ${row.match ? 'match' : 'no match'}`, () => {
                assert.equal(isSameH264Profile(offer, router), sameProfile, 'isSameH264Profile');
                assert.equal(isH264Compatible(offer, router), row.match, 'isH264Compatible');
                assert.equal(isH264Compatible(router, offer), row.match, 'the comparison is symmetric');
            });

            it(`answer matcher: ${row.name} => ${row.match ? 'match' : 'no match'}`, () => {
                // The consumer sends payload type 102; the offer carries H.264 as 96 and asks for
                // nack pli on it. The answer declares the consumer's 102 either way; whether the
                // offer entry matched shows in the feedback, which the offer lists under its 96.
                const parsed = parseViewerOffer(h264Offer([{ pt: 96, params: offer }], ['a=rtcp-fb:96 nack pli']));
                const consumer = consumerOf(router);
                consumer.rtpParameters.codecs[0].rtcpFeedback = [{ type: 'nack', parameter: 'pli' }];
                const answer = createViewerAnswer(parsed, [consumer], mockTransportParams);
                assert.ok(answer.includes('a=rtpmap:102 H264/90000'), 'answered with the consumer payload type');
                assert.ok(!answer.includes('a=rtpmap:96 '), 'never with the offer payload type');
                assert.equal(
                    answer.includes('a=rtcp-fb:102 nack pli'),
                    row.match,
                    row.match ? 'the matched offer entry gives its feedback' : 'no offer entry matched, so none of its feedback'
                );
            });

            it(`capability filter: ${row.name} => ${row.match ? 'match' : 'no match'}`, () => {
                const parsed = parseViewerOffer(h264Offer([{ pt: 96, params: offer }]));
                const { codecs } = buildViewerRtpCapabilities(parsed, routerCapabilitiesOf(h264RouterCodec(router)));
                assert.equal(codecs.length, row.match ? 1 : 0);
                if (row.match) {
                    const offeredProfile = offer['profile-level-id'] ? offer['profile-level-id'].toLowerCase() : '42e01f';
                    assert.equal(codecs[0].parameters['profile-level-id'], offeredProfile, 'the viewer profile-level-id');
                    assert.equal(codecs[0].parameters['packetization-mode'], Number(offer['packetization-mode'] ?? 0));
                }
            });
        }
    });

    describe('buildViewerRtpCapabilities H.264 entries', () => {
        it('carries the viewer fmtp, not the router parameters, and leaves the router untouched', () => {
            // Router: High at level 5.0 with level asymmetry. Viewer: High at 3.1 without it.
            const router = routerCapabilitiesOf(h264RouterCodec(fmtp('640032', 1, 1)));
            const before = structuredClone(router);
            const parsed = parseViewerOffer(h264Offer([{ pt: 96, params: fmtp('64001F', '1') }]));
            const { codecs } = buildViewerRtpCapabilities(parsed, router);
            assert.equal(codecs.length, 1);
            assert.deepEqual(codecs[0].parameters, { 'profile-level-id': '64001f', 'packetization-mode': 1 });
            assert.equal(codecs[0].preferredPayloadType, 102);
            assert.equal(codecs[0].mimeType, 'video/H264');
            assert.equal(codecs[0].clockRate, 90000);
            assert.equal(codecs[0].kind, 'video');
            assert.deepEqual(router, before);
        });

        it('keeps the viewer level-asymmetry-allowed and writes packetization-mode as a number', () => {
            // mediasoup compares packetization-mode with !== against the producer's numeric value.
            const router = routerCapabilitiesOf(h264RouterCodec(fmtp('42e01f', 1, 1)));
            const parsed = parseViewerOffer(h264Offer([{ pt: 96, params: fmtp('42e01f', '1', '1') }]));
            const { codecs } = buildViewerRtpCapabilities(parsed, router);
            assert.deepEqual(codecs[0].parameters, {
                'profile-level-id': '42e01f', 'packetization-mode': 1, 'level-asymmetry-allowed': 1,
            });
        });

        it('writes 42e01f and packetization-mode 0 for a viewer entry that lists no fmtp at all', () => {
            const router = routerCapabilitiesOf(h264RouterCodec({}));
            const parsed = parseViewerOffer(h264Offer([{ pt: 96, params: {} }]));
            const { codecs } = buildViewerRtpCapabilities(parsed, router);
            assert.equal(codecs.length, 1);
            assert.deepEqual(codecs[0].parameters, { 'profile-level-id': '42e01f', 'packetization-mode': 0 });
        });

        it('emits one entry per distinct viewer parameter set and none for duplicates', () => {
            // Constrained Baseline twice over (42e01f, 4d801f), a repeat of 42e01f under another payload
            // type, and a packetization-mode 0 entry that cannot match the router's mode 1.
            const router = routerCapabilitiesOf(h264RouterCodec(fmtp('42e01f', 1, 1)));
            const parsed = parseViewerOffer(h264Offer([
                { pt: 96, params: fmtp('42e01f', '1') },
                { pt: 97, params: fmtp('42e01f', '0') },
                { pt: 98, params: fmtp('4d801f', '1') },
                { pt: 99, params: fmtp('42E01F', '1') },
            ]));
            const { codecs } = buildViewerRtpCapabilities(parsed, router);
            assert.deepEqual(
                codecs.map((c) => c.parameters),
                [
                    { 'profile-level-id': '42e01f', 'packetization-mode': 1 },
                    { 'profile-level-id': '4d801f', 'packetization-mode': 1 },
                ]
            );
            assert.equal(new Set(codecs.map((c) => c.parameters)).size, 2, 'separate parameter objects');
        });

        it('limits each entry rtcpFeedback to the feedback offered for its own payload types, wildcard included', () => {
            const router = routerCapabilitiesOf({
                ...h264RouterCodec(fmtp('42e01f', 1, 1)),
                rtcpFeedback: [
                    { type: 'nack', parameter: '' },
                    { type: 'nack', parameter: 'pli' },
                    { type: 'transport-cc', parameter: '' },
                ],
            });
            const offer = h264Offer(
                [
                    { pt: 96, params: fmtp('42e01f', '1') },
                    { pt: 98, params: fmtp('4d801f', '1') },
                ],
                ['a=rtcp-fb:96 nack', 'a=rtcp-fb:98 nack pli', 'a=rtcp-fb:* transport-cc']
            );
            const { codecs } = buildViewerRtpCapabilities(parseViewerOffer(offer), router);
            const feedbackOf = (c) => c.rtcpFeedback.map((fb) => (fb.parameter ? `${fb.type} ${fb.parameter}` : fb.type));
            assert.deepEqual(codecs.map((c) => c.parameters['profile-level-id']), ['42e01f', '4d801f']);
            assert.deepEqual(feedbackOf(codecs[0]), ['nack', 'transport-cc']);
            assert.deepEqual(feedbackOf(codecs[1]), ['nack pli', 'transport-cc']);
        });

        it('does not change non-H.264 matching', () => {
            const router = routerCapabilitiesOf(
                { kind: 'video', mimeType: 'video/VP8', preferredPayloadType: 101, clockRate: 90000, parameters: {}, rtcpFeedback: [] },
                h264RouterCodec(fmtp('640032', 1, 1)),
            );
            const parsed = parseViewerOffer(h264Offer(
                [{ pt: 96, params: fmtp('42e01f', '1') }],
                ['a=rtpmap:100 VP8/90000'],
                [100]
            ));
            const { codecs } = buildViewerRtpCapabilities(parsed, router);
            assert.deepEqual(codecs.map((c) => c.mimeType), ['video/VP8'], 'VP8 still matches by name and clock rate; High has no viewer entry');
            assert.deepEqual(codecs[0].parameters, {});
        });
    });

    describe('against the router profiles in config.MEDIA_CODECS', () => {
        // The router as mediasoup reports it: the configured codecs with payload types.
        const configured = config.MEDIA_CODECS.filter((codec) => /h264/i.test(codec.mimeType));
        const router = routerCapabilitiesOf(...configured.map((codec, i) => ({
            ...codec,
            preferredPayloadType: 102 + i,
            parameters: { ...codec.parameters },
            rtcpFeedback: [],
        })));

        function profilesFor(entries) {
            const parsed = parseViewerOffer(h264Offer(entries.map(([plid, pm], i) => ({
                pt: 96 + i,
                params: fmtp(plid, pm),
            }))));
            return buildViewerRtpCapabilities(parsed, router).codecs.map((c) => c.parameters['profile-level-id']);
        }

        it('configures 42e01f, 4d0032 and 640032 in packetization-mode 1', () => {
            assert.deepEqual(configured.map((c) => c.parameters['profile-level-id']), ['42e01f', '4d0032', '640032']);
            assert.ok(configured.every((c) => c.parameters['packetization-mode'] === 1));
        });

        it('matches a Chrome offer (42e01f, 42001f, 640c1f, 64001f, 4d001f)', () => {
            assert.deepEqual(
                profilesFor([
                    ['42e01f', '1'], ['42e01f', '0'], ['42001f', '1'], ['42001f', '0'],
                    ['640c1f', '1'], ['640c1f', '0'], ['64001f', '1'], ['4d001f', '1'],
                ]),
                ['42e01f', '4d001f', '64001f']
            );
        });

        it('matches an older Chrome offer (42e01f, 42001f, 640c1f, 64001f)', () => {
            assert.deepEqual(
                profilesFor([['42e01f', '1'], ['42e01f', '0'], ['42001f', '1'], ['640c1f', '1'], ['64001f', '1']]),
                ['42e01f', '64001f']
            );
        });

        it('matches a Firefox offer (42e01f, 42801f)', () => {
            assert.deepEqual(profilesFor([['42e01f', '1'], ['42e01f', '0'], ['42801f', '1'], ['42801f', '0']]), ['42e01f']);
        });

        it('matches a Safari offer (42e01f, 640c1f)', () => {
            assert.deepEqual(profilesFor([['42e01f', '1'], ['640c1f', '1']]), ['42e01f']);
        });

        it('matches only the 42e01f router codec for an offer that omits profile-level-id', () => {
            assert.deepEqual(profilesFor([[undefined, '1']]), ['42e01f']);
        });

        it('matches nothing for an offer whose only entries are Baseline or Constrained High', () => {
            assert.deepEqual(profilesFor([['42001f', '1'], ['640c1f', '1']]), []);
        });
    });
});

// ====================================================================
// Answered payload types: the consumer's own. mediasoup stamps the router's payload
// types on a consumer's RTP and cannot renumber them, so the answer declares those
// (owner decision for section-189067a43c5f50160f1b8635/Q-001: option a).
// ====================================================================
describe('WHEP answer payload types follow the consumer', () => {
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

    // sections: [{ kind, mid, payloadTypes: [..], lines: [rtpmap, fmtp, rtcp-fb lines] }]
    function buildOffer(sections) {
        const lines = [...OFFER_HEAD, `a=group:BUNDLE ${sections.map((s) => s.mid).join(' ')}`];
        for (const s of sections) {
            lines.push(
                `m=${s.kind} 9 UDP/TLS/RTP/SAVPF ${s.payloadTypes.join(' ')}`,
                'c=IN IP4 0.0.0.0',
                `a=mid:${s.mid}`,
                'a=recvonly',
                'a=rtcp-mux',
                ...s.lines
            );
        }
        lines.push('');
        return lines.join('\r\n');
    }

    // The lines of one offered codec: rtpmap, fmtp when given, and one rtcp-fb per feedback.
    function codecLines(pt, rtpmap, fmtpText, feedback = []) {
        const lines = [`a=rtpmap:${pt} ${rtpmap}`];
        if (fmtpText) lines.push(`a=fmtp:${pt} ${fmtpText}`);
        for (const fb of feedback) lines.push(`a=rtcp-fb:${pt} ${fb}`);
        return lines;
    }

    function sectionsOf(answer) {
        const sections = [];
        for (const line of answer.split('\r\n').filter((l) => l !== '')) {
            if (line.startsWith('m=')) sections.push([line]);
            else if (sections.length > 0) sections[sections.length - 1].push(line);
        }
        return sections;
    }

    function feedbackOf(sectionLines, pt) {
        return sectionLines
            .filter((l) => l.startsWith(`a=rtcp-fb:${pt} `))
            .map((l) => l.slice(`a=rtcp-fb:${pt} `.length));
    }

    // VAL-034: the payload types an answer section declares (m-line, rtpmap, fmtp, rtcp-fb,
    // and the apt of each RTX) are exactly the payload types of that section's consumer.
    function assertAnswerUsesConsumerPayloadTypes(sectionLines, consumer) {
        const codecs = consumer.rtpParameters.codecs;
        const consumerPts = codecs.map((c) => c.payloadType);
        assert.deepEqual(sectionLines[0].split(' ').slice(3).map(Number), consumerPts, `m-line ${sectionLines[0]}`);

        const rtpmap = new Map();
        const fmtp = new Map();
        for (const line of sectionLines) {
            let m = line.match(/^a=rtpmap:(\d+) (.+)$/);
            if (m) rtpmap.set(Number(m[1]), m[2]);
            m = line.match(/^a=fmtp:(\d+) (.+)$/);
            if (m) fmtp.set(Number(m[1]), m[2]);
            m = line.match(/^a=rtcp-fb:(\d+) /);
            if (m) assert.ok(consumerPts.includes(Number(m[1])), `${line} names a payload type the consumer does not send`);
        }
        assert.deepEqual([...rtpmap.keys()], consumerPts, 'rtpmap payload types');
        for (const pt of fmtp.keys()) assert.ok(consumerPts.includes(pt), `a=fmtp:${pt} names a payload type the consumer does not send`);
        for (const codec of codecs) {
            const name = codec.mimeType.split('/')[1];
            assert.equal(
                rtpmap.get(codec.payloadType),
                `${name}/${codec.clockRate}${codec.channels ? `/${codec.channels}` : ''}`,
                `rtpmap of payload type ${codec.payloadType}`
            );
            if (/\/rtx$/i.test(codec.mimeType)) {
                assert.equal(fmtp.get(codec.payloadType), `apt=${codec.parameters.apt}`, `apt of RTX payload type ${codec.payloadType}`);
            }
        }
    }

    const H264_FMTP = 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f';
    const h264Params = () => ({ 'level-asymmetry-allowed': 1, 'packetization-mode': 1, 'profile-level-id': '42e01f' });

    // A consumer as mediasoup builds it for an H.264 producer on this router: H.264 at 102
    // and its RTX at 103 (apt 102), the router's numbers.
    function routerH264Consumer(rtcpFeedback = []) {
        return {
            kind: 'video',
            rtpParameters: {
                codecs: [
                    { payloadType: 102, mimeType: 'video/H264', clockRate: 90000, parameters: h264Params(), rtcpFeedback },
                    { payloadType: 103, mimeType: 'video/rtx', clockRate: 90000, parameters: { apt: 102 }, rtcpFeedback: [] },
                ],
                headerExtensions: [],
                encodings: [{ ssrc: 1111, rtx: { ssrc: 1112 } }],
            },
        };
    }

    function routerOpusConsumer(rtcpFeedback = []) {
        return {
            kind: 'audio',
            rtpParameters: {
                codecs: [{
                    payloadType: 110,
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2,
                    parameters: { minptime: 10, useinbandfec: 1 },
                    rtcpFeedback,
                }],
                headerExtensions: [],
                encodings: [{ ssrc: 2222 }],
            },
        };
    }

    describe('with consumers whose router payload types differ from the offer', () => {
        it('answers the primary codec and its RTX (apt included) with the consumer payload types', () => {
            const offer = buildOffer([{
                kind: 'video',
                mid: '0',
                payloadTypes: [96, 97],
                lines: [...codecLines(96, 'H264/90000', H264_FMTP), ...codecLines(97, 'rtx/90000', 'apt=96')],
            }]);
            const consumer = routerH264Consumer();
            const [video] = sectionsOf(createViewerAnswer(parseViewerOffer(offer), [consumer], mockTransportParams));

            assert.equal(video[0], 'm=video 9 UDP/TLS/RTP/SAVPF 102 103');
            assert.ok(video.includes('a=rtpmap:102 H264/90000'));
            assert.ok(video.includes(`a=fmtp:102 ${H264_FMTP}`));
            assert.ok(video.includes('a=rtpmap:103 rtx/90000'));
            assert.ok(video.includes('a=fmtp:103 apt=102'), 'RTX apt names the payload type the consumer sends H.264 on');
            assert.ok(!video.some((l) => /^a=(rtpmap|fmtp):(96|97) /.test(l)), 'the offer numbering is not answered');
            assertAnswerUsesConsumerPayloadTypes(video, consumer);
        });

        it('answers the audio codec with the consumer payload type', () => {
            const offer = buildOffer([
                { kind: 'video', mid: '0', payloadTypes: [96], lines: codecLines(96, 'H264/90000', H264_FMTP) },
                { kind: 'audio', mid: '1', payloadTypes: [111], lines: codecLines(111, 'opus/48000/2', 'minptime=10;useinbandfec=1') },
            ]);
            const consumers = [routerH264Consumer(), routerOpusConsumer()];
            const [video, audio] = sectionsOf(createViewerAnswer(parseViewerOffer(offer), consumers, mockTransportParams));

            assert.equal(audio[0], 'm=audio 9 UDP/TLS/RTP/SAVPF 110');
            assert.ok(audio.includes('a=rtpmap:110 opus/48000/2'));
            assert.ok(!audio.some((l) => l.startsWith('a=rtpmap:111 ')));
            assertAnswerUsesConsumerPayloadTypes(video, consumers[0]);
            assertAnswerUsesConsumerPayloadTypes(audio, consumers[1]);
        });

        it('writes the feedback the offer lists for the matching codec under the consumer payload type', () => {
            const offer = buildOffer([{
                kind: 'video',
                mid: '0',
                payloadTypes: [96, 97],
                lines: [
                    ...codecLines(96, 'H264/90000', H264_FMTP, ['nack', 'nack pli']),
                    ...codecLines(97, 'rtx/90000', 'apt=96'),
                ],
            }]);
            const consumer = routerH264Consumer([
                { type: 'nack', parameter: '' },
                { type: 'nack', parameter: 'pli' },
                { type: 'ccm', parameter: 'fir' },
            ]);
            const [video] = sectionsOf(createViewerAnswer(parseViewerOffer(offer), [consumer], mockTransportParams));

            assert.deepEqual(feedbackOf(video, 102), ['nack', 'nack pli'], 'ccm fir was not offered');
            assert.deepEqual(feedbackOf(video, 96), []);
            assertAnswerUsesConsumerPayloadTypes(video, consumer);
        });

        it('keeps the consumer numbering where the offer uses those numbers for other codecs', () => {
            // Like Chrome: the router's H.264 102 / RTX 103 are VP8 and its RTX in this offer, and
            // the offer asks for goog-remb on VP8 only. The answer says what the wire carries, and
            // the feedback is the one offered for the H.264 entry, not for the offer's 102.
            const offer = buildOffer([{
                kind: 'video',
                mid: '0',
                payloadTypes: [96, 97, 102, 103],
                lines: [
                    ...codecLines(96, 'H264/90000', H264_FMTP, ['nack pli']),
                    ...codecLines(97, 'rtx/90000', 'apt=96'),
                    ...codecLines(102, 'VP8/90000', null, ['goog-remb']),
                    ...codecLines(103, 'rtx/90000', 'apt=102'),
                ],
            }]);
            const consumer = routerH264Consumer([
                { type: 'nack', parameter: 'pli' },
                { type: 'goog-remb', parameter: '' },
            ]);
            const [video] = sectionsOf(createViewerAnswer(parseViewerOffer(offer), [consumer], mockTransportParams));

            assert.equal(video[0], 'm=video 9 UDP/TLS/RTP/SAVPF 102 103');
            assert.ok(video.includes('a=rtpmap:102 H264/90000'));
            assert.ok(!video.some((l) => l.includes('VP8')), 'one meaning per payload type: no VP8 in the answer');
            assert.ok(video.includes('a=fmtp:103 apt=102'));
            assert.deepEqual(feedbackOf(video, 102), ['nack pli']);
            assertAnswerUsesConsumerPayloadTypes(video, consumer);
        });
    });

    describe('with an offer that already uses the router payload types', () => {
        it('yields the same answer as before', () => {
            const offer = buildOffer([
                {
                    kind: 'video',
                    mid: '0',
                    payloadTypes: [102, 103],
                    lines: [
                        ...codecLines(102, 'H264/90000', H264_FMTP, ['nack', 'nack pli']),
                        ...codecLines(103, 'rtx/90000', 'apt=102'),
                    ],
                },
                {
                    kind: 'audio',
                    mid: '1',
                    payloadTypes: [110],
                    lines: codecLines(110, 'opus/48000/2', 'minptime=10;useinbandfec=1', ['transport-cc']),
                },
            ]);
            const consumers = [
                routerH264Consumer([
                    { type: 'nack', parameter: '' },
                    { type: 'nack', parameter: 'pli' },
                    { type: 'ccm', parameter: 'fir' },
                ]),
                routerOpusConsumer([{ type: 'transport-cc', parameter: '' }]),
            ];
            const answer = createViewerAnswer(parseViewerOffer(offer), consumers, mockTransportParams);
            const common = (mid) => [
                'c=IN IP4 0.0.0.0',
                'a=rtcp:9 IN IP4 0.0.0.0',
                'a=ice-ufrag:serverufrag',
                'a=ice-pwd:serverpwd',
                `a=fingerprint:sha-256 ${mockTransportParams.dtlsParameters.fingerprints[0].value}`,
                'a=setup:passive',
                `a=mid:${mid}`,
                'a=sendonly',
                'a=rtcp-mux',
                'a=rtcp-rsize',
            ];
            const candidate = ['a=candidate:1 1 UDP 2130706431 192.168.1.100 40000 typ host', 'a=end-of-candidates'];
            // The answer the code gave before this change, for the same input.
            assert.deepEqual(sectionsOf(answer), [
                [
                    'm=video 9 UDP/TLS/RTP/SAVPF 102 103',
                    ...common('0'),
                    'a=rtpmap:102 H264/90000',
                    `a=fmtp:102 ${H264_FMTP}`,
                    'a=rtcp-fb:102 nack',
                    'a=rtcp-fb:102 nack pli',
                    'a=rtpmap:103 rtx/90000',
                    'a=fmtp:103 apt=102',
                    'a=ssrc-group:FID 1111 1112',
                    'a=ssrc:1111 cname:whep',
                    'a=ssrc:1112 cname:whep',
                    ...candidate,
                ],
                [
                    'm=audio 9 UDP/TLS/RTP/SAVPF 110',
                    ...common('1'),
                    'a=rtpmap:110 opus/48000/2',
                    'a=fmtp:110 minptime=10;useinbandfec=1',
                    'a=rtcp-fb:110 transport-cc',
                    'a=ssrc:2222 cname:whep',
                    ...candidate,
                ],
            ]);
            assert.ok(answer.includes('\r\na=group:BUNDLE 0 1\r\n'));
        });
    });

    // Offer -> buildViewerRtpCapabilities -> the consumer rtpParameters mediasoup's own ortc code
    // derives (what Transport.consume() hands the worker) -> createViewerAnswer.
    describe('with consumers built by the mediasoup ortc code from config.MEDIA_CODECS', () => {
        const routerCapabilities = ortc.generateRouterRtpCapabilities(structuredClone(config.MEDIA_CODECS));
        const VIDEO_FB = ['goog-remb', 'transport-cc', 'ccm fir', 'nack', 'nack pli'];

        // The recvonly offer of Chromium 153 (codec subset, its numbering): VP8 96, VP9 profile 2
        // at 100, H.264 42001f at 102, H.264 42e01f at 108, opus 111, telephone-event/48000 at 110.
        const chromeOffer = () => buildOffer([
            {
                kind: 'video',
                mid: '0',
                payloadTypes: [96, 97, 100, 101, 102, 103, 108, 109, 116, 117, 45, 46],
                lines: [
                    ...codecLines(96, 'VP8/90000', null, VIDEO_FB),
                    ...codecLines(97, 'rtx/90000', 'apt=96'),
                    ...codecLines(100, 'VP9/90000', 'profile-id=2', VIDEO_FB),
                    ...codecLines(101, 'rtx/90000', 'apt=100'),
                    ...codecLines(102, 'H264/90000', 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f', VIDEO_FB),
                    ...codecLines(103, 'rtx/90000', 'apt=102'),
                    ...codecLines(108, 'H264/90000', H264_FMTP, VIDEO_FB),
                    ...codecLines(109, 'rtx/90000', 'apt=108'),
                    ...codecLines(116, 'H264/90000', 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f', VIDEO_FB),
                    ...codecLines(117, 'rtx/90000', 'apt=116'),
                    ...codecLines(45, 'AV1/90000', 'level-idx=5;profile=0;tier=0', VIDEO_FB),
                    ...codecLines(46, 'rtx/90000', 'apt=45'),
                ],
            },
            {
                kind: 'audio',
                mid: '1',
                payloadTypes: [111, 63, 110],
                lines: [
                    ...codecLines(111, 'opus/48000/2', 'minptime=10;useinbandfec=1', ['transport-cc']),
                    ...codecLines(63, 'red/48000/2', '111/111'),
                    ...codecLines(110, 'telephone-event/48000'),
                ],
            },
        ]);

        // The recvonly offer of Firefox 155 (codec subset, its numbering): VP8 120, H.264 42e01f at
        // 126, AV1 99 with its RTX at 100, opus 109.
        const firefoxOffer = () => buildOffer([
            {
                kind: 'video',
                mid: '0',
                payloadTypes: [120, 124, 126, 127, 99, 100],
                lines: [
                    ...codecLines(120, 'VP8/90000', 'max-fs=12288;max-fr=60', ['nack', 'nack pli', 'ccm fir', 'goog-remb', 'transport-cc']),
                    ...codecLines(124, 'rtx/90000', 'apt=120'),
                    ...codecLines(126, 'H264/90000', 'profile-level-id=42e01f;level-asymmetry-allowed=1;packetization-mode=1', ['nack', 'nack pli', 'ccm fir']),
                    ...codecLines(127, 'rtx/90000', 'apt=126'),
                    ...codecLines(99, 'AV1/90000', null, ['nack', 'nack pli']),
                    ...codecLines(100, 'rtx/90000', 'apt=99'),
                ],
            },
            {
                kind: 'audio',
                mid: '1',
                payloadTypes: [109],
                lines: codecLines(109, 'opus/48000/2', 'maxplaybackrate=48000;stereo=1;useinbandfec=1'),
            },
        ]);

        // Producers as they reach the router: the host browser's VP8 with RTX, OBS's H.264 over
        // WHIP (no RTX), opus. Each in the producer's own numbering, as mediasoup receives it.
        const PRODUCERS = {
            vp8: {
                kind: 'video',
                rtpParameters: {
                    mid: '0',
                    codecs: [
                        { mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, parameters: {}, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }] },
                        { mimeType: 'video/rtx', payloadType: 97, clockRate: 90000, parameters: { apt: 96 }, rtcpFeedback: [] },
                    ],
                    headerExtensions: [],
                    encodings: [{ ssrc: 5001, rtx: { ssrc: 5002 } }],
                    rtcp: { cname: 'host' },
                },
            },
            h264: {
                kind: 'video',
                rtpParameters: {
                    mid: '0',
                    codecs: [{ mimeType: 'video/H264', payloadType: 96, clockRate: 90000, parameters: h264Params(), rtcpFeedback: [{ type: 'nack', parameter: 'pli' }] }],
                    headerExtensions: [],
                    encodings: [{ ssrc: 6001 }],
                    rtcp: { cname: 'obs' },
                },
            },
            opus: {
                kind: 'audio',
                rtpParameters: {
                    mid: '1',
                    codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2, parameters: { useinbandfec: 1 }, rtcpFeedback: [] }],
                    headerExtensions: [],
                    encodings: [{ ssrc: 7001 }],
                    rtcp: { cname: 'host' },
                },
            },
        };

        // What Transport.produce() and Transport.consume() compute in mediasoup.
        function consumableOf(producer) {
            const params = structuredClone(producer.rtpParameters);
            ortc.validateAndNormalizeRtpParameters(params);
            const mapping = ortc.getProducerRtpParametersMapping(params, routerCapabilities);
            return ortc.getConsumableRtpParameters(producer.kind, params, routerCapabilities, mapping);
        }

        function consume(producer, viewerCapabilities) {
            const caps = structuredClone(viewerCapabilities);
            ortc.validateAndNormalizeRtpCapabilities(caps);
            const consumable = consumableOf(producer);
            assert.ok(ortc.canConsume(consumable, caps), `the viewer can consume the ${producer.rtpParameters.codecs[0].mimeType} producer`);
            const rtpParameters = ortc.getConsumerRtpParameters({
                consumableRtpParameters: consumable,
                remoteRtpCapabilities: caps,
                pipe: false,
                enableRtx: producer.kind === 'video',
            });
            return { kind: producer.kind, rtpParameters };
        }

        function negotiate(offerText, producers) {
            const parsed = parseViewerOffer(offerText);
            const capabilities = buildViewerRtpCapabilities(parsed, routerCapabilities);
            const consumers = producers.map((producer) => consume(producer, capabilities));
            const sections = sectionsOf(createViewerAnswer(parsed, consumers, mockTransportParams));
            return { consumers, sections };
        }

        const codecSummary = (consumer) => consumer.rtpParameters.codecs
            .map((c) => `${c.payloadType} ${c.mimeType}${c.parameters.apt !== undefined ? ` apt=${c.parameters.apt}` : ''}`);

        it('router numbering: VP8 100 + RTX 101, H.264 42e01f 102 + RTX 103, opus 110', () => {
            const pts = routerCapabilities.codecs.map((c) => `${c.preferredPayloadType} ${c.mimeType}`);
            for (const entry of ['100 video/VP8', '101 video/rtx', '102 video/H264', '103 video/rtx', '110 audio/opus']) {
                assert.ok(pts.includes(entry), `${entry} in ${pts.join(', ')}`);
            }
        });

        it('Chromium offer, host VP8 and opus: the answer declares 100/101 and 110, the payload types sent', () => {
            const { consumers, sections } = negotiate(chromeOffer(), [PRODUCERS.vp8, PRODUCERS.opus]);
            assert.deepEqual(codecSummary(consumers[0]), ['100 video/VP8', '101 video/rtx apt=100']);
            assert.deepEqual(codecSummary(consumers[1]), ['110 audio/opus']);
            assertAnswerUsesConsumerPayloadTypes(sections[0], consumers[0]);
            assertAnswerUsesConsumerPayloadTypes(sections[1], consumers[1]);
            // The VP8 feedback the offer lists under its 96, without what the consumer dropped
            // (no transport-cc or abs-send-time extension is negotiated for these ids).
            assert.deepEqual(feedbackOf(sections[0], 100), ['nack', 'nack pli', 'ccm fir']);
        });

        it('Chromium offer, OBS H.264: the answer declares 102/103, not the offer 108/109', () => {
            const { consumers, sections } = negotiate(chromeOffer(), [PRODUCERS.h264]);
            assert.deepEqual(codecSummary(consumers[0]), ['102 video/H264', '103 video/rtx apt=102']);
            assertAnswerUsesConsumerPayloadTypes(sections[0], consumers[0]);
            assert.ok(sections[0].includes(`a=fmtp:102 ${H264_FMTP}`));
        });

        it('Firefox offer, host VP8, OBS H.264 and opus: the answer declares the consumer payload types', () => {
            for (const video of [PRODUCERS.vp8, PRODUCERS.h264]) {
                const { consumers, sections } = negotiate(firefoxOffer(), [video, PRODUCERS.opus]);
                assertAnswerUsesConsumerPayloadTypes(sections[0], consumers[0]);
                assertAnswerUsesConsumerPayloadTypes(sections[1], consumers[1]);
                assert.equal(consumers[1].rtpParameters.codecs[0].payloadType, 110);
            }
        });

        it('an offer numbered like the router gets the router numbers, as before', () => {
            const offer = buildOffer([
                {
                    kind: 'video',
                    mid: '0',
                    payloadTypes: [100, 101],
                    lines: [...codecLines(100, 'VP8/90000', null, ['nack', 'nack pli']), ...codecLines(101, 'rtx/90000', 'apt=100')],
                },
                { kind: 'audio', mid: '1', payloadTypes: [110], lines: codecLines(110, 'opus/48000/2', 'useinbandfec=1') },
            ]);
            const { consumers, sections } = negotiate(offer, [PRODUCERS.vp8, PRODUCERS.opus]);
            assert.equal(sections[0][0], 'm=video 9 UDP/TLS/RTP/SAVPF 100 101');
            assert.equal(sections[1][0], 'm=audio 9 UDP/TLS/RTP/SAVPF 110');
            assertAnswerUsesConsumerPayloadTypes(sections[0], consumers[0]);
            assertAnswerUsesConsumerPayloadTypes(sections[1], consumers[1]);
        });
    });
});
