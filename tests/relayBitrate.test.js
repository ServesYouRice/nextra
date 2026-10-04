const test = require('node:test');
const assert = require('node:assert/strict');

const {
    FLOOR_KBPS,
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
} = require('../lib/relayBitrate');

// Viewers that keep up from `from` to `to` (ms), sampled every 100 ms.
function keepUp(state, from, to) {
    for (let now = from; now <= to; now += 100) trackLag(state, { lagSec: 0.05, now });
}

// A viewer whose link carries 800 kB/s: drained grows by that much per second
// while a backlog stays queued.
function busySamples(seconds, bytesPerSecond, { endAt = seconds * 1000 } = {}) {
    const samples = [];
    for (let s = 0; s <= seconds; s++) {
        samples.push({ at: endAt - (seconds - s) * 1000, drained: s * bytesPerSecond, backlog: 2_000_000 });
    }
    return samples;
}

test('the drain estimate is the rate a backlogged connection actually carried', () => {
    const kbps = estimateDrainKbps(busySamples(6, 800_000), 6000);
    assert.equal(Math.round(kbps), 6400);
});

test('the drain estimate measures between whole-message steps, not between samples', () => {
    // [offset ms, drained kB, backlog kB] as seen at the server for a link of
    // 6 Mbps carrying 1.85 MB messages: drained only moves when one finishes.
    const lab = [[-8817, 1859, 1739], [-7432, 3598, 1853], [-6144, 3598, 3698], [-5024, 5452, 1844],
        [-4028, 5452, 1844], [-3010, 7296, 0], [-2021, 7296, 1622], [-1030, 7296, 3250], [0, 8918, 1628]]
        .map(([at, drained, backlog]) => ({ at: 20_000 + at, drained: drained * 1000, backlog: backlog * 1000 }));
    const kbps = estimateDrainKbps(lab, 20_000);
    assert.ok(kbps > 6000 && kbps < 6300, `estimated ${kbps}`);
});

test('the drain estimate ignores idle spans and needs a few busy seconds', () => {
    assert.equal(estimateDrainKbps(busySamples(2, 800_000), 2000), null);

    // The queue emptied after the first second: the link was waiting for data,
    // so how much it moved says nothing about what it could carry.
    const samples = busySamples(6, 800_000);
    for (const index of [2, 3, 4, 5, 6]) samples[index].backlog = 0;
    assert.equal(estimateDrainKbps(samples, 6000), null);
    assert.equal(estimateDrainKbps([], 0), null);
});

test('the drain estimate only looks at recent samples', () => {
    const stale = busySamples(6, 100_000, { endAt: 6000 });
    assert.equal(estimateDrainKbps(stale, 60_000), null);

    const samples = busySamples(14, 800_000, { endAt: 14_000 });
    pruneSamples(samples, 14_000);
    assert.ok(samples.length <= 11);
    assert.equal(samples[0].at >= 4000, true);
});

test('lowering jumps to the measured rate with headroom, and at least one step down', () => {
    const state = createBitrateState({ targetKbps: 14000, audioKbps: 192 });
    // 6.4 Mbps measured: 70% of it, minus the audio that shares the stream.
    assert.equal(lowerBitrate(state, { now: 1000, goodputKbps: 6400 }), 4288);
    assert.equal(state.currentKbps, 4288);

    // A measurement above the step still moves down by the step.
    const nearly = createBitrateState({ targetKbps: 10000 });
    assert.equal(lowerBitrate(nearly, { now: 1000, goodputKbps: 12000 }), 7000);

    // Without a measurement it steps down by 30%.
    const blind = createBitrateState({ targetKbps: 10000 });
    assert.equal(lowerBitrate(blind, { now: 1000 }), 7000);
});

test('lowering never goes below the floor and reports nothing once there', () => {
    const state = createBitrateState({ targetKbps: 4000 });
    assert.equal(lowerBitrate(state, { now: 1000, goodputKbps: 500 }), FLOOR_KBPS);
    assert.equal(lowerBitrate(state, { now: 2000, goodputKbps: 500 }), null);
    assert.equal(state.currentKbps, FLOOR_KBPS);
});

test('a relay starts at what the public link was measured to carry', () => {
    // 10 Mbps measured: the stream may use 70% of it, audio included.
    assert.equal(startingKbps(14000, { capacityKbps: 10000, audioKbps: 192 }), 6808);
    // A link faster than the target changes nothing; neither does no measurement.
    assert.equal(startingKbps(14000, { capacityKbps: 60000, audioKbps: 192 }), 14000);
    assert.equal(startingKbps(14000, {}), 14000);
    assert.equal(startingKbps(14000), 14000);
    // A link too slow for the floor still gets the floor.
    assert.equal(startingKbps(14000, { capacityKbps: 2000 }), FLOOR_KBPS);
});

test('a hint from a recent cut lowers the next relay start only while it is fresh', () => {
    const hint = { kbps: 5000, at: 1_000 };
    assert.equal(startingKbps(14000, { hint, now: 60_000 }), 5000);
    assert.equal(startingKbps(14000, { hint, now: 31 * 60_000 }), 14000);
    assert.equal(startingKbps(3000, { hint, now: 2_000 }), 3000);
    assert.equal(startingKbps(14000, { hint: { kbps: 100, at: 0 }, now: 1 }), FLOOR_KBPS);
    // Whichever of the hint and the measured capacity is lower wins.
    assert.equal(startingKbps(14000, { hint, capacityKbps: 10000, now: 60_000 }), 5000);
    assert.equal(startingKbps(14000, { hint: { kbps: 9000, at: 1_000 }, capacityKbps: 10000, now: 60_000 }), 7000);
});

test('a viewer is struggling once it keeps missing fragments, and recovers when it stops', () => {
    const skips = [];
    assert.equal(trackSkips(skips, { skipped: false, now: 0 }), false);
    // One hiccup is not a pattern.
    assert.equal(trackSkips(skips, { skipped: true, now: 1000 }), false);
    assert.equal(trackSkips(skips, { skipped: true, now: 2000 }), true);
    assert.equal(trackSkips(skips, { skipped: false, now: 5000 }), true);
    // The misses age out of the window.
    assert.equal(trackSkips(skips, { skipped: false, now: 11_500 }), false);
    assert.equal(skips.length, 1);
});

test('once every viewer has kept up for a while, the link is tested with filler before a step up', () => {
    const state = createBitrateState({ targetKbps: 14000, startKbps: 7000 });
    keepUp(state, 0, 29_900);
    assert.equal(raiseBitrate(state, { now: 29_900 }), null);
    assert.equal(paddingShare(state), 0);

    // Thirty seconds of keeping up: the test begins. Nothing changes yet but
    // the filler.
    keepUp(state, 30_000, 30_000);
    assert.equal(raiseBitrate(state, { now: 30_000 }), null);
    assert.equal(paddingShare(state), 0.35);
    assert.equal(state.currentKbps, 7000);
    keepUp(state, 30_100, 33_900);
    assert.equal(raiseBitrate(state, { now: 33_900 }), null);

    // The viewers kept up with 35% more: there is room for 20% more video.
    keepUp(state, 34_000, 34_000);
    assert.equal(raiseBitrate(state, { now: 34_000 }), 8400);
    assert.equal(state.currentKbps, 8400);
    assert.equal(paddingShare(state), 0);
    // One step at a time: nothing more while this one is on trial.
    keepUp(state, 34_100, 68_000);
    assert.equal(raiseBitrate(state, { now: 40_000 }), null);
    assert.equal(paddingShare(state), 0);

    // It held for its trial, so the next test comes after the same wait.
    assert.equal(settleRaise(state, { now: 54_000 }), null);
    assert.equal(raiseBitrate(state, { now: 63_900 }), null);
    assert.equal(paddingShare(state), 0);
    assert.equal(raiseBitrate(state, { now: 64_000 }), null);
    assert.equal(paddingShare(state), 0.35);
    assert.equal(raiseBitrate(state, { now: 68_000 }), 10080);
});

test('the last step stops at the target, and a relay at its target is left alone', () => {
    const nearly = createBitrateState({ targetKbps: 14000, startKbps: 13000 });
    keepUp(nearly, 0, 34_000);
    assert.equal(raiseBitrate(nearly, { now: 30_000 }), null);
    assert.equal(raiseBitrate(nearly, { now: 34_000 }), 14000);
    keepUp(nearly, 34_100, 300_000);
    assert.equal(settleRaise(nearly, { now: 54_000 }), null);
    for (let now = 54_000; now <= 300_000; now += 1000) {
        assert.equal(raiseBitrate(nearly, { now }), null);
        assert.equal(paddingShare(nearly), 0);
    }
});

test('filler the link cannot carry just stops, and the next test waits twice as long', () => {
    const state = createBitrateState({ targetKbps: 14000, startKbps: 7000 });
    keepUp(state, 0, 30_000);
    raiseBitrate(state, { now: 30_000 });
    assert.equal(paddingShare(state), 0.35);

    // A moment of lag is a keyframe or a retransmission, not a verdict.
    trackLag(state, { lagSec: 0.25, now: 30_300 });
    trackLag(state, { lagSec: 0.25, now: 30_700 });
    assert.equal(raiseBitrate(state, { now: 30_700 }), null);
    assert.equal(paddingShare(state), 0.35);
    trackLag(state, { lagSec: 0.02, now: 30_800 });

    // A queue that stays for half a second is: every moment of filler the link
    // cannot carry is delay for the viewers.
    trackLag(state, { lagSec: 0.2, now: 31_000 });
    trackLag(state, { lagSec: 0.3, now: 31_500 });
    assert.equal(raiseBitrate(state, { now: 31_500 }), null);
    assert.equal(paddingShare(state), 0);
    // No bitrate change either way: nothing was restarted, nothing is on trial.
    assert.equal(state.currentKbps, 7000);
    assert.equal(settleRaise(state, { now: 31_600 }), null);

    // Keeping up again: 30 s is no longer enough, 60 s is.
    keepUp(state, 31_600, 91_500);
    assert.equal(raiseBitrate(state, { now: 61_600 }), null);
    assert.equal(paddingShare(state), 0);
    assert.equal(raiseBitrate(state, { now: 91_400 }), null);
    assert.equal(paddingShare(state), 0);
    assert.equal(raiseBitrate(state, { now: 91_500 }), null);
    assert.equal(paddingShare(state), 0.35);
});

test('the wait between failed tests stops growing at sixteen minutes', () => {
    const state = createBitrateState({ targetKbps: 14000, startKbps: 7000 });
    let now = 0;
    const waits = [];
    for (let attempt = 0; attempt < 8; attempt++) {
        const from = now;
        for (;;) {
            trackLag(state, { lagSec: 0, now });
            raiseBitrate(state, { now });
            if (paddingShare(state) > 0) break;
            now += 1000;
        }
        waits.push(Math.round((now - from) / 1000));
        trackLag(state, { lagSec: 2, now: now + 1000 });
        trackLag(state, { lagSec: 2, now: now + 2000 });
        assert.equal(raiseBitrate(state, { now: now + 2000 }), null);
        assert.equal(paddingShare(state), 0);
        now += 2000;
    }
    assert.deepEqual(waits, [30, 60, 120, 240, 480, 960, 960, 960]);
    assert.equal(state.currentKbps, 7000);
});

test('a step up that makes viewers lag after all is taken back', () => {
    const state = createBitrateState({ targetKbps: 14000, startKbps: 7000 });
    keepUp(state, 0, 34_000);
    raiseBitrate(state, { now: 30_000 });
    assert.equal(raiseBitrate(state, { now: 34_000 }), 8400);

    trackLag(state, { lagSec: 0.4, now: 36_000 });
    assert.equal(settleRaise(state, { now: 36_000 }), null);
    trackLag(state, { lagSec: 0.5, now: 37_000 });
    assert.equal(settleRaise(state, { now: 37_000 }), 7000);
    assert.equal(state.currentKbps, 7000);
    assert.equal(settleRaise(state, { now: 37_100 }), null);

    // And the next test waits twice as long.
    keepUp(state, 37_100, 97_100);
    assert.equal(raiseBitrate(state, { now: 67_100 }), null);
    assert.equal(paddingShare(state), 0);
    assert.equal(raiseBitrate(state, { now: 97_100 }), null);
    assert.equal(paddingShare(state), 0.35);

    // A step that holds restores the normal wait.
    keepUp(state, 97_200, 200_000);
    assert.equal(raiseBitrate(state, { now: 101_100 }), 8400);
    assert.equal(settleRaise(state, { now: 121_100 }), null);
    assert.equal(raiseBitrate(state, { now: 131_100 }), null);
    assert.equal(paddingShare(state), 0.35);
});

test('viewers that are not keeping up never have the link tested', () => {
    const state = createBitrateState({ targetKbps: 14000, startKbps: 7000 });
    for (let now = 0; now <= 120_000; now += 100) {
        // Never far behind, never caught up.
        trackLag(state, { lagSec: 0.25, now });
        assert.equal(raiseBitrate(state, { now }), null);
        assert.equal(paddingShare(state), 0);
    }
});

test('real congestion ends a test, and takes a step on trial back instead of cutting further', () => {
    const testing = createBitrateState({ targetKbps: 14000, startKbps: 7000, audioKbps: 192 });
    keepUp(testing, 0, 30_000);
    raiseBitrate(testing, { now: 30_000 });
    assert.equal(paddingShare(testing), 0.35);
    assert.equal(lowerBitrate(testing, { now: 31_000, goodputKbps: 6000 }), 4008);
    assert.equal(paddingShare(testing), 0);

    const onTrial = createBitrateState({ targetKbps: 14000, startKbps: 7000, audioKbps: 192 });
    keepUp(onTrial, 0, 34_000);
    raiseBitrate(onTrial, { now: 30_000 });
    assert.equal(raiseBitrate(onTrial, { now: 34_000 }), 8400);
    assert.equal(lowerBitrate(onTrial, { now: 38_000, goodputKbps: 7500 }), 7000);
    assert.equal(onTrial.trial, null);

    // A cut also makes the relay slower to test the link again.
    assert.equal(lowerBitrate(onTrial, { now: 40_000, goodputKbps: 6000 }), 4008);
    keepUp(onTrial, 40_100, 160_000);
    assert.equal(raiseBitrate(onTrial, { now: 159_000 }), null);
    assert.equal(paddingShare(onTrial), 0);
    assert.equal(raiseBitrate(onTrial, { now: 160_000 }), null);
    assert.equal(paddingShare(onTrial), 0.35);
});

test('an empty room forgets the pace it had settled into', () => {
    const state = createBitrateState({ targetKbps: 14000, startKbps: 7000 });
    keepUp(state, 0, 30_000);
    raiseBitrate(state, { now: 30_000 });
    trackLag(state, { lagSec: 2, now: 31_000 });
    trackLag(state, { lagSec: 2, now: 32_000 });
    raiseBitrate(state, { now: 32_000 });

    resetRaise(state);

    assert.equal(state.calmSince, null);
    assert.equal(state.probe, null);
    assert.equal(state.trial, null);
    keepUp(state, 40_000, 70_000);
    raiseBitrate(state, { now: 70_000 });
    assert.equal(paddingShare(state), 0.35);
});

test('a queue that will not empty eases the bitrate down a little', () => {
    const state = createBitrateState({ targetKbps: 14000 });
    // Even the viewer that is least behind has had a queue for five seconds.
    for (let now = 0; now < 5000; now += 100) {
        trackPressure(state, { lagSec: 0.3, now });
        assert.equal(easeBitrate(state, { now }), null);
    }
    trackPressure(state, { lagSec: 0.3, now: 5000 });
    assert.equal(easeBitrate(state, { now: 5000 }), 12600);
    assert.equal(state.currentKbps, 12600);

    // The step gets the same time to show before another.
    for (let now = 5100; now < 10_000; now += 100) {
        trackPressure(state, { lagSec: 0.3, now });
        assert.equal(easeBitrate(state, { now }), null);
    }
    trackPressure(state, { lagSec: 0.3, now: 10_000 });
    assert.equal(easeBitrate(state, { now: 10_000 }), 11340);

    // Once the queue empties there is nothing to ease.
    trackPressure(state, { lagSec: 0.05, now: 10_100 });
    for (let now = 10_200; now < 60_000; now += 1000) assert.equal(easeBitrate(state, { now }), null);
});

test('a queue that keeps emptying is a link with room, however often it fills', () => {
    const state = createBitrateState({ targetKbps: 14000 });
    for (let now = 0; now <= 60_000; now += 100) {
        // A keyframe a second: a queue for 300 ms, then none.
        trackPressure(state, { lagSec: now % 1000 < 300 ? 0.25 : 0.02, now });
        assert.equal(easeBitrate(state, { now }), null);
    }
});

test('easing stops at the floor and makes the relay slower to test the link', () => {
    const floor = createBitrateState({ targetKbps: 14000, startKbps: FLOOR_KBPS + 100 });
    trackPressure(floor, { lagSec: 1, now: 0 });
    assert.equal(easeBitrate(floor, { now: 5000 }), FLOOR_KBPS);
    assert.equal(easeBitrate(floor, { now: 10_000 }), null);

    const state = createBitrateState({ targetKbps: 14000, startKbps: 10000 });
    trackPressure(state, { lagSec: 1, now: 0 });
    assert.equal(easeBitrate(state, { now: 5000 }), 9000);
    trackPressure(state, { lagSec: 0, now: 5100 });
    keepUp(state, 5100, 65_100);
    assert.equal(raiseBitrate(state, { now: 65_000 }), null);
    assert.equal(paddingShare(state), 0);
    assert.equal(raiseBitrate(state, { now: 65_100 }), null);
    assert.equal(paddingShare(state), 0.35);
});

test('the queue a failed test of the link leaves behind gets its own time to empty', () => {
    const state = createBitrateState({ targetKbps: 14000, startKbps: 7000 });
    keepUp(state, 0, 30_000);
    raiseBitrate(state, { now: 30_000 });
    // The filler builds a queue for four and a half seconds before it is found out.
    for (let now = 30_100; now <= 34_400; now += 100) trackPressure(state, { lagSec: 0.2, now });
    trackLag(state, { lagSec: 0.2, now: 33_900 });
    trackLag(state, { lagSec: 0.2, now: 34_400 });
    assert.equal(raiseBitrate(state, { now: 34_400 }), null);
    assert.equal(paddingShare(state), 0);

    // Without that, the bitrate would be eased half a second later for a queue
    // the test itself put there.
    for (let now = 34_500; now < 39_400; now += 100) {
        trackPressure(state, { lagSec: 0.2, now });
        assert.equal(easeBitrate(state, { now }), null);
    }
    trackPressure(state, { lagSec: 0.2, now: 39_400 });
    assert.equal(easeBitrate(state, { now: 39_400 }), 6300);
});

test('a link is plainly too slow when every viewer is a second behind and received less than the stream', () => {
    const state = createBitrateState({ targetKbps: 14000, audioKbps: 192 });
    const at = { now: 60_000 };
    // A second behind, and what arrived came at 10 Mbps for a 14.2 Mbps stream.
    assert.equal(isOverloaded(state, { leastLagSec: 1.2, goodputKbps: 10_000, ...at }), true);
    // Not yet a second behind: the gentler steps deal with that.
    assert.equal(isOverloaded(state, { leastLagSec: 0.8, goodputKbps: 10_000, ...at }), false);
    // A stall that is over: everything arrives at once, faster than the stream.
    assert.equal(isOverloaded(state, { leastLagSec: 1.5, goodputKbps: 40_000, ...at }), false);
    assert.equal(isOverloaded(state, { leastLagSec: 1.5, goodputKbps: 13_700, ...at }), false);
    // Nothing measured yet is no evidence either.
    assert.equal(isOverloaded(state, { leastLagSec: 3, goodputKbps: null, ...at }), false);
    // And a change that was just made gets time to show.
    state.lastChangeAt = 58_000;
    assert.equal(isOverloaded(state, { leastLagSec: 1.2, goodputKbps: 10_000, ...at }), false);
    assert.equal(isOverloaded(state, { leastLagSec: 1.2, goodputKbps: 10_000, now: 63_000 }), true);
});
