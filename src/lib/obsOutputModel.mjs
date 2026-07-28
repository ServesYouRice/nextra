export function formatEncoderLabel(encoderId) {
    const labels = {
        obs_nvenc_h264_tex: 'H.264 NVENC',
        obs_nvenc_av1_tex: 'AV1 NVENC',
        jim_nvenc: 'H.264 NVENC (legacy)',
        jim_av1_nvenc: 'AV1 NVENC (legacy)',
        obs_amf_h264: 'H.264 AMF',
        h264_texture_amf: 'H.264 AMF',
        obs_amf_av1: 'AV1 AMF',
        av1_texture_amf: 'AV1 AMF',
        amd_amf_av1: 'AV1 AMF',
        obs_qsv11_av1: 'AV1 QSV',
        obs_qsv_av1: 'AV1 QSV',
        ffmpeg_nvenc_av1: 'AV1 NVENC',
        obs_x264: 'x264',
    };

    if (labels[encoderId]) {
        return labels[encoderId];
    }

    return String(encoderId || '')
        .replace(/^(jim_|obs_|ffmpeg_|h264_texture_)/, '')
        .replace(/_tex$/, '')
        .replace(/_/g, ' ')
        .toUpperCase();
}

export function getEncoderKind(encoderId) {
    const normalized = String(encoderId || '').toLowerCase();

    if (normalized.includes('x264')) return 'x264';
    if (normalized.includes('nvenc') || normalized.startsWith('jim_')) return 'nvenc';
    if (normalized.includes('amf') || normalized.startsWith('amd_')) return 'amf';
    if (normalized.includes('qsv')) return 'qsv';
    return 'other';
}

const AV1_ENCODERS_BY_VENDOR = Object.freeze({
    nvenc: ['obs_nvenc_av1_tex', 'jim_av1_nvenc', 'ffmpeg_nvenc_av1'],
    amf: ['av1_texture_amf', 'obs_amf_av1', 'amd_amf_av1'],
    qsv: ['obs_qsv11_av1', 'obs_qsv_av1'],
});

export function getAv1EncoderCandidates(renderer = '') {
    const normalized = String(renderer || '').toLowerCase();
    const preferredVendor = /nvidia|geforce|rtx/.test(normalized)
        ? 'nvenc'
        : /amd|radeon/.test(normalized)
            ? 'amf'
            : /intel/.test(normalized)
                ? 'qsv'
                : null;
    const vendorOrder = preferredVendor
        ? [preferredVendor, ...Object.keys(AV1_ENCODERS_BY_VENDOR).filter((vendor) => vendor !== preferredVendor)]
        : Object.keys(AV1_ENCODERS_BY_VENDOR);
    return vendorOrder.flatMap((vendor) => AV1_ENCODERS_BY_VENDOR[vendor]);
}

export function buildLiveOutputPatch({
    encoderKind,
    videoCodec,
    bitrateKbps,
    keyframeIntervalSec,
    preset,
    nvencPreset,
    nvencMultipass,
}) {
    const common = {
        bitrate: bitrateKbps,
        rate_control: 'CBR',
        keyint_sec: keyframeIntervalSec,
    };

    if (encoderKind === 'nvenc') {
        const patch = {
            ...common,
            lookahead: false,
            multipass: nvencMultipass,
            preset2: nvencPreset,
        };
        if (videoCodec === 'h264') {
            patch.tune = 'll';
            patch.profile = 'high';
        }
        return patch;
    }

    if (encoderKind === 'x264' && videoCodec === 'h264') {
        return {
            ...common,
            preset,
            profile: 'high',
            tune: 'zerolatency',
            x264opts: 'bframes=0',
        };
    }

    if (encoderKind === 'amf' || encoderKind === 'qsv') {
        if (videoCodec === 'h264') {
            return {
                ...common,
                profile: 'high',
            };
        }
        return common;
    }

    return common;
}

export function getSimpleOutputEncoderId(selectedEncoderId, encoderKind, videoCodec) {
    if (videoCodec !== 'h264') return null;

    const explicitMap = {
        obs_nvenc_h264_tex: 'nvenc',
        jim_nvenc: 'nvenc',
        obs_x264: 'x264',
        obs_amf_h264: 'amd',
        h264_texture_amf: 'amd',
        obs_qsv: 'qsv',
        obs_qsv11: 'qsv',
    };

    if (explicitMap[selectedEncoderId]) {
        return explicitMap[selectedEncoderId];
    }

    if (encoderKind === 'nvenc') return 'nvenc';
    if (encoderKind === 'x264') return 'x264';
    if (encoderKind === 'amf') return 'amd';
    if (encoderKind === 'qsv') return 'qsv';
    return null;
}

export function normalizeObsEncoderRequest({ videoCodec = 'h264', obsEncoderIds = [], obsEncoderId } = {}) {
    const normalizedVideoCodec = String(videoCodec || 'h264').trim().toLowerCase();
    if (normalizedVideoCodec !== 'h264' && normalizedVideoCodec !== 'av1') {
        return {
            error: `Unsupported OBS output codec: ${normalizedVideoCodec}.`,
        };
    }

    const encoderCandidates = [...new Set([
        ...obsEncoderIds,
        ...(obsEncoderId ? [obsEncoderId] : []),
    ].filter(Boolean))];

    if (encoderCandidates.length === 0) {
        return {
            error: `No ${normalizedVideoCodec.toUpperCase()} OBS encoders were configured for this host.`,
        };
    }

    return {
        videoCodec: normalizedVideoCodec,
        encoderCandidates,
    };
}
