const test = require('node:test');
const assert = require('node:assert/strict');

test('the player leaves playback alone while it is near its cushion', async () => {
    const { decideLiveSync } = await import('../src/lib/relayLiveSync.mjs');
    assert.deepEqual(decideLiveSync({ ahead: 0.5, target: 0.5 }), { rate: 1, seekBack: null });
    assert.deepEqual(decideLiveSync({ ahead: 0.6, target: 0.5 }), { rate: 1, seekBack: null });
    assert.deepEqual(decideLiveSync({ ahead: 0.4, target: 0.5 }), { rate: 1, seekBack: null });
});

test('a little too far behind live is made up by playing faster, within a limit', async () => {
    const { decideLiveSync } = await import('../src/lib/relayLiveSync.mjs');
    const slightly = decideLiveSync({ ahead: 0.8, target: 0.5 });
    assert.equal(slightly.seekBack, null);
    assert.ok(slightly.rate > 1.05 && slightly.rate < 1.2, `rate ${slightly.rate}`);
    const more = decideLiveSync({ ahead: 1.9, target: 0.5 });
    assert.equal(more.seekBack, null);
    assert.equal(more.rate, 1.2);
});

test('seconds behind live is a jump, not a chase', async () => {
    const { decideLiveSync } = await import('../src/lib/relayLiveSync.mjs');
    assert.deepEqual(decideLiveSync({ ahead: 2.1, target: 0.5 }), { rate: 1, seekBack: 0.5 });
});

test('a cushion that is running out slows playback a little', async () => {
    const { decideLiveSync } = await import('../src/lib/relayLiveSync.mjs');
    const low = decideLiveSync({ ahead: 0.2, target: 0.5 });
    assert.ok(low.rate < 1 && low.rate >= 0.92, `rate ${low.rate}`);
    assert.equal(decideLiveSync({ ahead: 0, target: 0.5 }).rate, 0.92);
});

test('nonsense input changes nothing', async () => {
    const { decideLiveSync } = await import('../src/lib/relayLiveSync.mjs');
    assert.deepEqual(decideLiveSync({ ahead: NaN, target: 0.5 }), { rate: 1, seekBack: null });
    assert.deepEqual(decideLiveSync({ ahead: -1, target: 0.5 }), { rate: 1, seekBack: null });
});

test('the cushion grows with each stall up to a limit and relaxes back to a floor', async () => {
    const sync = await import('../src/lib/relayLiveSync.mjs');
    let target = sync.TARGET_START_SECONDS;
    target = sync.targetAfterStall(target);
    assert.ok(target > sync.TARGET_START_SECONDS);
    for (let i = 0; i < 20; i++) target = sync.targetAfterStall(target);
    assert.equal(target, sync.TARGET_MAX_SECONDS);
    for (let i = 0; i < 100; i++) target = sync.targetAfterQuietPeriod(target);
    assert.equal(target, sync.TARGET_MIN_SECONDS);
});

test('a bitrate switch in the offing is met with a little more in reserve', async () => {
    const { targetBeforeSwitch, TARGET_MAX_SECONDS } = await import('../src/lib/relayLiveSync.mjs');
    assert.ok(Math.abs(targetBeforeSwitch(0.5) - 0.8) < 1e-9);
    assert.ok(Math.abs(targetBeforeSwitch(0.35) - 0.65) < 1e-9);
    assert.equal(targetBeforeSwitch(TARGET_MAX_SECONDS), TARGET_MAX_SECONDS);
});
