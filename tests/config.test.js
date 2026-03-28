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
