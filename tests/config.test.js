const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config');

test('Opus codec keeps in-band FEC enabled without forcing DTX', () => {
    const opusCodec = config.MEDIA_CODECS.find(
        (codec) => codec.kind === 'audio' && codec.mimeType === 'audio/opus'
    );

    assert.ok(opusCodec, 'Expected an Opus audio codec entry.');
    assert.equal(opusCodec.parameters?.useinbandfec, 1);
    assert.equal(opusCodec.parameters?.usedtx, undefined);
});

test('Router media codecs do not advertise AV1 in the stable relay build', () => {
    const av1Codec = config.MEDIA_CODECS.find(
        (codec) => codec.kind === 'video' && codec.mimeType === 'video/AV1'
    );

    assert.equal(av1Codec, undefined);
});

test('bitrate defaults reflect the finalized H.264 plan', () => {
    assert.equal(config.CODEC_OPTIONS.videoGoogleStartBitrate, 5_000);
    assert.equal(config.RELAY_VIDEO_BITS_PER_SECOND, 45_000_000);
});
