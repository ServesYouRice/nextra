// src/lib/relayLiveSync.mjs - Keeps a relay viewer a fixed distance behind live.
//
// The relay arrives in fragments a few frames long. The player holds a small
// cushion of them ahead of the playhead: enough to ride out the network's jitter,
// no more, because every second of cushion is a second of delay. The cushion is
// sized by experience: it starts small, grows each time playback runs dry, and
// shrinks again slowly while the connection behaves.

export const TARGET_START_SECONDS = 0.5;
export const TARGET_MIN_SECONDS = 0.35;
export const TARGET_MAX_SECONDS = 3;
const TARGET_STALL_STEP_SECONDS = 0.35;
const TARGET_RELAX_STEP_SECONDS = 0.1;
export const TARGET_RELAX_AFTER_MS = 10_000;
// A bitrate switch restarts the server's encoder, and for a quarter of a second
// nothing new arrives. The cushion is raised by this much ahead of one.
const TARGET_SWITCH_RESERVE_SECONDS = 0.3;
// Within this much of the target the player leaves well alone.
const DEADBAND_SECONDS = 0.12;
// Further ahead than this, catching up by playing faster would take too long.
const SEEK_AHEAD_SECONDS = 1.5;
const MAX_CATCH_UP_RATE = 1.2;
const MIN_SLOW_DOWN_RATE = 0.92;

/**
 * What to do given `ahead` seconds of media buffered past the playhead.
 * Returns { rate, seekBack }: the playback rate to use, and, when the player is
 * too far behind live to catch up smoothly, how far before the buffered end to
 * jump to.
 */
export function decideLiveSync({ ahead, target }) {
    if (!Number.isFinite(ahead) || ahead < 0) return { rate: 1, seekBack: null };
    if (ahead > target + SEEK_AHEAD_SECONDS) return { rate: 1, seekBack: target };
    const excess = ahead - target;
    if (excess > DEADBAND_SECONDS) {
        // Close the gap in about three seconds, gently enough to go unnoticed.
        return { rate: Math.min(MAX_CATCH_UP_RATE, 1 + (excess / 3) + 0.02), seekBack: null };
    }
    if (excess < -DEADBAND_SECONDS) {
        // Running low: ease off a little rather than run dry and stall.
        return { rate: Math.max(MIN_SLOW_DOWN_RATE, 1 + (excess / 2)), seekBack: null };
    }
    return { rate: 1, seekBack: null };
}

/** The cushion after playback ran dry. */
export function targetAfterStall(target) {
    return Math.min(TARGET_MAX_SECONDS, target + TARGET_STALL_STEP_SECONDS);
}

/** The cushion while a bitrate switch may be coming. */
export function targetBeforeSwitch(target) {
    return Math.min(TARGET_MAX_SECONDS, target + TARGET_SWITCH_RESERVE_SECONDS);
}

/** The cushion after a stretch without stalls. */
export function targetAfterQuietPeriod(target) {
    return Math.max(TARGET_MIN_SECONDS, target - TARGET_RELAX_STEP_SECONDS);
}
