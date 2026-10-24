'use strict';

// Deterministic tests of src/lib/playbackAttempt.mjs: attempt ownership for
// WatchView's playback starters and the recovery guard shared by its
// transport-failed and reconnect handlers. Every async step is a promise the
// test settles by hand; no timers.

const test = require('node:test');
const assert = require('node:assert/strict');

const loadModule = () => import('../src/lib/playbackAttempt.mjs');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function drainMicrotasks() {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

test('an attempt is current until a cleanup or a newer attempt moves the counter on', async () => {
    const { beginPlaybackAttempt, isAttemptCurrent, assertAttemptCurrent, isSupersededAttemptError } = await loadModule();
    const attemptRef = { current: 0 };

    const first = beginPlaybackAttempt(attemptRef);
    assert.equal(first.id, 1);
    assert.equal(first.isCurrent(), true);
    first.assertCurrent();

    // cleanupPlayback does exactly this.
    attemptRef.current += 1;
    assert.equal(first.isCurrent(), false);
    assert.equal(isAttemptCurrent(first.id, attemptRef), false);
    assert.throws(() => first.assertCurrent(), (err) => isSupersededAttemptError(err));
    assert.throws(() => assertAttemptCurrent(first.id, attemptRef), (err) => isSupersededAttemptError(err));

    const second = beginPlaybackAttempt(attemptRef);
    const third = beginPlaybackAttempt(attemptRef);
    assert.equal(second.isCurrent(), false, 'a newer begin supersedes the older attempt');
    assert.equal(third.isCurrent(), true);
});

test('a superseded attempt is identifiable and distinct from real failures', async () => {
    const { SupersededAttemptError, isSupersededAttemptError } = await loadModule();
    const superseded = new SupersededAttemptError();
    assert.equal(superseded instanceof Error, true);
    assert.equal(superseded.name, 'SupersededAttemptError');
    assert.equal(isSupersededAttemptError(superseded), true);
    assert.equal(isSupersededAttemptError(new Error('WebRTC connection timed out')), false);
    const lookalike = new Error('A newer playback attempt replaced this one.');
    lookalike.name = 'SupersededAttemptError';
    assert.equal(isSupersededAttemptError(lookalike), false, 'only the class counts, not a name or message');
    assert.equal(isSupersededAttemptError(null), false);
    assert.equal(isSupersededAttemptError(undefined), false);
});

test('a superseded attempt releases only its own resources, newest first, once', async () => {
    const { beginPlaybackAttempt, isSupersededAttemptError } = await loadModule();
    const attemptRef = { current: 0 };
    const released = [];
    const shared = { transport: 'newer-transport', objectUrl: 'blob:newer' };

    const stale = beginPlaybackAttempt(attemptRef);
    stale.own(() => released.push('stale-transport'));
    stale.own(() => { throw new Error('revoke failed'); });
    stale.own(() => released.push('stale-object-url'));

    const newer = beginPlaybackAttempt(attemptRef);
    newer.own(() => released.push('newer-transport'));

    const reported = stale.settleFailure(new Error('MediaSource did not open'));
    assert.equal(isSupersededAttemptError(reported), true, 'the stale failure is reported as superseded');
    assert.deepEqual(released, ['stale-object-url', 'stale-transport'], 'a failing release does not stop the others');
    assert.deepEqual(shared, { transport: 'newer-transport', objectUrl: 'blob:newer' }, 'shared state untouched');

    stale.dispose();
    stale.settleFailure(new Error('again'));
    assert.deepEqual(released, ['stale-object-url', 'stale-transport'], 'released once');

    stale.own(() => released.push('late-resource'));
    assert.deepEqual(released, ['stale-object-url', 'stale-transport', 'late-resource'],
        'a resource created after disposal is released at once');
    assert.equal(newer.isCurrent(), true);
});

test('a current attempt passes its failure on and keeps its resources for cleanupPlayback', async () => {
    const { beginPlaybackAttempt, SupersededAttemptError } = await loadModule();
    const attemptRef = { current: 0 };
    const released = [];
    const attempt = beginPlaybackAttempt(attemptRef);
    attempt.own(() => released.push('transport'));

    const failure = new Error('Relay stream is not ready yet. Try again in a moment.');
    assert.equal(attempt.settleFailure(failure), failure);
    assert.deepEqual(released, []);

    attemptRef.current += 1;
    const superseded = new SupersededAttemptError();
    assert.equal(attempt.settleFailure(superseded), superseded, 'an existing SupersededAttemptError is passed through');
    assert.deepEqual(released, ['transport']);
});

test('the recovery guard drops a transport failure that arrives while a recovery runs', async () => {
    const { createRecoveryGuard } = await loadModule();
    const guard = createRecoveryGuard();
    const first = deferred();
    const runs = [];

    const chain = guard.run('transport-failed', async () => {
        runs.push('first');
        await first.promise;
    });
    assert.equal(guard.activeKind, 'transport-failed');

    assert.equal(await guard.run('transport-failed', () => runs.push('second')), false);
    assert.equal(guard.followUpKind, null);

    first.resolve();
    assert.equal(await chain, true);
    assert.deepEqual(runs, ['first']);
    assert.equal(guard.activeKind, null);

    assert.equal(await guard.run('transport-failed', () => runs.push('later')), true, 'a trigger after it settled runs');
    assert.deepEqual(runs, ['first', 'later']);
});

test('reconnects during a recovery coalesce into one follow-up that runs after it with the chain intent', async () => {
    const { createRecoveryGuard } = await loadModule();
    const guard = createRecoveryGuard();
    const first = deferred();
    const runs = [];
    let snapshot = { wasWatching: true, previousPlaybackMode: 'mediasoup' };

    const chain = guard.run('transport-failed', async (intent) => {
        runs.push(['transport-failed', intent]);
        // The recovery's own resets change what the refs say.
        snapshot = { wasWatching: false, previousPlaybackMode: '' };
        await first.promise;
    }, { captureIntent: () => snapshot });

    assert.equal(await guard.run('reconnect', (intent) => runs.push(['reconnect-1', intent]), {
        followUp: true,
        captureIntent: () => snapshot,
    }), false);
    assert.equal(await guard.run('reconnect', (intent) => runs.push(['reconnect-2', intent]), {
        followUp: true,
        captureIntent: () => snapshot,
    }), false);
    assert.equal(guard.followUpKind, 'reconnect');
    await drainMicrotasks();
    assert.equal(runs.length, 1, 'no follow-up while the recovery runs');

    first.resolve();
    assert.equal(await chain, true);
    const chainIntent = { wasWatching: true, previousPlaybackMode: 'mediasoup' };
    assert.deepEqual(runs, [
        ['transport-failed', chainIntent],
        ['reconnect-2', chainIntent],
    ], 'one follow-up, the latest trigger, with the intent captured when the chain began');
    assert.equal(guard.activeKind, null);
    assert.equal(guard.followUpKind, null);

    // A new chain captures afresh.
    await guard.run('reconnect', (intent) => runs.push(['fresh', intent]), { captureIntent: () => snapshot });
    assert.deepEqual(runs.at(-1), ['fresh', { wasWatching: false, previousPlaybackMode: '' }]);
});

test('a queued follow-up can be dropped, and a failing recovery does not wedge the guard', async () => {
    const { createRecoveryGuard } = await loadModule();
    const errors = [];
    const guard = createRecoveryGuard({ onError: (err) => errors.push(err.message) });
    const first = deferred();
    const runs = [];

    const chain = guard.run('reconnect', async () => {
        runs.push('first');
        await first.promise;
    });
    await guard.run('reconnect', () => runs.push('follow-up'), { followUp: true });
    guard.clearFollowUp();
    first.reject(new Error('rejoin failed'));
    assert.equal(await chain, true);
    assert.deepEqual(runs, ['first']);
    assert.deepEqual(errors, ['rejoin failed']);

    assert.equal(await guard.run('reconnect', () => runs.push('next')), true);
    assert.deepEqual(runs, ['first', 'next']);
});

test('a trigger from inside a running recovery is queued or dropped, never run concurrently', async () => {
    const { createRecoveryGuard } = await loadModule();
    const guard = createRecoveryGuard();
    const runs = [];
    await guard.run('transport-failed', async () => {
        runs.push('outer-start');
        assert.equal(await guard.run('transport-failed', () => runs.push('nested-drop')), false);
        assert.equal(await guard.run('reconnect', () => runs.push('nested-follow-up'), { followUp: true }), false);
        runs.push('outer-end');
    });
    assert.deepEqual(runs, ['outer-start', 'outer-end', 'nested-follow-up']);
});
