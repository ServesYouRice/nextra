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

const H264_HARDWARE_ENCODERS = Object.freeze([
    'obs_nvenc_h264_tex',
    'jim_nvenc',
    'h264_texture_amf',
    'obs_amf_h264',
    'obs_qsv11',
]);

/**
 * The encoders to try, best first. `candidates` come from the page's guess at
 * the GPU; `available` is OBS's own list of the encoders it has, when known.
 * With that list a hardware encoder is used wherever OBS has one, whatever the
 * page guessed, and an encoder OBS lacks is never chosen.
 */
export function chooseEncoderCandidates({ videoCodec, candidates, available }) {
    if (!Array.isArray(available) || available.length === 0) return candidates;
    const preferred = videoCodec === 'h264'
        ? [...candidates.filter((id) => id !== 'obs_x264'), ...H264_HARDWARE_ENCODERS, 'obs_x264']
        : candidates;
    return [...new Set(preferred)].filter((id) => available.includes(id));
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

/**
 * The contents of OBS's streamEncoder.json: the stream encoder's own settings in
 * Advanced output mode. OBS reads them from that file only, so this is what
 * decides the bitrate, the keyframe interval, and whether the encoder adds delay.
 */
export function buildStreamEncoderSettings({
    encoderKind,
    videoCodec,
    bitrateKbps,
    keyframeIntervalSec,
    preset,
    nvencPreset,
    nvencMultipass,
}) {
    const common = {
        rate_control: 'CBR',
        bitrate: bitrateKbps,
        keyint_sec: keyframeIntervalSec,
        // WebRTC carries no B-frames, and a viewer who joins needs the stream's
        // parameter sets with the next keyframe, not only at the very start.
        bf: 0,
        repeat_headers: true,
    };

    if (encoderKind === 'nvenc') {
        const settings = {
            ...common,
            max_bitrate: bitrateKbps,
            preset: nvencPreset,
            preset2: nvencPreset,
            tune: 'll',
            multipass: nvencMultipass,
            // Look-ahead holds frames back before they are encoded.
            lookahead: false,
            disable_scenecut: true,
        };
        if (videoCodec === 'h264') settings.profile = 'high';
        return settings;
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

    const settings = { ...common, bframes: 0 };
    if (encoderKind === 'qsv') settings.latency = 'ultra-low';
    if (videoCodec === 'h264') settings.profile = 'high';
    return settings;
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
