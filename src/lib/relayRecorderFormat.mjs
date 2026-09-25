// Host-side choice of the browser-room relay recording format.
//
// iPhone relay viewers can only play H.264 MP4 (ManagedMediaSource has no WebM
// VP8), so hosts that can record it prefer High-profile H.264 with AAC audio.
// Chrome's MP4 recorder only closes a fragment at a keyframe, so a 1s keyframe
// interval keeps relay chunks short; without it the first fragment can take
// several seconds. Chrome picks the H.264 level itself and reports the exact
// codec string on MediaRecorder#mimeType once recording starts.
export const RELAY_MP4_MIME_TYPE = 'video/mp4;codecs=avc1.640028,mp4a.40.2';

const RELAY_WEBM_MIME_TYPES = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8'];

export function selectRelayRecorderFormat(isTypeSupported, { allowMp4 = true } = {}) {
    if (allowMp4 && isTypeSupported(RELAY_MP4_MIME_TYPE)) {
        return { mimeType: RELAY_MP4_MIME_TYPE, options: { videoKeyFrameIntervalDuration: 1000 } };
    }
    const mimeType = RELAY_WEBM_MIME_TYPES.find((type) => isTypeSupported(type)) || 'video/webm';
    return { mimeType, options: {} };
}

// Adaptive relay bitrate. The server signals congestion only when every relay
// viewer is behind (the host uplink cannot carry the recording), so the host
// drops fast and recovers slowly, like OBS dynamic bitrate and WebRTC GCC.
// MediaRecorder cannot change bitrate mid-recording, so each step restarts it.
export const RELAY_BITRATE_FLOOR = 2_500_000;
export const RELAY_BITRATE_STEP_UP_AFTER_MS = 30_000;

export function lowerRelayBitrate(currentBitsPerSecond) {
    return Math.max(RELAY_BITRATE_FLOOR, Math.round(currentBitsPerSecond * 0.7));
}

// Returns the next limit, or null once the profile target is reached again.
export function raiseRelayBitrate(limitBitsPerSecond, targetBitsPerSecond) {
    const next = Math.round(limitBitsPerSecond * 1.25);
    return next >= targetBitsPerSecond ? null : next;
}
