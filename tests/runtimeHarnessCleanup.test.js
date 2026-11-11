const test = require('node:test');
const assert = require('node:assert/strict');
const { closeSockets, settleWithin } = require('../scripts/runtime-harness-cleanup');

test('closeSockets closes every socket even when one of them throws on close', () => {
    const closed = [];
    const sockets = [
        { close: () => closed.push('a') },
        { close: () => { throw new Error('already gone'); } },
        { close: () => closed.push('c') },
    ];
    closeSockets(sockets);
    assert.deepEqual(closed, ['a', 'c']);
});

test('closeSockets accepts an empty list', () => {
    assert.doesNotThrow(() => closeSockets([]));
});

test('settleWithin resolves true once every promise has settled, rejected ones included', async () => {
    const outcome = await settleWithin([
        Promise.resolve(1),
        Promise.reject(new Error('failed loop')),
        new Promise((resolve) => setTimeout(resolve, 20)),
    ], 2_000);
    assert.equal(outcome, true);
});

test('settleWithin resolves true at once for no promises', async () => {
    assert.equal(await settleWithin([], 2_000), true);
});

test('settleWithin gives up after the timeout when a promise never settles', async () => {
    const startedAt = Date.now();
    const outcome = await settleWithin([new Promise(() => {})], 50);
    assert.equal(outcome, false);
    assert.ok(Date.now() - startedAt < 1_500);
});

test('settleWithin leaves no timer behind once the promises have settled', async () => {
    const timers = [];
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    const cleared = new Set();
    global.setTimeout = (...args) => {
        const timer = realSetTimeout(...args);
        if (args[1] === 60_000) timers.push(timer);
        return timer;
    };
    global.clearTimeout = (timer) => {
        cleared.add(timer);
        return realClearTimeout(timer);
    };
    try {
        await settleWithin([Promise.resolve()], 60_000);
    } finally {
        global.setTimeout = realSetTimeout;
        global.clearTimeout = realClearTimeout;
    }
    assert.equal(timers.length, 1);
    assert.equal(cleared.has(timers[0]), true);
});
