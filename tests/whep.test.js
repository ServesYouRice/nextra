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
