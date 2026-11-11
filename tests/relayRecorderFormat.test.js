const test = require('node:test');
const assert = require('node:assert/strict');

const relayRecorderFormatModule = import('../src/lib/relayRecorderFormat.mjs');

// iPhone relay viewers can only play H.264 MP4, so hosts that can record it
// prefer it (AAC audio, High profile, 1s keyframes so fragments stay short);
// every other host keeps exactly the historical VP8 chain.
test('relay recorder prefers H.264/AAC MP4 with 1s keyframes when the browser can record it', async () => {
    const { selectRelayRecorderFormat } = await relayRecorderFormatModule;

    assert.deepEqual(selectRelayRecorderFormat(() => true), {
        mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2',
        options: { videoKeyFrameIntervalDuration: 1000 },
    });
});

test('relay recorder falls back to the VP8 chain without MP4 support or after an MP4 failure', async () => {
    const { selectRelayRecorderFormat } = await relayRecorderFormatModule;
    const only = (...types) => (type) => types.includes(type);

    assert.deepEqual(selectRelayRecorderFormat(only('video/webm;codecs=vp8,opus')), {
        mimeType: 'video/webm;codecs=vp8,opus',
        options: {},
    });
    assert.equal(selectRelayRecorderFormat(only('video/webm;codecs=vp8')).mimeType, 'video/webm;codecs=vp8');
    assert.equal(selectRelayRecorderFormat(() => false).mimeType, 'video/webm');
    assert.equal(
        selectRelayRecorderFormat(() => true, { allowMp4: false }).mimeType,
        'video/webm;codecs=vp8,opus',
    );
});

// OBS dynamic bitrate and WebRTC GCC both drop fast and recover slowly; the
// relay does the same, bounded by a floor and by the profile's own target.
test('relay congestion steps the recorder bitrate down to 70% with a 2.5 Mbps floor', async () => {
    const { lowerRelayBitrate } = await relayRecorderFormatModule;

    assert.equal(lowerRelayBitrate(20_000_000), 14_000_000);
    assert.equal(lowerRelayBitrate(3_000_000), 2_500_000);
    assert.equal(lowerRelayBitrate(2_500_000), 2_500_000);
});

// From the 2.5 Mbps floor, 25% steps every 30 s regain a 12 Mbps target in
// about 3.5 minutes; each step restarts the recorder, so it stays gradual.
test('a stable relay steps back up 25% every 30 s and releases the limit at the profile target', async () => {
    const { raiseRelayBitrate, RELAY_BITRATE_STEP_UP_AFTER_MS } = await relayRecorderFormatModule;

    assert.equal(RELAY_BITRATE_STEP_UP_AFTER_MS, 30_000);
    assert.equal(raiseRelayBitrate(10_000_000, 20_000_000), 12_500_000);
    assert.equal(raiseRelayBitrate(17_000_000, 20_000_000), null);
    assert.equal(raiseRelayBitrate(20_000_000, 20_000_000), null);
});

// A relay recorder that errors or stops by itself is restarted, but a recorder
// that fails every time must not restart in a tight loop: three restarts per
// minute, then the relay stays down until something else changes.
test('relay recorder restarts are allowed up to the cap, then denied until the window moves on', async () => {
    const { allowRelayRecorderRestart } = await relayRecorderFormatModule;
    const budget = { max: 3, windowMs: 60_000 };

    let history = [];
    for (const now of [1_000, 2_000, 3_000]) {
        const decision = allowRelayRecorderRestart(history, now, budget);
        assert.equal(decision.allowed, true, `restart at ${now}`);
        history = decision.history;
    }
    assert.deepEqual(history, [1_000, 2_000, 3_000]);

    // The cap holds, and a denied request does not extend the window.
    const denied = allowRelayRecorderRestart(history, 59_999, budget);
    assert.equal(denied.allowed, false);
    assert.deepEqual(denied.history, [1_000, 2_000, 3_000]);

    // The oldest restart leaves the window exactly windowMs after it happened.
    const reopened = allowRelayRecorderRestart(history, 61_000, budget);
    assert.equal(reopened.allowed, true);
    assert.deepEqual(reopened.history, [2_000, 3_000, 61_000]);
    assert.equal(allowRelayRecorderRestart(reopened.history, 61_001, budget).allowed, false);
});

test('relay recorder restart budget defaults to 3 per 60 s and leaves the caller\'s history alone', async () => {
    const { allowRelayRecorderRestart, RELAY_RECORDER_RESTART_BUDGET } = await relayRecorderFormatModule;

    assert.deepEqual({ ...RELAY_RECORDER_RESTART_BUDGET }, { max: 3, windowMs: 60_000 });
    const history = Object.freeze([10, 20]);
    const third = allowRelayRecorderRestart(history, 30);
    assert.equal(third.allowed, true);
    assert.deepEqual(history, [10, 20]);
    assert.equal(allowRelayRecorderRestart(third.history, 40).allowed, false);
    assert.equal(allowRelayRecorderRestart(third.history, 60_010).allowed, true);
    // A cap given without a window keeps the default window.
    assert.equal(allowRelayRecorderRestart([0], 30_000, { max: 1 }).allowed, false);
    assert.equal(allowRelayRecorderRestart([0], 60_000, { max: 1 }).allowed, true);
});

// HostView logs one warning when the budget runs out, not one per later failure.
test('the restart budget reports exhaustion once, and starts over after a reset or a quiet minute', async () => {
    const { createRelayRecorderRestartBudget } = await relayRecorderFormatModule;
    let now = 0;
    const budget = createRelayRecorderRestartBudget({ now: () => now, max: 2, windowMs: 1_000 });

    assert.equal(budget.request(), 'restart');
    now = 100;
    assert.equal(budget.request(), 'restart');
    now = 200;
    assert.equal(budget.request(), 'exhausted');
    now = 300;
    assert.equal(budget.request(), 'denied');
    assert.equal(budget.request(), 'denied');

    // Once the window has moved on a restart is allowed again, and a later
    // exhaustion is reported again.
    now = 1_100;
    assert.equal(budget.request(), 'restart');
    now = 1_150;
    assert.equal(budget.request(), 'restart');
    now = 1_200;
    assert.equal(budget.request(), 'exhausted');

    budget.reset();
    assert.equal(budget.request(), 'restart');
    assert.equal(budget.request(), 'restart');
    assert.equal(budget.request(), 'exhausted');
});
