const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createMp4RelayStream,
    decideFragmentDelivery,
    decideHostCongestion,
    fragmentStartsWithKeyframe,
    readVideoTrackInfo,
    SKIP_GIVE_UP_MS,
} = require('../lib/relayMp4');

const { NON_SYNC, box, fragment, initSegment, traf, trak } = require('./mp4Boxes');

test('video track info comes from the vide handler and its trex defaults', () => {
    assert.deepEqual(readVideoTrackInfo(initSegment()), { videoTrackId: 2, defaultSampleFlags: NON_SYNC });
    assert.equal(readVideoTrackInfo(box('moov', trak(1, 'soun'))), null);
});

test('keyframe detection follows trun first, then per-sample, tfhd, and trex flag precedence', () => {
    const info = readVideoTrackInfo(initSegment());
    const audio = traf(1, { firstSampleFlags: 0 });

    assert.equal(fragmentStartsWithKeyframe(fragment([audio, traf(2, { firstSampleFlags: 0x2000000 })]), info), true);
    assert.equal(fragmentStartsWithKeyframe(fragment([audio, traf(2, { firstSampleFlags: NON_SYNC })]), info), false);
    assert.equal(fragmentStartsWithKeyframe(fragment([traf(2, { perSampleFlags: 0 })]), info), true);
    assert.equal(fragmentStartsWithKeyframe(fragment([traf(2, { tfhdDefaultFlags: 0 })]), info), true);
    // Only the trex default applies: the init segment marks video samples non-sync.
    assert.equal(fragmentStartsWithKeyframe(fragment([traf(2)]), info), false);
    // An audio-only fragment never counts as a video keyframe.
    assert.equal(fragmentStartsWithKeyframe(fragment([audio]), info), false);
    assert.equal(fragmentStartsWithKeyframe(fragment([traf(2, { firstSampleFlags: 0 })]), null), false);
});

test('the relay stream re-frames arbitrary byte splits into init and tagged fragments', () => {
    const init = initSegment();
    const key = fragment([traf(2, { firstSampleFlags: 0 })]);
    const delta = fragment([traf(2, { firstSampleFlags: NON_SYNC })]);
    const bytes = Buffer.concat([init, key, delta]);
    const inits = [];
    const fragments = [];
    const stream = createMp4RelayStream({
        onInit: (segment) => inits.push(segment),
        onFragment: (unit) => fragments.push(unit),
        onError: (err) => assert.fail(err.message),
    });

    for (let offset = 0; offset < bytes.length; offset += 7) stream.push(bytes.subarray(offset, offset + 7));

    assert.deepEqual(inits, [init]);
    assert.deepEqual(fragments.map(({ keyframe }) => keyframe), [true, false]);
    assert.deepEqual(fragments.map(({ data }) => data), [key, delta]);
});

test('a lagging viewer skips until a keyframe arrives with the queue drained', () => {
    const state = { skipping: false, skippingSince: 0 };

    assert.deepEqual(decideFragmentDelivery(state, { backlogSec: 1.4, keyframe: false, now: 0 }), { send: true, giveUp: false });
    assert.deepEqual(decideFragmentDelivery(state, { backlogSec: 1.6, keyframe: false, now: 1000 }), { send: false, giveUp: false });
    // Drained, but only a keyframe may resume a skipped viewer.
    assert.deepEqual(decideFragmentDelivery(state, { backlogSec: 0.1, keyframe: false, now: 2000 }), { send: false, giveUp: false });
    // Keyframe, but still too far behind.
    assert.deepEqual(decideFragmentDelivery(state, { backlogSec: 0.8, keyframe: true, now: 3000 }), { send: false, giveUp: false });
    assert.deepEqual(decideFragmentDelivery(state, { backlogSec: 0.2, keyframe: true, now: 4000 }), { send: true, giveUp: false });
    assert.equal(state.skipping, false);
});

test('a viewer that cannot take a single GOP for 30 s gives up', () => {
    const state = { skipping: false, skippingSince: 0 };
    decideFragmentDelivery(state, { backlogSec: 2, keyframe: false, now: 1000 });

    assert.equal(decideFragmentDelivery(state, { backlogSec: 2, keyframe: true, now: 1000 + SKIP_GIVE_UP_MS - 1 }).giveUp, false);
    assert.equal(decideFragmentDelivery(state, { backlogSec: 2, keyframe: true, now: 1000 + SKIP_GIVE_UP_MS }).giveUp, true);
});

test('the host is asked to lower bitrate only when every relay viewer has skipped for 5 s', () => {
    const congestion = { since: 0, lastSignalAt: 0 };

    // One of two viewers lagging is that viewer's own link: never signal.
    assert.equal(decideHostCongestion(congestion, { viewerCount: 2, skippingCount: 1, now: 0 }), false);
    assert.equal(decideHostCongestion(congestion, { viewerCount: 2, skippingCount: 1, now: 60_000 }), false);

    assert.equal(decideHostCongestion(congestion, { viewerCount: 2, skippingCount: 2, now: 100_000 }), false);
    assert.equal(decideHostCongestion(congestion, { viewerCount: 2, skippingCount: 2, now: 104_999 }), false);
    assert.equal(decideHostCongestion(congestion, { viewerCount: 2, skippingCount: 2, now: 105_000 }), true);
    // Rate limited to one signal per 20 s while congestion persists.
    assert.equal(decideHostCongestion(congestion, { viewerCount: 2, skippingCount: 2, now: 124_999 }), false);
    assert.equal(decideHostCongestion(congestion, { viewerCount: 2, skippingCount: 2, now: 125_000 }), true);

    // Recovery resets the hold timer.
    assert.equal(decideHostCongestion(congestion, { viewerCount: 1, skippingCount: 0, now: 130_000 }), false);
    assert.equal(congestion.since, 0);
});
