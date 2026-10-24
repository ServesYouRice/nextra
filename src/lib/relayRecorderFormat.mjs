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

// A relay recorder that errors or stops by itself is restarted, but one that
// fails every time must not restart in a tight loop. Three restarts per minute;
// after that the relay stays down until something else (a viewer joining or
// leaving, a new share) starts a recorder.
export const RELAY_RECORDER_RESTART_BUDGET = Object.freeze({ max: 3, windowMs: 60_000 });

// `history` holds the times of the restarts already made. Returns whether one
// more is allowed at `now` and the history to keep: restarts older than the
// window drop out, a denied request is not recorded, and the input is not changed.
export function allowRelayRecorderRestart(
    history,
    now,
    {
        max = RELAY_RECORDER_RESTART_BUDGET.max,
        windowMs = RELAY_RECORDER_RESTART_BUDGET.windowMs,
    } = {},
) {
    const recent = history.filter((restartedAt) => now - restartedAt < windowMs);
    if (recent.length >= max) return { allowed: false, history: recent };
    return { allowed: true, history: [...recent, now] };
}

// The budget as HostView holds it. request() answers 'restart' when the
// recorder may be restarted, 'exhausted' for the first refusal after that (the
// caller logs its one warning), and 'denied' for later refusals until a restart
// is allowed again. reset() starts over when sharing ends.
export function createRelayRecorderRestartBudget({ now = Date.now, max, windowMs } = {}) {
    let history = [];
    let exhaustedReported = false;
    return {
        request() {
            const decision = allowRelayRecorderRestart(history, now(), { max, windowMs });
            history = decision.history;
            if (decision.allowed) {
                exhaustedReported = false;
                return 'restart';
            }
            if (exhaustedReported) return 'denied';
            exhaustedReported = true;
            return 'exhausted';
        },
        reset() {
            history = [];
            exhaustedReported = false;
        },
    };
}
