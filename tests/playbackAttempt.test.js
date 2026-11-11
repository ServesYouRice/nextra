'use strict';

// Deterministic tests of src/lib/playbackAttempt.mjs: attempt ownership for
// WatchView's playback starters and the recovery guard shared by its
// transport-failed and reconnect handlers. Every async step is a promise the
// test settles by hand; no timers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

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

test('supersede gives up the attempt only while it is the current one', async () => {
    const { beginPlaybackAttempt } = await loadModule();
    const attemptRef = { current: 0 };

    const first = beginPlaybackAttempt(attemptRef);
    first.supersede();
    assert.equal(first.isCurrent(), false);
    assert.equal(attemptRef.current, 2);

    const second = beginPlaybackAttempt(attemptRef);
    const counter = attemptRef.current;
    first.supersede();
    assert.equal(attemptRef.current, counter, 'a stale attempt leaves the counter alone');
    assert.equal(second.isCurrent(), true, 'a stale supersede must not take the newer attempt down');
});

test('withDeadline passes the start outcome through and stops its timer', async () => {
    const { withDeadline, isSupersededAttemptError } = await loadModule();
    const attemptRef = { current: 0 };
    let seen = null;

    const value = await withDeadline(attemptRef, async (attempt) => {
        seen = attempt;
        return 'started';
    }, { ms: 20 });
    assert.equal(value, 'started');
    assert.equal(seen.id, 1, 'the start runs as the attempt withDeadline began');
    assert.equal(seen.isCurrent(), true, 'a start that finished in time stays current');

    const failure = new Error('Host stream is not ready yet.');
    await assert.rejects(withDeadline(attemptRef, async () => { throw failure; }, { ms: 20 }), (err) => err === failure);
    await assert.rejects(withDeadline(attemptRef, () => { throw failure; }, { ms: 20 }), (err) => err === failure,
        'a start that throws before returning a promise');

    // The timers were cleared: waiting past the deadline changes nothing.
    const counter = attemptRef.current;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(attemptRef.current, counter);

    const superseded = await withDeadline(attemptRef, async (attempt) => {
        attemptRef.current += 1;
        throw attempt.settleFailure(new Error('late'));
    }, { ms: 20 }).catch((err) => err);
    assert.equal(isSupersededAttemptError(superseded), true, "the start's own superseded error passes through");
});

test('withDeadline gives up a start that never settles: supersedes it, frees its resources, reports a timeout', async () => {
    const { withDeadline, PlaybackDeadlineError, isSupersededAttemptError, PLAYBACK_DEADLINE_MS } = await loadModule();
    assert.equal(PLAYBACK_DEADLINE_MS, 40000);
    const attemptRef = { current: 0 };
    const released = [];
    const hung = deferred();
    let startedAttempt = null;

    const startedAt = Date.now();
    const result = withDeadline(attemptRef, (attempt) => {
        startedAttempt = attempt;
        attempt.own(() => released.push('transport'));
        return hung.promise;
    }, { ms: 30, message: 'Connection timed out.' });

    const error = await result.catch((err) => err);
    assert.ok(error instanceof PlaybackDeadlineError);
    assert.equal(isSupersededAttemptError(error), false, 'a timeout is a failure to report, not a silent supersede');
    assert.equal(error.message, 'Connection timed out.');
    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(startedAttempt.isCurrent(), false, 'the attempt was superseded');
    assert.deepEqual(released, ['transport'], 'its own resources were released');

    // The hung start finally settling changes nothing and raises nothing unhandled.
    hung.reject(new Error('late failure'));
    await drainMicrotasks();
    assert.deepEqual(released, ['transport']);
});

test('withDeadline leaves a newer owner alone when the attempt it guards was replaced', async () => {
    const { withDeadline, beginPlaybackAttempt, isSupersededAttemptError } = await loadModule();
    const attemptRef = { current: 0 };
    const released = [];
    let guarded = null;

    const result = withDeadline(attemptRef, (attempt) => {
        guarded = attempt;
        attempt.own(() => released.push('guarded-transport'));
        return new Promise(() => { });
    }, { ms: 30 });
    // A Leave or a newer Watch takes the session over while the start hangs.
    const newer = beginPlaybackAttempt(attemptRef);
    newer.own(() => released.push('newer-transport'));

    const error = await result.catch((err) => err);
    assert.equal(isSupersededAttemptError(error), true, 'the caller leaves the session to the newer owner');
    assert.equal(newer.isCurrent(), true, 'the deadline did not supersede the newer attempt');
    assert.equal(guarded.isCurrent(), false);
    assert.deepEqual(released, ['guarded-transport']);
});

// A mediasoup-client transport as far as the ICE wait uses it.
function fakeTransport(connectionState = 'new') {
    const emitter = new EventEmitter();
    const observer = new EventEmitter();
    return {
        connectionState,
        on: (event, listener) => emitter.on(event, listener),
        off: (event, listener) => emitter.off(event, listener),
        observer: {
            on: (event, listener) => observer.on(event, listener),
            off: (event, listener) => observer.off(event, listener),
        },
        emitState(state) {
            this.connectionState = state;
            emitter.emit('connectionstatechange', state);
        },
        // mediasoup-client's close(): the state changes, only the observer hears it.
        close() {
            this.connectionState = 'closed';
            observer.emit('close');
        },
        listenerCount: () => emitter.listenerCount('connectionstatechange') + observer.listenerCount('close'),
    };
}

test('the ICE wait times out in its own window while nothing else settles', async () => {
    const { waitForTransportConnected } = await loadModule();
    const transport = fakeTransport();
    // What the old start path sat behind: a play() promise that never settles.
    const neverPlays = new Promise(() => { });
    void neverPlays;

    const startedAt = Date.now();
    const error = await waitForTransportConnected(transport, {
        timeoutMs: 40,
        timeoutMessage: 'WebRTC connection timed out (ICE could not connect).',
    }).catch((err) => err);
    assert.equal(error.message, 'WebRTC connection timed out (ICE could not connect).');
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 30 && elapsed < 1000, `timed out after ${elapsed} ms`);
    assert.equal(transport.listenerCount(), 0, 'its listeners are gone');
});

test('the ICE wait ends when the transport connects, fails or is already connected', async () => {
    const { waitForTransportConnected } = await loadModule();
    const states = [];
    const options = { timeoutMs: 5000, timeoutMessage: 'timed out', onStateChange: (state) => states.push(state) };

    assert.equal(await waitForTransportConnected(fakeTransport('connected'), options), undefined, 'already connected');

    const connecting = fakeTransport('new');
    const waiting = waitForTransportConnected(connecting, options);
    connecting.emitState('connecting');
    connecting.emitState('connected');
    assert.equal(await waiting, undefined);
    assert.equal(connecting.listenerCount(), 0);

    const failing = fakeTransport('new');
    const failed = waitForTransportConnected(failing, options);
    failing.emitState('failed');
    await assert.rejects(failed, /WebRTC connection failed\./);
    assert.equal(failing.listenerCount(), 0);

    await assert.rejects(waitForTransportConnected(fakeTransport('failed'), options), /WebRTC connection failed\./);
    assert.deepEqual(states, ['connecting', 'connected', 'failed']);
});

test('the ICE wait of a transport that cleanup closed ends at once instead of waiting out its timer', async () => {
    const { waitForTransportConnected } = await loadModule();
    const transport = fakeTransport('new');

    const startedAt = Date.now();
    const waiting = waitForTransportConnected(transport, { timeoutMs: 5000, timeoutMessage: 'timed out' });
    transport.close();
    await assert.rejects(waiting, /WebRTC connection closed\./);
    assert.ok(Date.now() - startedAt < 1000, 'did not wait for the 5 s timer');
    assert.equal(transport.listenerCount(), 0);

    await assert.rejects(waitForTransportConnected(transport, { timeoutMs: 5000, timeoutMessage: 'timed out' }),
        /WebRTC connection closed\./, 'a transport that is already closed');
});

test('WatchView starts WebRTC playback without waiting on video.play() before the ICE wait', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'WatchView.jsx'), 'utf8');
    assert.doesNotMatch(source, /await\s+playVideoElement\(/, 'play() promises are never awaited');
    assert.match(source, /void playVideoElement\(newStream,/);
    const consume = source.indexOf('const consumeProducer');
    const iceWait = source.indexOf('await waitForTransportConnected(');
    assert.ok(consume > 0 && iceWait > consume, 'the ICE wait is a timed wait of its own');
    // handleWatch has its own 40 s timer; every other caller runs under withDeadline.
    const calls = source.match(/startMediasoupPlayback\(\{[^}]*\}\)/g) ?? [];
    assert.equal(calls.length, 3, 'Try WebRTC and the two recovery paths');
    for (const call of calls) {
        assert.match(call, /attempt/, `${call.replace(/\s+/g, ' ')} runs as the attempt withDeadline began`);
    }
    assert.equal((source.match(/withDeadline\(activePlaybackAttemptRef/g) ?? []).length, 3);
});
