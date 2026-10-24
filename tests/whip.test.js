const test = require('node:test');
const assert = require('node:assert/strict');

const { parseOffer, validateCodecs, toMediasoupRtpParameters, createAnswer } = require('../lib/whip');

function buildOffer(videoSection) {
    return [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        'a=group:BUNDLE 0 1',
        'a=ice-ufrag:testufrag',
        'a=ice-pwd:testpwd',
        'a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
        'a=setup:actpass',
        videoSection,
        'm=audio 9 UDP/TLS/RTP/SAVPF 111',
        'c=IN IP4 0.0.0.0',
        'a=mid:1',
        'a=sendonly',
        'a=rtpmap:111 opus/48000/2',
        'a=fmtp:111 minptime=10;useinbandfec=1',
        'a=ssrc:2222 cname:test',
        '',
    ].join('\r\n');
}

test('WHIP parser prefers H.264 when OBS offers both AV1 and H.264 in legacy rooms', () => {
    const offer = buildOffer([
        'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
        'c=IN IP4 0.0.0.0',
        'a=mid:0',
        'a=sendonly',
        'a=rtpmap:96 H264/90000',
        'a=fmtp:96 profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1',
        'a=rtcp-fb:96 nack',
        'a=rtpmap:97 AV1/90000',
        'a=rtcp-fb:97 nack',
        'a=ssrc:1111 cname:test',
    ].join('\r\n'));

    const parsed = parseOffer(offer);
    const validation = validateCodecs(parsed);
    const rtpParameters = toMediasoupRtpParameters(parsed);

    assert.equal(parsed.video.selectedCodec.codec, 'h264');
    assert.equal(validation.valid, true);
    assert.equal(validation.videoCodec, 'h264');
    assert.equal(rtpParameters.video.codecs[0].mimeType, 'video/H264');
    assert.equal(rtpParameters.video.codecs[0].parameters['profile-level-id'], '42e01f');
});

test('WHIP parser can require AV1 for AV1 OBS rooms', () => {
    const offer = buildOffer([
        'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
        'c=IN IP4 0.0.0.0',
        'a=mid:0',
        'a=sendonly',
        'a=rtpmap:96 H264/90000',
        'a=fmtp:96 profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1',
        'a=rtpmap:97 AV1/90000',
        'a=rtcp-fb:97 nack',
        'a=ssrc:1111 cname:test',
    ].join('\r\n'));

    const parsed = parseOffer(offer, { preferAv1: true });
    const validation = validateCodecs(parsed, {
        allowAv1: true,
        requiredVideoCodec: 'av1',
    });
    const rtpParameters = toMediasoupRtpParameters(parsed);

    assert.equal(parsed.video.selectedCodec.codec, 'av1');
    assert.equal(validation.valid, true);
    assert.equal(validation.videoCodec, 'av1');
    assert.equal(rtpParameters.video.codecs[0].mimeType, 'video/AV1');
});

test('WHIP parser picks the highest H.264 profile when AV1 is absent', () => {
    const offer = buildOffer([
        'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98',
        'c=IN IP4 0.0.0.0',
        'a=mid:0',
        'a=sendonly',
        'a=rtpmap:96 H264/90000',
        'a=fmtp:96 profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1',
        'a=rtpmap:97 H264/90000',
        'a=fmtp:97 profile-level-id=4d0032;packetization-mode=1;level-asymmetry-allowed=1',
        'a=rtpmap:98 H264/90000',
        'a=fmtp:98 profile-level-id=640032;packetization-mode=1;level-asymmetry-allowed=1',
        'a=ssrc:1111 cname:test',
    ].join('\r\n'));

    const parsed = parseOffer(offer);
    const validation = validateCodecs(parsed);

    assert.equal(parsed.video.selectedCodec.codec, 'h264');
    assert.equal(parsed.video.selectedCodec.profileLevelId, '640032');
    assert.equal(validation.valid, true);
    assert.equal(validation.videoCodec, 'h264');
});

test('WHIP validator rejects H.264 when the room requires AV1', () => {
    const offer = buildOffer([
        'm=video 9 UDP/TLS/RTP/SAVPF 96',
        'c=IN IP4 0.0.0.0',
        'a=mid:0',
        'a=sendonly',
        'a=rtpmap:96 H264/90000',
        'a=fmtp:96 profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1',
        'a=ssrc:1111 cname:test',
    ].join('\r\n'));

    const parsed = parseOffer(offer, { preferAv1: true });
    const validation = validateCodecs(parsed, {
        allowAv1: true,
        requiredVideoCodec: 'av1',
    });

    assert.equal(parsed.video.selectedCodec.codec, 'h264');
    assert.equal(validation.valid, false);
    assert.match(validation.warnings[0], /requires AV1/i);
});

test('WHIP parser rejects AV1-only offers for legacy rooms', () => {
    const offer = buildOffer([
        'm=video 9 UDP/TLS/RTP/SAVPF 97',
        'c=IN IP4 0.0.0.0',
        'a=mid:0',
        'a=sendonly',
        'a=rtpmap:97 AV1/90000',
        'a=rtcp-fb:97 nack',
        'a=ssrc:1111 cname:test',
    ].join('\r\n'));

    const parsed = parseOffer(offer);
    const validation = validateCodecs(parsed);

    assert.equal(parsed.video.selectedCodec, null);
    assert.equal(validation.valid, false);
    assert.match(validation.warnings[0], /requires H\.264/i);
});

// ── SDP answer structure (RFC 3264 §6, RFC 8843) ────────────────────────────

const SERVER_TRANSPORT = {
    iceParameters: { usernameFragment: 'srvufrag', password: 'srvpassword' },
    iceCandidates: [{ ip: '192.0.2.10', port: 40000, protocol: 'udp', type: 'host' }],
    dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB:CC:DD' }] },
};

function h264Video(mid, ssrc = 1111) {
    return [
        'm=video 9 UDP/TLS/RTP/SAVPF 96',
        'c=IN IP4 0.0.0.0',
        `a=mid:${mid}`,
        'a=sendonly',
        'a=rtpmap:96 H264/90000',
        'a=fmtp:96 profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1',
        `a=ssrc:${ssrc} cname:test`,
    ];
}

function vp8Video(mid) {
    return [
        'm=video 9 UDP/TLS/RTP/SAVPF 100',
        'c=IN IP4 0.0.0.0',
        `a=mid:${mid}`,
        'a=sendonly',
        'a=rtpmap:100 VP8/90000',
        'a=ssrc:5555 cname:test',
    ];
}

function opusAudio(mid) {
    return [
        'm=audio 9 UDP/TLS/RTP/SAVPF 111',
        'c=IN IP4 0.0.0.0',
        `a=mid:${mid}`,
        'a=sendonly',
        'a=rtpmap:111 opus/48000/2',
        'a=fmtp:111 minptime=10;useinbandfec=1',
        'a=ssrc:2222 cname:test',
    ];
}

function pcmuAudio(mid) {
    return [
        'm=audio 9 UDP/TLS/RTP/SAVPF 0 8',
        'c=IN IP4 0.0.0.0',
        `a=mid:${mid}`,
        'a=sendonly',
        'a=rtpmap:0 PCMU/8000',
        'a=rtpmap:8 PCMA/8000',
        'a=ssrc:2222 cname:test',
    ];
}

function dataChannel(mid) {
    return [
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        'c=IN IP4 0.0.0.0',
        `a=mid:${mid}`,
        'a=sctp-port:5000',
        'a=max-message-size:262144',
    ];
}

function offerWithSections(...sections) {
    const mids = sections.map((section) => section.find((line) => line.startsWith('a=mid:')).slice(6));
    return [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        `a=group:BUNDLE ${mids.join(' ')}`,
        'a=ice-ufrag:testufrag',
        'a=ice-pwd:testpwd',
        'a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
        'a=setup:actpass',
        ...sections.flat(),
        '',
    ].join('\r\n');
}

function readAnswer(answer) {
    const lines = answer.split('\r\n');
    const bundleLine = lines.find((line) => line.startsWith('a=group:BUNDLE'));
    const sections = [];
    for (const line of lines) {
        const mLine = line.match(/^m=(\S+) (\d+) (\S+) (.+)$/);
        if (mLine) {
            sections.push({
                kind: mLine[1],
                port: Number(mLine[2]),
                proto: mLine[3],
                formats: mLine[4].split(' '),
                lines: [],
            });
        } else if (sections.length > 0 && line) {
            sections[sections.length - 1].lines.push(line);
        }
    }
    for (const section of sections) {
        const midLine = section.lines.find((line) => line.startsWith('a=mid:'));
        section.mid = midLine ? midLine.slice(6) : null;
    }
    return {
        bundle: bundleLine ? bundleLine.slice('a=group:BUNDLE'.length).trim().split(/\s+/).filter(Boolean) : [],
        sections,
    };
}

function answerFor(t, offer, options) {
    const answer = createAnswer(parseOffer(offer, options), SERVER_TRANSPORT);
    // Keep the generated SDP in the test output for inspection.
    t.diagnostic(answer.trim().replace(/\r\n/g, ' | '));
    return readAnswer(answer);
}

function countOfferMLines(offer) {
    return offer.split('\r\n').filter((line) => line.startsWith('m=')).length;
}

function assertRejected(section, { kind, proto, format, mid }) {
    assert.equal(section.kind, kind);
    assert.equal(section.port, 0, `${kind} section must be rejected with port 0`);
    assert.equal(section.proto, proto);
    assert.deepEqual(section.formats, [format]);
    assert.equal(section.mid, mid);
    assert.ok(section.lines.includes('a=inactive'), 'a rejected section is inactive');
    for (const line of section.lines) {
        assert.doesNotMatch(line, /^a=(ice-|fingerprint|setup|candidate|end-of-candidates|rtcp-mux)/,
            `a rejected section carries no transport attribute (${line})`);
    }
}

test('WHIP answer for a video-first OBS offer keeps both accepted sections and their attributes', (t) => {
    const offer = offerWithSections(h264Video('0'), opusAudio('1'));
    const { bundle, sections } = answerFor(t, offer);

    assert.equal(sections.length, countOfferMLines(offer));
    assert.deepEqual(sections.map((section) => section.kind), ['video', 'audio']);
    assert.deepEqual(sections.map((section) => section.port), [9, 9]);
    assert.deepEqual(sections.map((section) => section.mid), ['0', '1']);
    assert.deepEqual(bundle, ['0', '1']);

    const [video, audio] = sections;
    assert.equal(video.proto, 'UDP/TLS/RTP/SAVPF');
    assert.deepEqual(video.formats, ['96']);
    for (const expected of [
        'c=IN IP4 0.0.0.0',
        'a=ice-ufrag:srvufrag',
        'a=ice-pwd:srvpassword',
        'a=fingerprint:sha-256 AA:BB:CC:DD',
        'a=setup:passive',
        'a=recvonly',
        'a=rtcp-mux',
        'a=rtpmap:96 H264/90000',
        'a=fmtp:96 profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1',
        'a=candidate:1 1 UDP 2130706431 192.0.2.10 40000 typ host',
        'a=end-of-candidates',
    ]) {
        assert.ok(video.lines.includes(expected), `video section keeps ${expected}`);
    }
    assert.deepEqual(audio.formats, ['111']);
    assert.ok(audio.lines.includes('a=rtpmap:111 OPUS/48000/2'));
    assert.ok(audio.lines.includes('a=fmtp:111 minptime=10;useinbandfec=1'));
    assert.ok(audio.lines.includes('a=recvonly'));
});

test('WHIP answer for an audio-first offer lists the sections in offer order', (t) => {
    const offer = offerWithSections(opusAudio('0'), h264Video('1'));
    const parsed = parseOffer(offer);
    const { bundle, sections } = answerFor(t, offer);

    assert.equal(sections.length, countOfferMLines(offer));
    assert.deepEqual(sections.map((section) => section.kind), ['audio', 'video']);
    assert.deepEqual(sections.map((section) => section.port), [9, 9]);
    assert.deepEqual(sections.map((section) => section.mid), ['0', '1']);
    assert.deepEqual(bundle, ['0', '1']);
    assert.ok(sections[0].lines.includes('a=rtpmap:111 OPUS/48000/2'));
    assert.ok(sections[1].lines.includes('a=rtpmap:96 H264/90000'));

    const rtpParameters = toMediasoupRtpParameters(parsed);
    assert.equal(rtpParameters.video.encodings[0].ssrc, 1111);
    assert.equal(rtpParameters.audio.encodings[0].ssrc, 2222);
});

test('WHIP answer rejects an audio section with no supported codec with port 0 in place', (t) => {
    const offer = offerWithSections(h264Video('0'), pcmuAudio('1'));
    const parsed = parseOffer(offer);
    const { bundle, sections } = answerFor(t, offer);

    assert.equal(sections.length, countOfferMLines(offer));
    assert.deepEqual(sections.map((section) => section.kind), ['video', 'audio']);
    assert.equal(sections[0].port, 9);
    assertRejected(sections[1], { kind: 'audio', proto: 'UDP/TLS/RTP/SAVPF', format: '0', mid: '1' });
    assert.deepEqual(bundle, ['0']);

    // The room still starts video-only, exactly as before.
    assert.equal(validateCodecs(parsed).valid, true);
    assert.equal(toMediasoupRtpParameters(parsed).audio, null);
});

test('WHIP answer rejects an application section with port 0 and keeps the other mids', (t) => {
    const offer = offerWithSections(h264Video('0'), dataChannel('1'), opusAudio('2'));
    const parsed = parseOffer(offer);
    const { bundle, sections } = answerFor(t, offer);

    assert.equal(parsed.video.mid, '0');
    assert.equal(parsed.audio.mid, '2');
    assert.equal(sections.length, countOfferMLines(offer));
    assert.deepEqual(sections.map((section) => section.kind), ['video', 'application', 'audio']);
    assert.deepEqual(sections.map((section) => section.mid), ['0', '1', '2']);
    assert.equal(sections[0].port, 9);
    assertRejected(sections[1], { kind: 'application', proto: 'UDP/DTLS/SCTP', format: 'webrtc-datachannel', mid: '1' });
    assert.equal(sections[2].port, 9);
    assert.deepEqual(bundle, ['0', '2']);
});

test('WHIP accepts only the first supported section of each kind and rejects the others', (t) => {
    const twoH264 = offerWithSections(h264Video('0', 1111), h264Video('1', 3333), opusAudio('2'));
    const parsedTwo = parseOffer(twoH264);
    const answerTwo = answerFor(t, twoH264);

    assert.equal(parsedTwo.video.mid, '0');
    assert.equal(toMediasoupRtpParameters(parsedTwo).video.encodings[0].ssrc, 1111);
    assert.equal(answerTwo.sections.length, countOfferMLines(twoH264));
    assert.deepEqual(answerTwo.sections.map((section) => section.kind), ['video', 'video', 'audio']);
    assert.equal(answerTwo.sections[0].port, 9);
    assertRejected(answerTwo.sections[1], { kind: 'video', proto: 'UDP/TLS/RTP/SAVPF', format: '96', mid: '1' });
    assert.deepEqual(answerTwo.bundle, ['0', '2']);

    const vp8First = offerWithSections(vp8Video('0'), h264Video('1'), opusAudio('2'));
    const parsedVp8 = parseOffer(vp8First);
    const answerVp8 = answerFor(t, vp8First);

    assert.equal(parsedVp8.video.mid, '1');
    assert.equal(validateCodecs(parsedVp8).valid, true);
    assertRejected(answerVp8.sections[0], { kind: 'video', proto: 'UDP/TLS/RTP/SAVPF', format: '100', mid: '0' });
    assert.equal(answerVp8.sections[1].port, 9);
    assert.ok(answerVp8.sections[1].lines.includes('a=rtpmap:96 H264/90000'));
    assert.deepEqual(answerVp8.bundle, ['1', '2']);
});

// ── RTCP feedback in the answer (RFC 4585 §4.2, RFC 5104) ────────────────────
//
// The answer carries a=rtcp-fb for each accepted codec: exactly the feedback
// the offer lists for that payload type (or with the '*' wildcard) that the
// producer is also configured with. The producer keeps forcing nack, nack pli
// and ccm fir for video; those are only answered when the offer asked for them.

// The a=rtcp-fb lines of one answer section, as '<pt> <feedback>' in answer order.
function rtcpFbLines(section) {
    return section.lines
        .filter((line) => line.startsWith('a=rtcp-fb:'))
        .map((line) => line.slice('a=rtcp-fb:'.length));
}

function h264VideoWithFeedback(mid, feedbackLines) {
    return [...h264Video(mid), ...feedbackLines];
}

function opusAudioWithFeedback(mid, feedbackLines) {
    return [...opusAudio(mid), ...feedbackLines];
}

const PRODUCER_FORCED_VIDEO_FEEDBACK = [
    { type: 'nack', parameter: '' },
    { type: 'nack', parameter: 'pli' },
    { type: 'ccm', parameter: 'fir' },
];

test('WHIP parser reads a=rtcp-fb for one payload type and for the * wildcard', () => {
    const offer = offerWithSections(
        h264VideoWithFeedback('0', ['a=rtcp-fb:96 nack pli', 'a=rtcp-fb:* ccm fir', 'a=rtcp-fb:* transport-cc']),
        opusAudio('1'),
    );
    const parsed = parseOffer(offer);

    assert.deepEqual(parsed.video.rtcpFb, [
        { payloadType: 96, type: 'nack pli' },
        { payloadType: '*', type: 'ccm fir' },
        { payloadType: '*', type: 'transport-cc' },
    ]);
    assert.deepEqual(parsed.audio.rtcpFb, []);
});

test('WHIP answer carries every offered feedback for the accepted payload type', (t) => {
    const offer = offerWithSections(
        h264VideoWithFeedback('0', [
            'a=rtcp-fb:96 goog-remb',
            'a=rtcp-fb:96 transport-cc',
            'a=rtcp-fb:96 ccm fir',
            'a=rtcp-fb:96 nack',
            'a=rtcp-fb:96 nack pli',
        ]),
        opusAudioWithFeedback('1', ['a=rtcp-fb:111 transport-cc']),
    );
    const { sections } = answerFor(t, offer);

    // Offered order first, then the producer's own order: stable for a given offer.
    assert.deepEqual(rtcpFbLines(sections[0]), [
        '96 goog-remb',
        '96 transport-cc',
        '96 ccm fir',
        '96 nack',
        '96 nack pli',
    ]);
    assert.deepEqual(rtcpFbLines(sections[1]), ['111 transport-cc']);
});

test('WHIP answer leaves out the forced feedback the offer did not ask for', (t) => {
    const offer = offerWithSections(
        h264VideoWithFeedback('0', ['a=rtcp-fb:96 nack', 'a=rtcp-fb:96 nack pli']),
        opusAudio('1'),
    );
    const parsed = parseOffer(offer);
    const { sections } = answerFor(t, offer);

    assert.deepEqual(rtcpFbLines(sections[0]), ['96 nack', '96 nack pli']);
    assert.deepEqual(rtcpFbLines(sections[1]), []);
    // Q-002: the producer still carries all three forced types, offered or not.
    assert.deepEqual(toMediasoupRtpParameters(parsed).video.codecs[0].rtcpFeedback, PRODUCER_FORCED_VIDEO_FEEDBACK);
});

test('WHIP answer applies a * wildcard to the accepted payload type, for what the producer supports', (t) => {
    const offer = offerWithSections(
        h264VideoWithFeedback('0', [
            'a=rtcp-fb:* nack',
            'a=rtcp-fb:* nack pli',
            'a=rtcp-fb:* ccm fir',
            // The producer is not configured for these, so they cannot be accepted.
            'a=rtcp-fb:* transport-cc',
            'a=rtcp-fb:* goog-remb',
        ]),
        opusAudioWithFeedback('1', ['a=rtcp-fb:* transport-cc']),
    );
    const parsed = parseOffer(offer);
    const { sections } = answerFor(t, offer);

    assert.deepEqual(rtcpFbLines(sections[0]), ['96 nack', '96 nack pli', '96 ccm fir']);
    // The audio producer carries no feedback configuration, so nothing is accepted for it.
    assert.deepEqual(rtcpFbLines(sections[1]), []);
    // A wildcard does not change what the producer is configured with.
    assert.deepEqual(toMediasoupRtpParameters(parsed).video.codecs[0].rtcpFeedback, PRODUCER_FORCED_VIDEO_FEEDBACK);
    assert.deepEqual(toMediasoupRtpParameters(parsed).audio.codecs[0].rtcpFeedback, []);
});

test('WHIP answer lists feedback once when the offer gives it for the payload type and with *', (t) => {
    const offer = offerWithSections(
        h264VideoWithFeedback('0', ['a=rtcp-fb:96 nack', 'a=rtcp-fb:* nack', 'a=rtcp-fb:* nack pli']),
        opusAudio('1'),
    );
    const { sections } = answerFor(t, offer);

    assert.deepEqual(rtcpFbLines(sections[0]), ['96 nack', '96 nack pli']);
});

test('WHIP answer has no a=rtcp-fb when the offer lists no feedback', (t) => {
    const offer = offerWithSections(h264Video('0'), opusAudio('1'));
    const parsed = parseOffer(offer);
    const { sections } = answerFor(t, offer);

    for (const section of sections) assert.deepEqual(rtcpFbLines(section), []);
    assert.deepEqual(toMediasoupRtpParameters(parsed).video.codecs[0].rtcpFeedback, PRODUCER_FORCED_VIDEO_FEEDBACK);
});

test('WHIP answer takes feedback only from the accepted payload type, never from another or from RTX', (t) => {
    const offer = offerWithSections([
        'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98',
        'c=IN IP4 0.0.0.0',
        'a=mid:0',
        'a=sendonly',
        'a=rtpmap:96 H264/90000',
        'a=fmtp:96 profile-level-id=42e01f;packetization-mode=1',
        'a=rtcp-fb:96 nack',
        'a=rtpmap:97 rtx/90000',
        'a=fmtp:97 apt=96',
        'a=rtcp-fb:97 nack',
        'a=rtcp-fb:97 nack pli',
        'a=rtpmap:98 H264/90000',
        'a=fmtp:98 profile-level-id=640032;packetization-mode=1',
        'a=rtcp-fb:98 ccm fir',
        'a=ssrc:1111 cname:test',
    ], opusAudio('1'));
    const parsed = parseOffer(offer);
    const { sections } = answerFor(t, offer);

    // The profile-level-id 640032 payload type is the one accepted.
    assert.equal(parsed.video.selectedCodec.payloadType, 98);
    assert.deepEqual(sections[0].formats, ['98']);
    assert.deepEqual(rtcpFbLines(sections[0]), ['98 ccm fir']);
    assert.ok(!sections[0].lines.some((line) => /^a=rtcp-fb:97 /.test(line)), 'no feedback line for the RTX payload type');
});

test('WHIP answer gives a rejected section no a=rtcp-fb', (t) => {
    const offer = offerWithSections(
        h264VideoWithFeedback('0', ['a=rtcp-fb:96 nack']),
        h264VideoWithFeedback('1', ['a=rtcp-fb:96 nack pli']),
        opusAudio('2'),
    );
    const { sections } = answerFor(t, offer);

    assert.deepEqual(rtcpFbLines(sections[0]), ['96 nack']);
    assert.equal(sections[1].port, 0);
    assert.deepEqual(rtcpFbLines(sections[1]), []);
});
