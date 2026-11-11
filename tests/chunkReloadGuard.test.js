const test = require('node:test');
const assert = require('node:assert/strict');

const KEY = 'nextra:chunkReloadBudget';
const WINDOW_MS = 60000;

function fakeStorage() {
    const map = new Map();
    return {
        map,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); },
    };
}

function clock(start = 1000000) {
    const state = { t: start };
    return { state, now: () => state.t };
}

// One simulated page load: a fresh guard over the shared storage, as a reload creates.
function loadPage(storage, clk, options = {}) {
    return createGuard({ storage, now: clk.now, windowMs: WINDOW_MS, storageKey: KEY, ...options });
}

let createGuard;
const ready = import('../src/lib/chunkReloadGuard.mjs').then((m) => { createGuard = m.createChunkReloadGuard; });

test('successive failures within the window stop after maxReloads', async () => {
    await ready;
    const storage = fakeStorage();
    const clk = clock();
    const results = [];
    for (let load = 0; load < 4; load++) {
        results.push(loadPage(storage, clk, { maxReloads: 2 }).tryConsumeReload());
        clk.state.t += 1000;
    }
    assert.deepEqual(results, [true, true, false, false]);
});

test('a failure about 5 s after each mount, repeated 10 times, reloads exactly maxReloads times', async () => {
    await ready;
    const storage = fakeStorage();
    const clk = clock();
    let reloads = 0;
    for (let load = 0; load < 10; load++) {
        // Mount, let the app run, then a lazy chunk fails 5 s later.
        clk.state.t += 5000;
        const guard = loadPage(storage, clk, { maxReloads: 2 });
        if (guard.tryConsumeReload()) reloads++;
        // Mounting in the next load must not clear the budget; nothing is called here on purpose.
    }
    assert.equal(reloads, 2);
});

test('mounting a fresh guard does not reset the persisted budget', async () => {
    await ready;
    const storage = fakeStorage();
    const clk = clock();
    assert.equal(loadPage(storage, clk, { maxReloads: 1 }).tryConsumeReload(), true);
    clk.state.t += 1000;
    // A later page load (new guard) inside the window is still capped.
    assert.equal(loadPage(storage, clk, { maxReloads: 1 }).tryConsumeReload(), false);
});

test('a fresh budget is allowed once windowMs has passed since firstAt', async () => {
    await ready;
    const storage = fakeStorage();
    const clk = clock();
    assert.equal(loadPage(storage, clk, { maxReloads: 1 }).tryConsumeReload(), true);
    clk.state.t += WINDOW_MS - 1;
    assert.equal(loadPage(storage, clk, { maxReloads: 1 }).tryConsumeReload(), false);
    clk.state.t += 1; // now() - firstAt === windowMs
    assert.equal(loadPage(storage, clk, { maxReloads: 1 }).tryConsumeReload(), true);
    const stored = JSON.parse(storage.getItem(KEY));
    assert.deepEqual(stored, { count: 1, firstAt: clk.state.t });
});

test('the window is measured from firstAt, not from the last reload', async () => {
    await ready;
    const storage = fakeStorage();
    const clk = clock();
    const first = clk.state.t;
    assert.equal(loadPage(storage, clk, { maxReloads: 3 }).tryConsumeReload(), true);
    clk.state.t += WINDOW_MS - 10;
    assert.equal(loadPage(storage, clk, { maxReloads: 3 }).tryConsumeReload(), true);
    assert.equal(JSON.parse(storage.getItem(KEY)).firstAt, first);
    clk.state.t += 10;
    assert.equal(loadPage(storage, clk, { maxReloads: 3 }).tryConsumeReload(), true);
    assert.deepEqual(JSON.parse(storage.getItem(KEY)), { count: 1, firstAt: clk.state.t });
});

test('malformed JSON starts a new window and does not throw', async () => {
    await ready;
    const storage = fakeStorage();
    const clk = clock();
    storage.setItem(KEY, '{not json');
    assert.equal(loadPage(storage, clk, { maxReloads: 2 }).tryConsumeReload(), true);
    assert.deepEqual(JSON.parse(storage.getItem(KEY)), { count: 1, firstAt: clk.state.t });
});

test('malformed shapes (wrong types, missing fields) start a new window', async () => {
    await ready;
    for (const bad of ['null', '42', '"x"', '{"count":"two","firstAt":1}', '{"count":5}', '{"count":1,"firstAt":"x"}']) {
        const storage = fakeStorage();
        const clk = clock();
        storage.setItem(KEY, bad);
        assert.equal(loadPage(storage, clk, { maxReloads: 2 }).tryConsumeReload(), true, bad);
    }
});

test('a clock that moved backwards starts a new window', async () => {
    await ready;
    const storage = fakeStorage();
    const clk = clock(5000000);
    assert.equal(loadPage(storage, clk, { maxReloads: 1 }).tryConsumeReload(), true);
    assert.equal(loadPage(storage, clk, { maxReloads: 1 }).tryConsumeReload(), false);
    clk.state.t -= 1000; // now() < firstAt
    assert.equal(loadPage(storage, clk, { maxReloads: 1 }).tryConsumeReload(), true);
    assert.deepEqual(JSON.parse(storage.getItem(KEY)), { count: 1, firstAt: clk.state.t });
});

test('storage = null returns false without throwing', async () => {
    await ready;
    const clk = clock();
    assert.doesNotThrow(() => {
        assert.equal(createGuard({ storage: null, now: clk.now, storageKey: KEY }).tryConsumeReload(), false);
        assert.equal(createGuard({ storage: undefined, now: clk.now, storageKey: KEY }).tryConsumeReload(), false);
    });
});

test('a storage whose getItem throws returns false without throwing', async () => {
    await ready;
    const clk = clock();
    const storage = fakeStorage();
    storage.getItem = () => { throw new Error('SecurityError'); };
    assert.doesNotThrow(() => {
        assert.equal(createGuard({ storage, now: clk.now, storageKey: KEY }).tryConsumeReload(), false);
    });
});

test('a storage whose setItem throws returns false and does not reload', async () => {
    await ready;
    const clk = clock();
    const storage = fakeStorage();
    storage.setItem = () => { throw new Error('QuotaExceededError'); };
    assert.doesNotThrow(() => {
        assert.equal(createGuard({ storage, now: clk.now, storageKey: KEY }).tryConsumeReload(), false);
    });
});

test('the persisted entry is written as {count, firstAt} with the incremented count', async () => {
    await ready;
    const storage = fakeStorage();
    const clk = clock();
    loadPage(storage, clk, { maxReloads: 2 }).tryConsumeReload();
    assert.deepEqual(JSON.parse(storage.getItem(KEY)), { count: 1, firstAt: clk.state.t });
    loadPage(storage, clk, { maxReloads: 2 }).tryConsumeReload();
    assert.deepEqual(JSON.parse(storage.getItem(KEY)), { count: 2, firstAt: clk.state.t - 0 });
});
