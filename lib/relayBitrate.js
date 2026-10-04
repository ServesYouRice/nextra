// lib/relayBitrate.js - Bitrate policy for the OBS FFmpeg relay.
//
// FFmpeg encodes at a fixed bitrate, so a relay viewer whose connection (or the
// host uplink / public tunnel) carries less than that bitrate falls further
// behind every second. The relay therefore starts at what the public link was
// measured to carry, skips viewers that still fall behind (see relayMp4.js) and,
// when every viewer is behind, lowers the encode bitrate to what their
// connections actually carried. A stream that is only just too much for the link
// (queues that never empty, though nobody has to skip yet) is eased down a
// little instead.
//
// A link's capacity changes (an upload line that loses packets in the evening
// is clean at night), so a lowered relay also has to find its way back up. A
// step up that the link cannot carry is expensive: by the time it shows, the
// viewers are behind, and going back takes an encoder restart. So before a step
// the link is tested with filler: for a few seconds every fragment is followed
// by extra bytes the player throws away. If the viewers keep up with that, there
// is room for the step; if they start to lag, the filler just stops. A step that
// was taken is still on trial for a while and is taken back if viewers lag under
// it. Every test or step that fails doubles the wait before the next.
'use strict';

const FLOOR_KBPS = 2500;
const LOWER_FACTOR = 0.7;
// Share of a measured rate the stream may use. A live stream is bursts on a
// deadline (a keyframe is several times an average frame), so a stream that
// fills the connection is always a little behind; the spare third is what lets a
// viewer catch up after each burst and stay close to live.
const HEADROOM = 0.7;
const CAPACITY_SHARE = 0.7;
// How much recent history feeds the goodput estimate, and the least span
// between whole-message steps worth trusting.
const SAMPLE_WINDOW_MS = 10_000;
const MIN_STEP_SPAN_MS = 2_000;
// A viewer that missed this many fragments within the window is struggling. A
// slow link alternates between skipping and catching up, so "skipping right
// now" is too brief a state to act on; a single hiccup is not a pattern either.
const STRUGGLE_WINDOW_MS = 10_000;
const STRUGGLE_SKIPS = 2;
// A hint about a slow path stays useful for later rooms on the same host.
const HINT_TTL_MS = 30 * 60_000;
// Raising. A viewer "keeps up" while its send queue keeps emptying: a keyframe
// or a retransmission holds it up for a moment, but a link with room to spare is
// back under CALM_LAG_SEC within CALM_BREAK_MS. A queue that stays above it for
// that long is a link with nothing to spare.
const RAISE_FACTOR = 1.2;
const CALM_LAG_SEC = 0.1;
const CALM_BREAK_MS = 1_000;
// The filler that tests the link before a step: this much on top of every
// fragment (well over the step, so the step leaves something spare), this long.
// A test is given up sooner than a step would be: every moment of filler the
// link cannot carry is delay for the viewers.
const PROBE_SHARE = 0.35;
const PROBE_MS = 4_000;
const PROBE_BREAK_MS = 500;
// A queue that will not empty for this long, although nobody is skipping yet,
// is a stream using all the link has: it is eased down a little, which is what
// lets the viewers catch up.
const EASE_FACTOR = 0.9;
const EASE_AFTER_MS = 5_000;
// Every viewer this far behind, on a link measured to carry less than this share
// of the stream, is a link that is plainly too slow: the cut does not wait for
// them to start skipping.
const OVERLOAD_LAG_SEC = 1;
const OVERLOAD_GOODPUT_SHARE = 0.95;
// How long every viewer has to keep up before the link is tested, how long a
// step is then on trial, and the longest wait after repeated failures.
const RAISE_QUIET_MS = 30_000;
const RAISE_TRIAL_MS = 20_000;
const RAISE_QUIET_MAX_MS = 16 * 60_000;

function createBitrateState({ targetKbps, startKbps = targetKbps, audioKbps = 0 }) {
    const target = Math.max(FLOOR_KBPS, Math.round(targetKbps));
    return {
        targetKbps: target,
        currentKbps: Math.min(target, Math.max(FLOOR_KBPS, Math.round(startKbps))),
        audioKbps,
        lastChangeAt: 0,
        // Since when every viewer has kept up (null: they are not), and since
        // when the current lag has lasted (null: nobody is lagging).
        calmSince: null,
        laggingSince: null,
        // Since when even the viewer that is least behind has had a queue.
        pressedSince: null,
        raiseQuietMs: RAISE_QUIET_MS,
        // { until } while the link is being tested with filler, and when the
        // last test failed.
        probe: null,
        lastProbeAt: 0,
        // { fromKbps, until } while a step up is on trial.
        trial: null,
    };
}

/**
 * Average rate a viewer's connection actually drained over the recent past.
 * `samples` are { at, drained, backlog } taken before each fragment is queued,
 * where `drained` is the cumulative bytes handed over minus the bytes still
 * queued. A message leaves the queue as a whole, so `drained` moves in steps;
 * the rate is measured from one step to a later one, not from sample to sample,
 * which would swing by a whole message either way. Only runs with a backlog
 * throughout count: an idle link says nothing about its capacity. Returns kbps,
 * or null without enough evidence.
 */
function estimateDrainKbps(samples, now) {
    let spanMs = 0;
    let bytes = 0;
    let runFirstStep = null;
    let runLastStep = null;
    const endRun = () => {
        if (runFirstStep && runLastStep && runLastStep.at > runFirstStep.at) {
            spanMs += runLastStep.at - runFirstStep.at;
            bytes += runLastStep.drained - runFirstStep.drained;
        }
        runFirstStep = null;
        runLastStep = null;
    };
    for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        if (now - sample.at > SAMPLE_WINDOW_MS) continue;
        if (sample.backlog <= 0) {
            endRun();
            continue;
        }
        const previous = samples[i - 1];
        if (!previous || sample.drained <= previous.drained) continue;
        if (!runFirstStep) runFirstStep = sample;
        runLastStep = sample;
    }
    endRun();
    if (spanMs < MIN_STEP_SPAN_MS) return null;
    return (bytes * 8) / spanMs;
}

function pruneSamples(samples, now) {
    while (samples.length > 0 && now - samples[0].at > SAMPLE_WINDOW_MS) samples.shift();
}

/**
 * Records whether this fragment was skipped for a viewer (`skips` holds the
 * recent skip times) and reports whether the viewer keeps missing fragments.
 */
function trackSkips(skips, { skipped, now }) {
    if (skipped) skips.push(now);
    while (skips.length > 0 && now - skips[0] > STRUGGLE_WINDOW_MS) skips.shift();
    return skips.length >= STRUGGLE_SKIPS;
}

function failRaise(state, now) {
    const { fromKbps } = state.trial;
    state.trial = null;
    state.raiseQuietMs = Math.min(RAISE_QUIET_MAX_MS, state.raiseQuietMs * 2);
    state.currentKbps = fromKbps;
    state.lastChangeAt = now;
    return fromKbps;
}

/**
 * Every viewer is behind. Returns the lowered video bitrate (kbps) and records
 * it, or null when already at the floor. A step up that was still on trial is
 * simply taken back.
 */
function lowerBitrate(state, { now, goodputKbps = null }) {
    state.probe = null;
    if (state.trial) return failRaise(state, now);
    if (state.currentKbps <= FLOOR_KBPS) return null;
    const stepped = Math.round(state.currentKbps * LOWER_FACTOR);
    const measured = Number.isFinite(goodputKbps) && goodputKbps > 0
        ? Math.round((goodputKbps * HEADROOM) - state.audioKbps)
        : Infinity;
    const next = Math.max(FLOOR_KBPS, Math.min(stepped, measured));
    if (next >= state.currentKbps) return null;
    state.currentKbps = next;
    state.lastChangeAt = now;
    // A link that just proved too slow is not about to carry more.
    state.raiseQuietMs = Math.min(RAISE_QUIET_MAX_MS, state.raiseQuietMs * 2);
    return next;
}

/**
 * Records how far behind the viewer that is furthest behind is (`lagSec`), which
 * is what decides whether the link may be tested and whether a test or a step
 * has failed.
 */
function trackLag(state, { lagSec, now }) {
    if (lagSec <= CALM_LAG_SEC) {
        state.laggingSince = null;
        if (state.calmSince === null) state.calmSince = now;
        return;
    }
    if (state.laggingSince === null) state.laggingSince = now;
    if (now - state.laggingSince >= CALM_BREAK_MS) state.calmSince = null;
}

/**
 * Whether the link is plainly too slow for the stream: even the viewer that is
 * least behind is a second behind, and what the viewers received shows the link
 * carrying less than the stream needs. (A stall that is over shows the opposite:
 * everything arrives at once.) The last change is given time to show first.
 */
function isOverloaded(state, { leastLagSec, goodputKbps, now }) {
    return leastLagSec >= OVERLOAD_LAG_SEC
        && Number.isFinite(goodputKbps) && goodputKbps > 0
        && goodputKbps < (state.currentKbps + state.audioKbps) * OVERLOAD_GOODPUT_SHARE
        && now - state.lastChangeAt >= EASE_AFTER_MS;
}

/**
 * Records how far behind the viewer that is *least* behind is. A queue there
 * is not one viewer's slow connection: it is the path they all share.
 */
function trackPressure(state, { lagSec, now }) {
    if (lagSec <= CALM_LAG_SEC) state.pressedSince = null;
    else if (state.pressedSince === null) state.pressedSince = now;
}

/**
 * Every viewer has had a queue for a while: the stream is at the limit of the
 * link. Returns a slightly lower bitrate (kbps) and records it, or null.
 */
function easeBitrate(state, { now }) {
    if (state.pressedSince === null || now - state.pressedSince < EASE_AFTER_MS) return null;
    if (now - state.lastChangeAt < EASE_AFTER_MS || state.currentKbps <= FLOOR_KBPS) return null;
    state.probe = null;
    if (state.trial) return failRaise(state, now);
    state.currentKbps = Math.max(FLOOR_KBPS, Math.round(state.currentKbps * EASE_FACTOR));
    state.lastChangeAt = now;
    state.raiseQuietMs = Math.min(RAISE_QUIET_MAX_MS, state.raiseQuietMs * 2);
    return state.currentKbps;
}

/**
 * Follows a step up that is on trial. Returns the bitrate to go back to when
 * viewers started to lag under it, or null: either nothing is on trial, or the
 * step is holding (and counts as kept once its trial is over).
 */
function settleRaise(state, { now }) {
    if (!state.trial) return null;
    if (state.calmSince === null) return failRaise(state, now);
    if (now >= state.trial.until) {
        state.trial = null;
        state.raiseQuietMs = RAISE_QUIET_MS;
    }
    return null;
}

/**
 * Works towards a step up, one call per fragment. Once every viewer has kept up
 * for long enough the link is tested with filler (see paddingShare); when the
 * viewers kept up through the test, the next bitrate up (kbps) is returned and
 * put on trial. Otherwise null.
 */
function raiseBitrate(state, { now }) {
    if (state.trial || state.currentKbps >= state.targetKbps) {
        state.probe = null;
        return null;
    }
    if (state.probe) {
        if (state.laggingSince !== null && now - state.laggingSince >= PROBE_BREAK_MS) {
            // The filler was too much for the link, so more video would be too.
            state.probe = null;
            state.lastProbeAt = now;
            state.raiseQuietMs = Math.min(RAISE_QUIET_MAX_MS, state.raiseQuietMs * 2);
            // The queue it left is the test's doing: it gets its own time to empty.
            if (state.pressedSince !== null) state.pressedSince = now;
            return null;
        }
        if (now < state.probe.until) return null;
        state.probe = null;
        const next = Math.min(state.targetKbps, Math.round(state.currentKbps * RAISE_FACTOR));
        state.trial = { fromKbps: state.currentKbps, until: now + RAISE_TRIAL_MS };
        state.currentKbps = next;
        state.lastChangeAt = now;
        return next;
    }
    if (state.calmSince === null) return null;
    if (now - Math.max(state.calmSince, state.lastChangeAt, state.lastProbeAt) < state.raiseQuietMs) return null;
    state.probe = { until: now + PROBE_MS };
    return null;
}

/** Filler to send after each fragment, as a share of its size, while the link is tested. */
function paddingShare(state) {
    return state.probe ? PROBE_SHARE : 0;
}

/** Nobody is watching: forget what the departed viewers' connections were doing. */
function resetRaise(state) {
    state.calmSince = null;
    state.laggingSince = null;
    state.pressedSince = null;
    state.raiseQuietMs = RAISE_QUIET_MS;
    state.probe = null;
    state.lastProbeAt = 0;
    state.trial = null;
}

/**
 * Bitrate for a relay to start at: the target, held down by what the public
 * link was measured to carry and by a recent cut on the same host.
 */
function startingKbps(targetKbps, { hint = null, capacityKbps = null, audioKbps = 0, now = 0 } = {}) {
    let kbps = targetKbps;
    if (Number.isFinite(capacityKbps) && capacityKbps > 0) {
        kbps = Math.min(kbps, Math.round((capacityKbps * CAPACITY_SHARE) - audioKbps));
    }
    if (hint && now - hint.at <= HINT_TTL_MS) kbps = Math.min(kbps, hint.kbps);
    return Math.max(FLOOR_KBPS, kbps);
}

module.exports = {
    FLOOR_KBPS,
    OVERLOAD_LAG_SEC,
    createBitrateState,
    easeBitrate,
    estimateDrainKbps,
    isOverloaded,
    lowerBitrate,
    paddingShare,
    pruneSamples,
    raiseBitrate,
    resetRaise,
    settleRaise,
    startingKbps,
    trackLag,
    trackPressure,
    trackSkips,
};
