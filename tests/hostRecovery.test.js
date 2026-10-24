'use strict';

// Tests of src/lib/hostRecovery.mjs: how a failed reclaim of the stored room is
// classified, how it is retried inside the recovery window, and when OBS needs
// a stop afterwards. Time is a variable the test moves; nothing sleeps.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ROOM_STATE_CODES, createRoomState } = require('../lib/roomState');

const loadRecovery = () => import('../src/lib/hostRecovery.mjs');
const loadClient = () => import('../src/lib/mediasoupClient.js');

class FakeSocket extends EventEmitter {
    constructor({ connected = true, onRequest } = {}) {
        super();
        this.connected = connected;
        this.onRequest = onRequest;
    }

    connect() {}

    emit(event, ...args) {
        if (event === 'connect' || event === 'connect_error' || event === 'disconnect') {
            return super.emit(event, ...args);
        }
        this.onRequest?.(event, ...args);
        return true;
    }
}

// What socketRequest rejects with, built the way it builds it.
function serverRejection(response) {
    return Object.assign(new Error(response.error), response, { phase: 'server' });
}

function timeoutError() {
    return Object.assign(new Error('Request "reclaim-host" timed out after 5s'), { phase: 'ack-timeout' });
}

function disconnectError() {
    return Object.assign(new Error('Connection lost while waiting for "reclaim-host" (transport close)'), {
        phase: 'disconnect-after-emit',
    });
}

function connectError() {
    return Object.assign(new Error('Socket connect failed: cannot reach the Nextra server'), { phase: 'connect' });
}

const roomGone = () => serverRejection({
    success: false,
    error: 'Room not found or token invalid.',
    ...createRoomState(ROOM_STATE_CODES.RECLAIM_REJECTED, 'The room ended or its reclaim token is no longer valid.'),
});

// A clock the test owns, and a wait that moves it.
function createClock() {
    const clock = {
        t: 0,
        waits: [],
        now: () => clock.t,
        async wait(ms) {
            clock.waits.push(ms);
            clock.t += ms;
        },
    };
    return clock;
}

async function drainMicrotasks() {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

test('classifyReclaimFailure: only a failure the server tagged terminal ends the session', async () => {
    const { classifyReclaimFailure } = await loadRecovery();

    assert.equal(classifyReclaimFailure(roomGone()), 'terminal');
    assert.equal(classifyReclaimFailure(serverRejection({ success: false, error: 'x', terminal: true })), 'terminal');

    // The same rule as onReconnect's `err.terminal === true`: everything else is transient.
    assert.equal(classifyReclaimFailure(timeoutError()), 'transient');
    assert.equal(classifyReclaimFailure(disconnectError()), 'transient');
    assert.equal(classifyReclaimFailure(connectError()), 'transient');
    assert.equal(classifyReclaimFailure(serverRejection({ success: false, error: 'Internal error' })), 'transient');
    assert.equal(classifyReclaimFailure(serverRejection({ success: false, error: 'x', terminal: false })), 'transient');
    assert.equal(classifyReclaimFailure(serverRejection({ success: false, error: 'x', terminal: 'true' })), 'transient');
});

test('classifyReclaimFailure: unknown errors are transient', async () => {
    const { classifyReclaimFailure } = await loadRecovery();

    assert.equal(classifyReclaimFailure(new Error('boom')), 'transient');
    assert.equal(classifyReclaimFailure(new TypeError('x is not a function')), 'transient');
    assert.equal(classifyReclaimFailure({}), 'transient');
    assert.equal(classifyReclaimFailure('timeout'), 'transient');
    assert.equal(classifyReclaimFailure(null), 'transient');
    assert.equal(classifyReclaimFailure(undefined), 'transient');
});

test('classifyReclaimFailure agrees with what socketRequest produces for the server\'s answers and for a timeout', async () => {
    const { classifyReclaimFailure } = await loadRecovery();
    const { socketRequest } = await loadClient();

    // Every rejection lib/socket.js sends for reclaim-host that means the room is gone.
    const rejections = [
        createRoomState(ROOM_STATE_CODES.RECLAIM_REJECTED, 'Room reclaim was rejected.'),
        createRoomState(ROOM_STATE_CODES.RECLAIM_REJECTED, 'The room ended or its reclaim token is no longer valid.'),
    ];
    for (const state of rejections) {
        const socket = new FakeSocket({
            onRequest: (_event, _payload, callback) => callback({ success: false, error: 'rejected', ...state }),
        });
        await assert.rejects(
            socketRequest(socket, 'reclaim-host', {}),
            (err) => classifyReclaimFailure(err) === 'terminal',
        );
    }

    // The handler's catch-all answer carries no state: the room may well still exist.
    const internal = new FakeSocket({
        onRequest: (_event, _payload, callback) => callback({ success: false, error: 'Internal error' }),
    });
    await assert.rejects(
        socketRequest(internal, 'reclaim-host', {}),
        (err) => classifyReclaimFailure(err) === 'transient',
    );

    // A request nobody answers.
    const silent = new FakeSocket();
    await assert.rejects(
        socketRequest(silent, 'reclaim-host', {}, { timeoutMs: 5, maxAttempts: 1 }),
        (err) => err.phase === 'ack-timeout' && classifyReclaimFailure(err) === 'transient',
    );

    // A connection lost after the emit.
    const dropping = new FakeSocket({ onRequest: (_event, _payload, _callback) => dropping.emit('disconnect', 'transport close') });
    await assert.rejects(
        socketRequest(dropping, 'reclaim-host', {}, { maxAttempts: 1 }),
        (err) => err.phase === 'disconnect-after-emit' && classifyReclaimFailure(err) === 'transient',
    );
});

test('shouldStopObsAfterFailedReclaim: a stored OBS room needs a stop, nothing else does', async () => {
    const { shouldStopObsAfterFailedReclaim } = await loadRecovery();

    assert.equal(shouldStopObsAfterFailedReclaim({ code: 'ABCDEF', hostToken: 't', ingestMode: 'obs' }), true);
    assert.equal(shouldStopObsAfterFailedReclaim({ code: 'ABCDEF', hostToken: 't', ingestMode: 'browser' }), false);
    // A record from before the ingest mode was stored, or a damaged one.
    assert.equal(shouldStopObsAfterFailedReclaim({ code: 'ABCDEF', hostToken: 't' }), false);
    assert.equal(shouldStopObsAfterFailedReclaim({ ingestMode: 'OBS' }), false);
    assert.equal(shouldStopObsAfterFailedReclaim({ ingestMode: true }), false);
    assert.equal(shouldStopObsAfterFailedReclaim(null), false);
    assert.equal(shouldStopObsAfterFailedReclaim(undefined), false);
});

test('reclaimRetryDelayMs doubles from half a second up to a four second cap', async () => {
    const { reclaimRetryDelayMs } = await loadRecovery();

    assert.deepEqual(
        [1, 2, 3, 4, 5, 6, 20].map(reclaimRetryDelayMs),
        [500, 1000, 2000, 4000, 4000, 4000, 4000],
    );
});

test('reclaimWithRetry: a first try that succeeds makes one request and never waits', async () => {
    const { reclaimWithRetry } = await loadRecovery();
    const clock = createClock();
    const attempts = [];

    const outcome = await reclaimWithRetry({
        request: async (attempt) => {
            attempts.push(attempt);
            return { success: true, ingestMode: 'browser', reloadRecoveryEnabled: true };
        },
        isCancelled: () => false,
        wait: clock.wait,
        now: clock.now,
    });

    assert.equal(outcome.status, 'reclaimed');
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.response.reloadRecoveryEnabled, true);
    assert.deepEqual(clock.waits, []);
    // One attempt of the helper is one request: the retrying happens here, inside the window.
    assert.deepEqual(attempts, [{ timeoutMs: 5000, connectTimeoutMs: 5000, maxAttempts: 1 }]);
});

test('reclaimWithRetry: transient failures are retried, with a growing pause, until one succeeds', async () => {
    const { reclaimWithRetry } = await loadRecovery();
    const clock = createClock();
    const failures = [timeoutError(), disconnectError(), connectError()];
    const warned = [];

    const outcome = await reclaimWithRetry({
        request: async () => {
            const failure = failures.shift();
            if (failure) throw failure;
            return { success: true };
        },
        isCancelled: () => false,
        wait: clock.wait,
        now: clock.now,
        onRetry: (attempts, err) => warned.push([attempts, err.phase]),
    });

    assert.equal(outcome.status, 'reclaimed');
    assert.equal(outcome.attempts, 4);
    assert.deepEqual(clock.waits, [500, 1000, 2000]);
    assert.deepEqual(warned, [[1, 'ack-timeout'], [2, 'disconnect-after-emit'], [3, 'connect']]);
});

test('reclaimWithRetry: a terminal failure ends it at once, without a pause or a second request', async () => {
    const { reclaimWithRetry } = await loadRecovery();
    const clock = createClock();
    let requests = 0;

    const outcome = await reclaimWithRetry({
        request: async () => {
            requests += 1;
            throw roomGone();
        },
        isCancelled: () => false,
        wait: clock.wait,
        now: clock.now,
    });

    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.terminal, true);
    assert.equal(outcome.error.code, 'reclaim-rejected');
    assert.equal(outcome.attempts, 1);
    assert.equal(requests, 1);
    assert.deepEqual(clock.waits, []);
});

test('reclaimWithRetry: a transient failure that never clears gives up inside the recovery window', async () => {
    const { reclaimWithRetry, RECLAIM_RETRY_WINDOW_MS } = await loadRecovery();
    const clock = createClock();
    const timeouts = [];

    const outcome = await reclaimWithRetry({
        request: async (attempt) => {
            timeouts.push(attempt.timeoutMs);
            // A timeout takes its whole timeout to show.
            clock.t += attempt.timeoutMs;
            throw timeoutError();
        },
        isCancelled: () => false,
        wait: clock.wait,
        now: clock.now,
        maxAttempts: 100,
    });

    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.terminal, false);
    assert.equal(outcome.error.phase, 'ack-timeout');
    assert.ok(outcome.attempts > 2, 'it kept trying');
    assert.ok(clock.t <= RECLAIM_RETRY_WINDOW_MS, `finished at ${clock.t} ms, inside the ${RECLAIM_RETRY_WINDOW_MS} ms window`);
    // No pause was begun that would have ended past the window.
    assert.ok(clock.waits.every((ms) => ms <= 4000));
    // The last attempts were given what was left, never more than a normal attempt and never nothing.
    assert.ok(timeouts.every((ms) => ms >= 1000 && ms <= 5000));
});

test('reclaimWithRetry: the number of attempts is bounded', async () => {
    const { reclaimWithRetry } = await loadRecovery();
    const clock = createClock();
    let requests = 0;

    const outcome = await reclaimWithRetry({
        request: async () => {
            requests += 1;
            throw disconnectError();
        },
        isCancelled: () => false,
        wait: clock.wait,
        now: clock.now,
        maxAttempts: 4,
    });

    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.terminal, false);
    assert.equal(requests, 4);
    // No pause after the last attempt.
    assert.deepEqual(clock.waits, [500, 1000, 2000]);
});

test('reclaimWithRetry: an attempt near the end of the window gets only what is left of it', async () => {
    const { reclaimWithRetry } = await loadRecovery();
    const clock = createClock();
    const timeouts = [];

    await reclaimWithRetry({
        request: async (attempt) => {
            timeouts.push(attempt.timeoutMs);
            clock.t += 10_000; // each attempt eats ten seconds
            throw timeoutError();
        },
        isCancelled: () => false,
        wait: clock.wait,
        now: clock.now,
        windowMs: 25_000,
        delayMs: () => 100,
        maxAttempts: 10,
    });

    // 25 s window, 10.1 s per round: the third attempt starts with ~4.8 s left.
    assert.equal(timeouts[0], 5000);
    assert.equal(timeouts[1], 5000);
    assert.equal(timeouts[2], 4800);
});

test('reclaimWithRetry: cancelling while it waits sends nothing more and clears the timer', async () => {
    const { reclaimWithRetry, createCancellableWait } = await loadRecovery();
    const timers = createFakeTimers();
    const waiter = createCancellableWait(timers);
    let cancelled = false;
    let requests = 0;

    const run = reclaimWithRetry({
        request: async () => {
            requests += 1;
            throw timeoutError();
        },
        isCancelled: () => cancelled,
        wait: waiter.wait,
    });
    await drainMicrotasks();
    assert.equal(requests, 1);
    assert.equal(timers.active(), 1, 'the pause is a pending timer');

    // The effect's cleanup.
    cancelled = true;
    waiter.cancel();
    const outcome = await run;

    assert.equal(outcome.status, 'cancelled');
    assert.equal(requests, 1, 'no request after cleanup');
    assert.equal(timers.active(), 0, 'the timer was cleared, not left to fire');
    assert.equal(waiter.pendingCount, 0);
});

test('reclaimWithRetry: cancelling while a request is in flight ignores what it returns', async () => {
    const { reclaimWithRetry } = await loadRecovery();
    const clock = createClock();

    for (const settle of ['resolves', 'rejects transient', 'rejects terminal']) {
        let cancelled = false;
        let release;
        let requests = 0;
        const run = reclaimWithRetry({
            request: () => new Promise((resolve, reject) => {
                requests += 1;
                release = () => {
                    if (settle === 'resolves') resolve({ success: true });
                    else reject(settle === 'rejects transient' ? timeoutError() : roomGone());
                };
            }),
            isCancelled: () => cancelled,
            wait: clock.wait,
            now: clock.now,
        });
        await drainMicrotasks();
        cancelled = true;
        release();
        const outcome = await run;

        assert.equal(outcome.status, 'cancelled', settle);
        assert.equal(requests, 1, settle);
        assert.deepEqual(clock.waits, [], settle);
    }
});

test('reclaimWithRetry: when the host has started a room of their own it stops retrying, but a reply is still delivered', async () => {
    const { reclaimWithRetry } = await loadRecovery();
    const clock = createClock();
    let giveUp = false;
    let requests = 0;

    // The first attempt is made whatever shouldGiveUp says, and its success is delivered.
    giveUp = true;
    const delivered = await reclaimWithRetry({
        request: async () => ({ success: true }),
        isCancelled: () => false,
        shouldGiveUp: () => giveUp,
        wait: clock.wait,
        now: clock.now,
    });
    assert.equal(delivered.status, 'reclaimed');

    // After a failure it does not try again.
    const gaveUp = await reclaimWithRetry({
        request: async () => {
            requests += 1;
            throw timeoutError();
        },
        isCancelled: () => false,
        shouldGiveUp: () => giveUp,
        wait: clock.wait,
        now: clock.now,
    });
    assert.equal(gaveUp.status, 'gave-up');
    assert.equal(requests, 1);
    assert.deepEqual(clock.waits, []);

    // During the pause: the check after the pause stops the next attempt.
    giveUp = false;
    requests = 0;
    const duringPause = await reclaimWithRetry({
        request: async () => {
            requests += 1;
            throw timeoutError();
        },
        isCancelled: () => false,
        shouldGiveUp: () => giveUp,
        wait: async (ms) => {
            clock.waits.push(ms);
            giveUp = true;
        },
        now: clock.now,
    });
    assert.equal(duringPause.status, 'gave-up');
    assert.equal(requests, 1);
});

// A timer implementation the test fires by hand.
function createFakeTimers() {
    let nextId = 1;
    const timers = new Map();
    return {
        setTimer(callback, ms) {
            const id = nextId;
            nextId += 1;
            timers.set(id, { callback, ms });
            return id;
        },
        clearTimer(id) {
            timers.delete(id);
        },
        active: () => timers.size,
        fire(id) {
            const timer = timers.get(id);
            timers.delete(id);
            timer?.callback();
        },
        fireAll() {
            for (const id of [...timers.keys()]) this.fire(id);
        },
    };
}

test('createCancellableWait: resolves when the timer fires and when it is cancelled', async () => {
    const { createCancellableWait } = await loadRecovery();
    const timers = createFakeTimers();
    const waiter = createCancellableWait(timers);

    let fired = false;
    waiter.wait(500).then(() => { fired = true; });
    await drainMicrotasks();
    assert.equal(fired, false);
    timers.fireAll();
    await drainMicrotasks();
    assert.equal(fired, true);
    assert.equal(waiter.pendingCount, 0);
    assert.equal(timers.active(), 0);

    let cancelledWait = false;
    waiter.wait(500).then(() => { cancelledWait = true; });
    await drainMicrotasks();
    waiter.cancel();
    await drainMicrotasks();
    assert.equal(cancelledWait, true);
    assert.equal(timers.active(), 0);
    assert.equal(waiter.pendingCount, 0);
});

test('createCancellableWait: StrictMode\'s replayed effect cancels the first run without touching the second', async () => {
    const { reclaimWithRetry, createCancellableWait } = await loadRecovery();
    const timers = createFakeTimers();

    // Each effect run owns its flag and its waiter, as HostView's effect does.
    function runEffect(request) {
        const state = { cancelled: false };
        const waiter = createCancellableWait(timers);
        const outcome = reclaimWithRetry({
            request,
            isCancelled: () => state.cancelled,
            wait: waiter.wait,
        });
        return { outcome, cleanup() { state.cancelled = true; waiter.cancel(); } };
    }

    const calls = { first: 0, second: 0 };
    const first = runEffect(async () => {
        calls.first += 1;
        throw timeoutError();
    });
    await drainMicrotasks();
    first.cleanup(); // setup, cleanup, setup
    const second = runEffect(async () => {
        calls.second += 1;
        if (calls.second < 2) throw timeoutError();
        return { success: true };
    });
    await drainMicrotasks();

    assert.equal((await first.outcome).status, 'cancelled');
    assert.equal(timers.active(), 1, 'only the second run holds a timer');
    timers.fireAll();
    const secondOutcome = await second.outcome;

    assert.equal(secondOutcome.status, 'reclaimed');
    assert.deepEqual(calls, { first: 1, second: 2 });
    assert.equal(timers.active(), 0);
});

test('shouldTeardownAfterStartFailure: a reclaimed room survives a failure before its capture is in use', async () => {
    const { START_PHASES, shouldTeardownAfterStartFailure } = await loadRecovery();

    // A preflight blocker, and a cancelled or failed picker (NotAllowedError,
    // NotFoundError, a stream without a video track): nothing of the room is
    // in use yet, so it stays for another Resume Sharing.
    assert.equal(shouldTeardownAfterStartFailure({ resumed: true, phase: START_PHASES.PREFLIGHT }), false);
    assert.equal(shouldTeardownAfterStartFailure({ resumed: true, phase: START_PHASES.CAPTURE }), false);
});

test('shouldTeardownAfterStartFailure: a reclaimed room in use, and every fresh room, are torn down', async () => {
    const { START_PHASES, shouldTeardownAfterStartFailure } = await loadRecovery();

    // Once the start has taken the reclaimed room over (transport, producers,
    // OBS configuration), a failure ends it as before.
    for (const phase of [START_PHASES.ROOM, START_PHASES.MEDIA, START_PHASES.OBS]) {
        assert.equal(shouldTeardownAfterStartFailure({ resumed: true, phase }), true, phase);
    }
    // A fresh room keeps the full teardown in every phase.
    for (const phase of Object.values(START_PHASES)) {
        assert.equal(shouldTeardownAfterStartFailure({ resumed: false, phase }), true, phase);
    }
    // A phase it does not know is treated as in use.
    assert.equal(shouldTeardownAfterStartFailure({ resumed: true, phase: 'publish' }), true);
    assert.equal(shouldTeardownAfterStartFailure({ resumed: true, phase: undefined }), true);
});

test('recoveredRoomIngestMode reads the mode a reclaimed room was created with', async () => {
    const { recoveredRoomIngestMode } = await loadRecovery();

    assert.equal(recoveredRoomIngestMode({ code: 'ABCDEF', ingestMode: 'obs' }), 'obs');
    assert.equal(recoveredRoomIngestMode({ code: 'ABCDEF', ingestMode: 'browser' }), 'browser');
    // An older server that did not say: the same default the page adopts.
    assert.equal(recoveredRoomIngestMode({ code: 'ABCDEF' }), 'browser');
    assert.equal(recoveredRoomIngestMode({ ingestMode: 'OBS' }), 'browser');
});

test('isIngestModeMismatch: only a mode other than the waiting room\'s own is a mismatch', async () => {
    const { isIngestModeMismatch } = await loadRecovery();
    const browserRoom = { code: 'ABCDEF', hostToken: 't', ingestMode: 'browser' };

    assert.equal(isIngestModeMismatch({ recoveredRoom: browserRoom, ingestMode: 'obs' }), true);
    assert.equal(isIngestModeMismatch({ recoveredRoom: browserRoom, ingestMode: 'browser' }), false);
    assert.equal(isIngestModeMismatch({ recoveredRoom: { ingestMode: 'obs' }, ingestMode: 'browser' }), true);
    assert.equal(isIngestModeMismatch({ recoveredRoom: { ingestMode: 'obs' }, ingestMode: 'obs' }), false);
    // No room waiting: any mode may be chosen for the next fresh room.
    assert.equal(isIngestModeMismatch({ recoveredRoom: null, ingestMode: 'obs' }), false);
    assert.equal(isIngestModeMismatch({ recoveredRoom: undefined, ingestMode: 'browser' }), false);
});
