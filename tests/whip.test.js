const test = require('node:test');
const assert = require('node:assert/strict');

const { parseOffer, validateCodecs, toMediasoupRtpParameters } = require('../lib/whip');

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

test('WHIP parser prefers H.264 when OBS offers both AV1 and H.264', () => {
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

test('WHIP parser rejects AV1-only offers', () => {
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
