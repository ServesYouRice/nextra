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

test('buildLiveOutputPatch generates exact patch shapes across encoder kinds and codecs', async () => {
    const { buildLiveOutputPatch } = await obsOutputModelModule;

    const baseParams = {
        bitrateKbps: 18000,
        keyframeIntervalSec: 2,
        preset: 'veryfast',
        nvencPreset: 'p6',
        nvencMultipass: 'fullres',
    };

    const cases = [
        {
            name: 'nvenc + h264',
            input: { ...baseParams, encoderKind: 'nvenc', videoCodec: 'h264' },
            expected: {
                bitrate: 18000,
                rate_control: 'CBR',
                keyint_sec: 2,
                lookahead: false,
                multipass: 'fullres',
                preset2: 'p6',
                tune: 'll',
                profile: 'high',
            },
        },
        {
            name: 'nvenc + av1',
            input: { ...baseParams, encoderKind: 'nvenc', videoCodec: 'av1' },
            expected: {
                bitrate: 18000,
                rate_control: 'CBR',
                keyint_sec: 2,
                lookahead: false,
                multipass: 'fullres',
                preset2: 'p6',
            },
        },
        {
            name: 'x264 + h264',
            input: { ...baseParams, encoderKind: 'x264', videoCodec: 'h264' },
            expected: {
                bitrate: 18000,
                rate_control: 'CBR',
                keyint_sec: 2,
                preset: 'veryfast',
                profile: 'high',
                tune: 'zerolatency',
                x264opts: 'bframes=0',
            },
        },
        {
            name: 'x264 + av1',
            input: { ...baseParams, encoderKind: 'x264', videoCodec: 'av1' },
            expected: {
                bitrate: 18000,
                rate_control: 'CBR',
                keyint_sec: 2,
            },
        },
        {
            name: 'amf + h264',
            input: { ...baseParams, encoderKind: 'amf', videoCodec: 'h264' },
            expected: {
                bitrate: 18000,
                rate_control: 'CBR',
                keyint_sec: 2,
                profile: 'high',
            },
        },
        {
            name: 'amf + av1',
            input: { ...baseParams, encoderKind: 'amf', videoCodec: 'av1' },
            expected: {
                bitrate: 18000,
                rate_control: 'CBR',
                keyint_sec: 2,
            },
        },
        {
            name: 'qsv + h264',
            input: { ...baseParams, encoderKind: 'qsv', videoCodec: 'h264' },
            expected: {
                bitrate: 18000,
                rate_control: 'CBR',
                keyint_sec: 2,
                profile: 'high',
            },
        },
        {
            name: 'qsv + av1',
            input: { ...baseParams, encoderKind: 'qsv', videoCodec: 'av1' },
            expected: {
                bitrate: 18000,
                rate_control: 'CBR',
                keyint_sec: 2,
            },
        },
        {
            name: 'other + h264',
            input: { ...baseParams, encoderKind: 'other', videoCodec: 'h264' },
            expected: {
                bitrate: 18000,
                rate_control: 'CBR',
                keyint_sec: 2,
            },
        },
        {
            name: 'other + av1',
            input: { ...baseParams, encoderKind: 'other', videoCodec: 'av1' },
            expected: {
                bitrate: 18000,
                rate_control: 'CBR',
                keyint_sec: 2,
            },
        },
    ];

    for (const testCase of cases) {
        const actual = buildLiveOutputPatch(testCase.input);
        assert.deepEqual(actual, testCase.expected, `buildLiveOutputPatch mismatch in case: ${testCase.name}`);
    }
});

test('getSimpleOutputEncoderId maps explicit IDs, handles fallbacks, and rejects non-h264', async () => {
    const { getSimpleOutputEncoderId } = await obsOutputModelModule;

    const cases = [
        // Explicit map
        { name: 'obs_nvenc_h264_tex', id: 'obs_nvenc_h264_tex', kind: 'nvenc', codec: 'h264', expected: 'nvenc' },
        { name: 'jim_nvenc', id: 'jim_nvenc', kind: 'nvenc', codec: 'h264', expected: 'nvenc' },
        { name: 'obs_x264', id: 'obs_x264', kind: 'x264', codec: 'h264', expected: 'x264' },
        { name: 'obs_amf_h264', id: 'obs_amf_h264', kind: 'amf', codec: 'h264', expected: 'amd' },
        { name: 'h264_texture_amf', id: 'h264_texture_amf', kind: 'amf', codec: 'h264', expected: 'amd' },
        { name: 'obs_qsv', id: 'obs_qsv', kind: 'qsv', codec: 'h264', expected: 'qsv' },
        { name: 'obs_qsv11', id: 'obs_qsv11', kind: 'qsv', codec: 'h264', expected: 'qsv' },
        // Fallback by encoderKind
        { name: 'unmapped nvenc', id: 'custom_nvenc', kind: 'nvenc', codec: 'h264', expected: 'nvenc' },
        { name: 'unmapped x264', id: 'custom_x264', kind: 'x264', codec: 'h264', expected: 'x264' },
        { name: 'unmapped amf', id: 'custom_amf', kind: 'amf', codec: 'h264', expected: 'amd' },
        { name: 'unmapped qsv', id: 'custom_qsv', kind: 'qsv', codec: 'h264', expected: 'qsv' },
        { name: 'unmapped unknown', id: 'custom_unknown', kind: 'other', codec: 'h264', expected: null },
        // Non-H.264 codecs
        { name: 'av1 codec', id: 'obs_nvenc_h264_tex', kind: 'nvenc', codec: 'av1', expected: null },
        { name: 'hevc codec', id: 'obs_nvenc_h264_tex', kind: 'nvenc', codec: 'hevc', expected: null },
        { name: 'null codec', id: 'obs_nvenc_h264_tex', kind: 'nvenc', codec: null, expected: null },
    ];

    for (const testCase of cases) {
        const actual = getSimpleOutputEncoderId(testCase.id, testCase.kind, testCase.codec);
        assert.equal(actual, testCase.expected, `getSimpleOutputEncoderId mismatch in case: ${testCase.name}`);
    }
});

test('normalizeObsEncoderRequest validates codec support case-insensitively and returns structured results', async () => {
    const { normalizeObsEncoderRequest } = await obsOutputModelModule;

    const unsupported = normalizeObsEncoderRequest({
        videoCodec: 'vp9',
        obsEncoderIds: ['obs_x264'],
    });
    assert.deepEqual(unsupported, {
        error: 'Unsupported OBS output codec: vp9.',
    });

    const caseInsensitiveH264 = normalizeObsEncoderRequest({
        videoCodec: '  H264  ',
        obsEncoderIds: ['obs_x264'],
    });
    assert.deepEqual(caseInsensitiveH264, {
        videoCodec: 'h264',
        encoderCandidates: ['obs_x264'],
    });

    const caseInsensitiveAV1 = normalizeObsEncoderRequest({
        videoCodec: ' Av1 ',
        obsEncoderIds: ['obs_nvenc_av1_tex'],
    });
    assert.deepEqual(caseInsensitiveAV1, {
        videoCodec: 'av1',
        encoderCandidates: ['obs_nvenc_av1_tex'],
    });
});

test('encoder labels and kinds cover explicit and normalized vendor forms', async () => {
    const { formatEncoderLabel, getEncoderKind } = await obsOutputModelModule;

    const labelCases = [
        ['obs_nvenc_h264_tex', 'H.264 NVENC'],
        ['jim_av1_nvenc', 'AV1 NVENC (legacy)'],
        ['obs_amf_av1', 'AV1 AMF'],
        ['obs_qsv11_av1', 'AV1 QSV'],
        ['custom_encoder_tex', 'CUSTOM ENCODER'],
        [null, ''],
    ];
    for (const [encoderId, expected] of labelCases) {
        assert.equal(formatEncoderLabel(encoderId), expected);
    }

    const kindCases = [
        ['OBS_X264', 'x264'],
        ['obs_nvenc_h264_tex', 'nvenc'],
        ['jim_av1_nvenc', 'nvenc'],
        ['obs_amf_h264', 'amf'],
        ['amd_amf_av1', 'amf'],
        ['obs_qsv11', 'qsv'],
        ['custom_encoder', 'other'],
        [undefined, 'other'],
    ];
    for (const [encoderId, expected] of kindCases) {
        assert.equal(getEncoderKind(encoderId), expected);
    }
});

test('buildStreamEncoderSettings turns off everything that delays or breaks a WebRTC stream', async () => {
    const { buildStreamEncoderSettings } = await obsOutputModelModule;

    const baseParams = {
        bitrateKbps: 18000,
        keyframeIntervalSec: 1,
        preset: 'veryfast',
        nvencPreset: 'p5',
        nvencMultipass: 'qres',
    };
    const common = { rate_control: 'CBR', bitrate: 18000, keyint_sec: 1, bf: 0, repeat_headers: true };
    const nvenc = {
        ...common,
        max_bitrate: 18000,
        preset: 'p5',
        preset2: 'p5',
        tune: 'll',
        multipass: 'qres',
        lookahead: false,
        disable_scenecut: true,
    };

    const cases = [
        { name: 'nvenc + h264', encoderKind: 'nvenc', videoCodec: 'h264', expected: { ...nvenc, profile: 'high' } },
        { name: 'nvenc + av1', encoderKind: 'nvenc', videoCodec: 'av1', expected: nvenc },
        {
            name: 'x264 + h264',
            encoderKind: 'x264',
            videoCodec: 'h264',
            expected: { ...common, preset: 'veryfast', profile: 'high', tune: 'zerolatency', x264opts: 'bframes=0' },
        },
        { name: 'amf + h264', encoderKind: 'amf', videoCodec: 'h264', expected: { ...common, bframes: 0, profile: 'high' } },
        { name: 'amf + av1', encoderKind: 'amf', videoCodec: 'av1', expected: { ...common, bframes: 0 } },
        {
            name: 'qsv + h264',
            encoderKind: 'qsv',
            videoCodec: 'h264',
            expected: { ...common, bframes: 0, latency: 'ultra-low', profile: 'high' },
        },
        { name: 'qsv + av1', encoderKind: 'qsv', videoCodec: 'av1', expected: { ...common, bframes: 0, latency: 'ultra-low' } },
        { name: 'other + h264', encoderKind: 'other', videoCodec: 'h264', expected: { ...common, bframes: 0, profile: 'high' } },
    ];

    for (const testCase of cases) {
        const actual = buildStreamEncoderSettings({ ...baseParams, encoderKind: testCase.encoderKind, videoCodec: testCase.videoCodec });
        assert.deepEqual(actual, testCase.expected, `buildStreamEncoderSettings mismatch in case: ${testCase.name}`);
    }
});

test('every setting the host builds for OBS is one the server agrees to write', async () => {
    const { buildStreamEncoderSettings } = await obsOutputModelModule;
    const { sanitizeEncoderSettings } = require('../lib/obsProfile');

    for (const encoderKind of ['nvenc', 'x264', 'amf', 'qsv', 'other']) {
        for (const videoCodec of ['h264', 'av1']) {
            for (const nvencMultipass of ['disabled', 'qres', 'fullres']) {
                const settings = buildStreamEncoderSettings({
                    encoderKind,
                    videoCodec,
                    bitrateKbps: 21000,
                    keyframeIntervalSec: 1,
                    preset: 'veryfast',
                    nvencPreset: 'p6',
                    nvencMultipass,
                });
                assert.deepEqual(sanitizeEncoderSettings(settings), settings, `${encoderKind} + ${videoCodec} + ${nvencMultipass}`);
            }
        }
    }
});

test('chooseEncoderCandidates uses the hardware encoder OBS has, whatever the page guessed', async () => {
    const { chooseEncoderCandidates } = await obsOutputModelModule;
    const nvidiaObs = ['ffmpeg_svt_av1', 'obs_nvenc_h264_tex', 'obs_nvenc_hevc_tex', 'obs_nvenc_av1_tex', 'obs_x264'];

    const cases = [
        {
            name: 'a browser that hides the GPU still gets NVENC',
            input: { videoCodec: 'h264', candidates: ['obs_x264'], available: nvidiaObs },
            expected: ['obs_nvenc_h264_tex', 'obs_x264'],
        },
        {
            name: 'a right guess keeps its order, minus what OBS lacks',
            input: { videoCodec: 'h264', candidates: ['obs_nvenc_h264_tex', 'jim_nvenc', 'obs_x264'], available: nvidiaObs },
            expected: ['obs_nvenc_h264_tex', 'obs_x264'],
        },
        {
            name: 'a wrong guess is replaced by what OBS has',
            input: { videoCodec: 'h264', candidates: ['obs_qsv11', 'obs_x264'], available: ['h264_texture_amf', 'obs_x264'] },
            expected: ['h264_texture_amf', 'obs_x264'],
        },
        {
            name: 'the guessed vendor comes first when OBS has several',
            input: { videoCodec: 'h264', candidates: ['obs_qsv11', 'obs_x264'], available: ['obs_nvenc_h264_tex', 'obs_qsv11', 'obs_x264'] },
            expected: ['obs_qsv11', 'obs_nvenc_h264_tex', 'obs_x264'],
        },
        {
            name: 'x264 is what is left without a hardware encoder',
            input: { videoCodec: 'h264', candidates: ['obs_nvenc_h264_tex', 'jim_nvenc', 'obs_x264'], available: ['obs_x264'] },
            expected: ['obs_x264'],
        },
        {
            name: 'AV1 keeps only the encoders OBS has',
            input: { videoCodec: 'av1', candidates: ['av1_texture_amf', 'obs_nvenc_av1_tex', 'jim_av1_nvenc'], available: nvidiaObs },
            expected: ['obs_nvenc_av1_tex'],
        },
        {
            name: 'AV1 has no candidate on a machine without an AV1 encoder',
            input: { videoCodec: 'av1', candidates: ['obs_nvenc_av1_tex'], available: ['obs_nvenc_h264_tex', 'obs_x264'] },
            expected: [],
        },
        {
            name: 'an unknown list leaves the guess alone',
            input: { videoCodec: 'h264', candidates: ['obs_x264'], available: null },
            expected: ['obs_x264'],
        },
        {
            name: 'an empty list is treated as unknown',
            input: { videoCodec: 'h264', candidates: ['obs_nvenc_h264_tex', 'obs_x264'], available: [] },
            expected: ['obs_nvenc_h264_tex', 'obs_x264'],
        },
    ];

    for (const testCase of cases) {
        assert.deepEqual(chooseEncoderCandidates(testCase.input), testCase.expected, `chooseEncoderCandidates mismatch in case: ${testCase.name}`);
    }
});
