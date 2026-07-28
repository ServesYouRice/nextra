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

test('masked GPU detection tries a bounded cross-vendor AV1 encoder list', async () => {
    const { getAv1EncoderCandidates } = await obsOutputModelModule;

    const masked = getAv1EncoderCandidates('ANGLE (masked renderer)');
    assert.deepEqual(masked, [
        'obs_nvenc_av1_tex',
        'jim_av1_nvenc',
        'ffmpeg_nvenc_av1',
        'av1_texture_amf',
        'obs_amf_av1',
        'amd_amf_av1',
        'obs_qsv11_av1',
        'obs_qsv_av1',
    ]);
    assert.equal(new Set(masked).size, masked.length);

    const amd = getAv1EncoderCandidates('AMD Radeon RX 7900');
    assert.equal(amd[0], 'av1_texture_amf');
    assert.ok(amd.includes('obs_nvenc_av1_tex'));
    assert.ok(amd.includes('obs_qsv11_av1'));
});
