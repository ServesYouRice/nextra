const test = require('node:test');
const assert = require('node:assert/strict');

const { ExpiringTracker } = require('../lib/expiringTracker');

test('expiring tracker bounds entries by window and clears owned state', () => {
    let now = 1_000;
    const tracker = new ExpiringTracker(10_000, () => now);
    tracker.record('first');
    tracker.record('second');
    assert.equal(tracker.hasActive('first'), true);
    assert.equal(tracker.size, 2);

    now += 10_001;
    tracker.prune();
    assert.equal(tracker.size, 0);
    assert.equal(tracker.hasActive('first'), false);

    tracker.record('third');
    tracker.clear();
    assert.equal(tracker.size, 0);
});
