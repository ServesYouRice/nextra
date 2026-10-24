'use strict';

// Deterministic tests of src/lib/obsOperationQueue.mjs: every OBS call is a
// promise the test settles by hand, and `obs` records the order in which the
// calls reach OBS. No timers or sleeps.

const test = require('node:test');
const assert = require('node:assert/strict');

const loadQueue = () => import('../src/lib/obsOperationQueue.mjs');
const loadGuard = () => import('../src/lib/startOperationGuard.mjs');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

// Let every continuation that can run, run.
async function drainMicrotasks() {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

// A stand-in for OBS: configure and stop calls are logged when they begin and
// settle only when the test says so (or at once, with `autoSettle`).
function createObs({ autoSettleStops = true } = {}) {
    const log = [];
    const configures = new Map();
    const stops = [];
    return {
        log,
        configure(token) {
            return () => {
                log.push(`configure ${token}`);
                const call = deferred();
                configures.set(token, call);
                return call.promise.then((result) => {
                    log.push(`configure ${token} done`);
                    return result;
                });
            };
        },
        finishConfigure(token, result = { success: true, message: 'OBS configured' }) {
            configures.get(token).resolve(result);
        },
        failConfigure(token, error) {
            configures.get(token).reject(error);
        },
        stop(label = 'stop') {
            return () => {
                log.push(label);
                if (autoSettleStops) return Promise.resolve();
                const call = deferred();
                stops.push(call);
                return call.promise;
            };
        },
        stops,
    };
}

// Sessions the way HostView's guard names them: one current token at a time.
function createSessions(initial = null) {
    const sessions = { current: initial };
    sessions.isCurrent = (token) => token !== null && token === sessions.current;
    return sessions;
}

test('operations run one at a time, in the order they were enqueued', async () => {
    const { createObsOperationQueue } = await loadQueue();
    const queue = createObsOperationQueue();
    const log = [];
    const gates = [deferred(), deferred(), deferred()];
    const results = gates.map((gate, index) => queue.enqueue(async () => {
        log.push(`start ${index}`);
        await gate.promise;
        log.push(`end ${index}`);
        return index;
    }));
    assert.equal(queue.pending, 3);

    await drainMicrotasks();
    assert.deepEqual(log, ['start 0']);
    // A later operation that is ready first still waits its turn.
    gates[2].resolve();
    gates[1].resolve();
    await drainMicrotasks();
    assert.deepEqual(log, ['start 0']);

    gates[0].resolve();
    assert.deepEqual(await Promise.all(results), [0, 1, 2]);
    assert.deepEqual(log, ['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
    assert.equal(queue.pending, 0);
});

test('a rejected operation rejects only to its caller, and the next operation still runs', async () => {
    const { createObsOperationQueue } = await loadQueue();
    const queue = createObsOperationQueue();
    const failing = queue.enqueue(async () => {
        throw new Error('OBS went away');
    });
    const throwingSync = queue.enqueue(() => {
        throw new Error('thrown before any await');
    });
    const next = queue.enqueue(() => 'ran');

    await assert.rejects(failing, /OBS went away/);
    await assert.rejects(throwingSync, /thrown before any await/);
    assert.equal(await next, 'ran');
    assert.equal(queue.pending, 0);
});

test('ownership is claimed and released only inside a running operation', async () => {
    const { createObsOperationQueue } = await loadQueue();
    const queue = createObsOperationQueue();
    assert.equal(queue.owner, null);

    let handle = null;
    await queue.enqueue((ownership) => {
        handle = ownership;
        ownership.claim(1);
        assert.equal(queue.owner, 1);
        assert.equal(ownership.owner, 1);
        assert.equal(ownership.release(2), false, 'another token does not release it');
        assert.equal(queue.owner, 1);
    });
    assert.equal(queue.owner, 1, 'the claim outlives the operation');
    assert.throws(() => handle.release(1), /only inside a running queued operation/);
    assert.throws(() => handle.claim(3), /only inside a running queued operation/);
    assert.equal(queue.owner, 1);

    await queue.enqueue((ownership) => {
        assert.equal(ownership.release(1), true);
    });
    assert.equal(queue.owner, null);
});

test('a teardown stop is sent and gives the output back when its session or nobody owns OBS', async () => {
    const { createObsOperationQueue } = await loadQueue();
    const queue = createObsOperationQueue();
    const obs = createObs();
    const sessions = createSessions(1);

    // Nobody claimed OBS (the host set it up by hand): the stop still goes out.
    assert.equal(await queue.stop({ token: 1, isCurrent: sessions.isCurrent, stop: obs.stop('stop for 1') }), true);

    await queue.enqueue((ownership) => ownership.claim(1));
    sessions.current = null;
    assert.equal(await queue.stop({ token: 1, isCurrent: sessions.isCurrent, stop: obs.stop('stop for 1 again') }), true);
    assert.equal(queue.owner, null);
    assert.deepEqual(obs.log, ['stop for 1', 'stop for 1 again']);
});

test('a stale stop is skipped while a newer live session owns OBS, and sent once that owner is gone', async () => {
    const { createObsOperationQueue } = await loadQueue();
    const queue = createObsOperationQueue();
    const obs = createObs();
    const sessions = createSessions(2);

    await queue.enqueue((ownership) => ownership.claim(2));
    const skipped = await queue.stop({ token: 1, isCurrent: sessions.isCurrent, stop: obs.stop('stop for 1') });
    assert.equal(skipped, false);
    assert.deepEqual(obs.log, [], 'no stop on behalf of session 1 while session 2 owns OBS');
    assert.equal(queue.owner, 2);

    // Session 2 ended without giving the output back (its page kept the room
    // for reload recovery): an owner that is not live keeps nobody's stream.
    sessions.current = null;
    const sent = await queue.stop({ token: null, isCurrent: sessions.isCurrent, stop: obs.stop('stop for no session') });
    assert.equal(sent, true);
    assert.deepEqual(obs.log, ['stop for no session']);
    assert.equal(queue.owner, null);
});

test('a teardown stop that fails still gives the output back and does not stall the queue', async () => {
    const { createObsOperationQueue } = await loadQueue();
    const queue = createObsOperationQueue();
    const sessions = createSessions(1);
    await queue.enqueue((ownership) => ownership.claim(1));
    sessions.current = null;

    const sent = await queue.stop({
        token: 1,
        isCurrent: sessions.isCurrent,
        stop: () => Promise.reject(new Error('Cannot connect to OBS WebSocket.')),
    });
    assert.equal(sent, true);
    assert.equal(queue.owner, null);
    assert.equal(await queue.enqueue(() => 'next'), 'next');
});

test('a current configure claims OBS, returns its result and keeps the output', async () => {
    const { createObsOperationQueue } = await loadQueue();
    const queue = createObsOperationQueue();
    const obs = createObs();
    const sessions = createSessions(1);
    const started = [];

    const outcome = queue.configure({
        token: 1,
        isCurrent: sessions.isCurrent,
        configure: obs.configure(1),
        stop: obs.stop(),
        onStart: () => started.push(1),
    });
    await drainMicrotasks();
    assert.deepEqual(started, [1]);
    assert.equal(queue.owner, 1, 'claimed when the configure begins');
    assert.equal(queue.deferStopToConfigure(2), false, 'no configure of session 2 is queued');

    obs.finishConfigure(1, { success: false, message: 'OBS WebSocket authentication failed.' });
    assert.deepEqual(await outcome, {
        stale: false,
        result: { success: false, message: 'OBS WebSocket authentication failed.' },
    });
    assert.equal(queue.owner, 1, 'a live session keeps the output until its teardown');
    assert.deepEqual(obs.log, ['configure 1', 'configure 1 done']);
    assert.equal(queue.deferStopToConfigure(1), false, 'nothing is in flight once it has settled');
});

test('a configure whose session was torn down while it ran stops OBS once it ends, as the teardown left to it', async () => {
    const { createObsOperationQueue } = await loadQueue();
    const queue = createObsOperationQueue();
    const obs = createObs();
    const sessions = createSessions(1);
    const outcome = queue.configure({
        token: 1,
        isCurrent: sessions.isCurrent,
        configure: obs.configure(1),
        // Even a configure that by itself would not need a stop (no auto-start,
        // and it failed) owes the teardown its stop.
        shouldCompensate: () => false,
        stop: obs.stop('stop for 1'),
    });
    await drainMicrotasks();

    sessions.current = null;
    assert.equal(queue.deferStopToConfigure(1), true);
    // Nothing reaches OBS before the configure has finished with it.
    await drainMicrotasks();
    assert.deepEqual(obs.log, ['configure 1']);

    obs.finishConfigure(1, { success: false, message: 'Failed to set OBS stream settings.' });
    assert.deepEqual(await outcome, {
        stale: true,
        result: { success: false, message: 'Failed to set OBS stream settings.' },
    });
    assert.deepEqual(obs.log, ['configure 1', 'configure 1 done', 'stop for 1']);
    assert.equal(queue.owner, null);
});

test('a configure that went stale without a teardown stops OBS only when it may have left it streaming', async () => {
    const { createObsOperationQueue } = await loadQueue();
    const sessions = createSessions(1);

    for (const [result, autoStart, expectedStops] of [
        [{ success: true, message: 'OBS configured' }, false, ['stop for 1']],
        [{ success: false, message: 'auto-start failed' }, true, ['stop for 1']],
        [{ success: false, message: 'Failed to set OBS stream settings.' }, false, []],
    ]) {
        const queue = createObsOperationQueue();
        const obs = createObs();
        sessions.current = 1;
        const outcome = queue.configure({
            token: 1,
            isCurrent: sessions.isCurrent,
            configure: obs.configure(1),
            shouldCompensate: (configured) => autoStart || configured?.success === true,
            stop: obs.stop('stop for 1'),
        });
        await drainMicrotasks();
        // Replaced by a newer start (no teardown ran for it).
        sessions.current = 2;
        obs.finishConfigure(1, result);
        assert.equal((await outcome).stale, true);
        assert.deepEqual(obs.log.filter((entry) => entry.startsWith('stop')), expectedStops, result.message);
        assert.equal(queue.owner, null, 'the stale session gives the output back either way');
    }
});

test('a configure that rejects rejects to a current session, and is compensated for a stale one', async () => {
    const { createObsOperationQueue } = await loadQueue();
    const queue = createObsOperationQueue();
    const obs = createObs();
    const sessions = createSessions(1);

    const current = queue.configure({
        token: 1, isCurrent: sessions.isCurrent, configure: obs.configure(1), stop: obs.stop('stop for 1'),
    });
    await drainMicrotasks();
    obs.failConfigure(1, new Error('listEncoders failed'));
    await assert.rejects(current, /listEncoders failed/);

    sessions.current = 2;
    const compensations = [];
    const stale = queue.configure({
        token: 2,
        isCurrent: sessions.isCurrent,
        configure: obs.configure(2),
        shouldCompensate: (result) => {
            compensations.push(result);
            return true;
        },
        stop: obs.stop('stop for 2'),
    });
    await drainMicrotasks();
    sessions.current = null;
    obs.failConfigure(2, new Error('listEncoders failed'));
    assert.deepEqual(await stale, { stale: true, result: null });
    assert.deepEqual(compensations, [null], 'an unknown outcome is offered to shouldCompensate as null');
    assert.deepEqual(obs.log.filter((entry) => entry.startsWith('stop')), ['stop for 2']);
});

test('a configure whose session ended before its turn never touches OBS, apart from the stop its teardown left to it', async () => {
    const { createObsOperationQueue } = await loadQueue();
    const sessions = createSessions(2);

    for (const teardownDeferred of [false, true]) {
        const queue = createObsOperationQueue();
        const obs = createObs();
        sessions.current = 2;
        const busy = deferred();
        queue.enqueue(() => busy.promise);
        const started = [];
        const outcome = queue.configure({
            token: 2,
            isCurrent: sessions.isCurrent,
            configure: obs.configure(2),
            stop: obs.stop('stop for 2'),
            onStart: () => started.push(2),
        });
        await drainMicrotasks();
        assert.equal(queue.pending, 2);

        sessions.current = null;
        if (teardownDeferred) assert.equal(queue.deferStopToConfigure(2), true);
        busy.resolve();
        assert.deepEqual(await outcome, { stale: true, result: null });
        assert.deepEqual(started, [], 'not started');
        assert.equal(queue.owner, null, 'never claimed');
        assert.deepEqual(obs.log, teardownDeferred ? ['stop for 2'] : []);
    }
});

test('a stop enqueued for a session runs to its end before a configure enqueued after it begins', async () => {
    const { createObsOperationQueue } = await loadQueue();
    const queue = createObsOperationQueue();
    const obs = createObs({ autoSettleStops: false });
    const sessions = createSessions(1);
    await queue.enqueue((ownership) => ownership.claim(1));

    // Session 1 stops; session 2 starts at once and reaches its OBS step while
    // the stop is still on its way to OBS.
    sessions.current = null;
    assert.equal(queue.deferStopToConfigure(1), false);
    const stopped = queue.stop({ token: 1, isCurrent: sessions.isCurrent, stop: obs.stop('stop for 1') });
    sessions.current = 2;
    const configured = queue.configure({
        token: 2, isCurrent: sessions.isCurrent, configure: obs.configure(2), stop: obs.stop('stop for 2'),
    });
    await drainMicrotasks();
    assert.deepEqual(obs.log, ['stop for 1']);
    assert.equal(queue.owner, 1);

    obs.stops[0].resolve();
    await drainMicrotasks();
    assert.equal(await stopped, true);
    assert.deepEqual(obs.log, ['stop for 1', 'configure 2']);
    assert.equal(queue.owner, 2);

    obs.finishConfigure(2);
    assert.equal((await configured).stale, false);
    assert.deepEqual(obs.log, ['stop for 1', 'configure 2', 'configure 2 done']);
});

test('teardown of S during its configure, then a Start of S2: OBS hears S\'s stop before S2\'s configure and no stop after it', async () => {
    const { createObsOperationQueue } = await loadQueue();
    const { createStartOperationGuard } = await loadGuard();
    const queue = createObsOperationQueue();
    const guard = createStartOperationGuard();
    const isCurrent = (token) => guard.isCurrent(/** @type {number} */ (token));
    const obs = createObs();

    const s = guard.begin();
    const first = queue.configure({ token: s, isCurrent, configure: obs.configure('S'), stop: obs.stop('stop for S') });
    await drainMicrotasks();
    assert.equal(queue.owner, s);

    // Stop Sharing while S's configure runs: the teardown leaves its stop to it.
    const torndown = guard.activeOperation;
    guard.invalidate('stop');
    assert.equal(queue.deferStopToConfigure(torndown), true);

    const s2 = guard.begin();
    const second = queue.configure({ token: s2, isCurrent, configure: obs.configure('S2'), stop: obs.stop('stop for S2') });
    await drainMicrotasks();
    assert.deepEqual(obs.log, ['configure S'], 'S2 waits for S\'s configure');

    obs.finishConfigure('S');
    await drainMicrotasks();
    assert.deepEqual(obs.log, ['configure S', 'configure S done', 'stop for S', 'configure S2']);
    assert.equal(queue.owner, s2);
    assert.equal((await first).stale, true);

    obs.finishConfigure('S2');
    assert.equal((await second).stale, false);
    // S's teardown already has its stop; a late one for S finds S2 owning OBS.
    assert.equal(await queue.stop({ token: s, isCurrent, stop: obs.stop('late stop for S') }), false);
    assert.deepEqual(obs.log, ['configure S', 'configure S done', 'stop for S', 'configure S2', 'configure S2 done']);
    assert.equal(queue.owner, s2);
});

test('the page has one queue instance', async () => {
    const { obsOperationQueue, createObsOperationQueue } = await loadQueue();
    const again = await loadQueue();
    assert.equal(again.obsOperationQueue, obsOperationQueue);
    assert.equal(typeof obsOperationQueue.configure, 'function');
    assert.notEqual(createObsOperationQueue(), obsOperationQueue);
    assert.equal(obsOperationQueue.owner, null);
    assert.equal(obsOperationQueue.pending, 0);
});
