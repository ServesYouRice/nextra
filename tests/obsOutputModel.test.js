const test = require('node:test');
const assert = require('node:assert/strict');

const obsOutputModelModule = import('../src/lib/obsOutputModel.mjs');

test('AV1 OBS encoder requests fail clearly when no AV1 encoder candidates exist', async () => {
    const { normalizeObsEncoderRequest } = await obsOutputModelModule;

    const result = normalizeObsEncoderRequest({
        videoCodec: 'av1',
        obsEncoderIds: [],
    });

    assert.equal(result.error, 'No AV1 OBS encoders were configured for this host.');
});

test('AV1 live output patches avoid H.264-only encoder fields', async () => {
    const { buildLiveOutputPatch } = await obsOutputModelModule;

    const patch = buildLiveOutputPatch({
        encoderKind: 'nvenc',
        videoCodec: 'av1',
        bitrateKbps: 18000,
        keyframeIntervalSec: 2,
        preset: 'p5',
        nvencPreset: 'p6',
        nvencMultipass: 'fullres',
    });

    assert.equal(patch.profile, undefined);
    assert.equal(patch.tune, undefined);
    assert.equal(patch.bitrate, 18000);
});

test('Simple Output mirroring stays disabled for AV1 encoders', async () => {
    const { getSimpleOutputEncoderId } = await obsOutputModelModule;

    assert.equal(getSimpleOutputEncoderId('obs_nvenc_av1_tex', 'nvenc', 'av1'), null);
});
