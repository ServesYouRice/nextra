const test = require('node:test');
const assert = require('node:assert/strict');
const { createShutdownCoordinator } = require('../lib/shutdownCoordinator');

// A coordinator with every side effect recorded in order. Timers never fire by
// themselves: a test fires them, so the order of arming and firing is exact.
function createHarness(options = {}) {
    const events = [];
    const exits = [];
    const logged = [];
    const timers = [];
    let closeCallback = null;

    const coordinator = createShutdownCoordinator({
        notifyRoomsEnded: (kind) => {
            events.push(`notify:${kind}`);
            if (options.notifyRoomsEnded) return options.notifyRoomsEnded(kind);
            return true;
        },
        onShutdownStart: () => { events.push('start'); },
        cleanup: () => {
            events.push('cleanup');
            if (options.cleanup) options.cleanup();
        },
        closeServer: (onClosed) => {
            events.push('closeServer');
            closeCallback = onClosed;
            if (options.closeServer) options.closeServer(onClosed);
        },
        exit: (code) => {
            events.push(`exit:${code}`);
            exits.push(code);
        },
        setTimer: (callback, ms) => {
            events.push(`timer:${ms}`);
            timers.push({ callback, ms, fired: false });
            return timers.length - 1;
        },
        log: {
            log: (...args) => { logged.push(['log', ...args]); },
            error: (...args) => { logged.push(['error', ...args]); },
        },
        flushMs: 150,
        gracefulForceExitMs: 5000,
        fatalForceExitMs: 4000,
    });

    return {
        coordinator,
        events,
        exits,
        logged,
        timers,
        closeServerCallback: () => closeCallback,
        fireTimer(ms) {
            const timer = timers.find((candidate) => candidate.ms === ms && !candidate.fired);
            assert.ok(timer, `no pending ${ms} ms timer; armed: ${timers.map((t) => t.ms).join(', ')}`);
            timer.fired = true;
            timer.callback();
        },
    };
}

test('a clean graceful shutdown notifies rooms, cleans up, closes the listener and exits 0', async () => {
    const h = createHarness();
    const done = h.coordinator.requestGraceful('SIGTERM');

    assert.equal(h.coordinator.getPhase(), 'graceful');
    assert.equal(h.coordinator.isShuttingDown(), true);
    h.fireTimer(150);
    await done;

    assert.deepEqual(h.events, ['timer:5000', 'start', 'notify:graceful', 'timer:150', 'cleanup', 'closeServer']);
    assert.deepEqual(h.exits, [], 'it waits for the listener to close');

    h.closeServerCallback()();
    assert.deepEqual(h.exits, [0]);
    assert.equal(h.events.includes('notify:fatal'), false);
    assert.ok(h.logged.some((entry) => entry[0] === 'log' && /SIGTERM received/.test(entry[1])));
});

test('a graceful shutdown without a socket server skips the flush wait', async () => {
    const h = createHarness({ notifyRoomsEnded: () => false });
    await h.coordinator.requestGraceful('SIGINT');

    assert.deepEqual(h.events, ['timer:5000', 'start', 'notify:graceful', 'cleanup', 'closeServer']);
    h.closeServerCallback()();
    assert.deepEqual(h.exits, [0]);
});

test('the graceful force-exit timer is armed before the first await and before any step that can throw', () => {
    const h = createHarness({ notifyRoomsEnded: () => { throw new Error('emit failed'); } });
    // No await: everything recorded so far ran in the synchronous part of the call.
    const done = h.coordinator.requestGraceful('SIGTERM');

    assert.equal(h.events[0], 'timer:5000');
    assert.ok(h.events.indexOf('timer:5000') < h.events.indexOf('start'));
    assert.ok(h.events.indexOf('timer:5000') < h.events.indexOf('notify:graceful'));
    return done;
});

test('the graceful force-exit timer ends the process with 0 when the listener never closes', async () => {
    const h = createHarness();
    const done = h.coordinator.requestGraceful('SIGTERM');
    h.fireTimer(150);
    await done;
    assert.deepEqual(h.exits, []);

    h.fireTimer(5000);
    assert.deepEqual(h.exits, [0]);

    // The listener closing afterwards does not exit a second time.
    h.closeServerCallback()();
    assert.deepEqual(h.exits, [0]);
});

test('a fatal error during a graceful shutdown cleans up and exits 1 without waiting for it', async () => {
    const h = createHarness();
    const graceful = h.coordinator.requestGraceful('SIGTERM');
    // The graceful path is waiting for its room-ended flush.
    assert.deepEqual(h.events, ['timer:5000', 'start', 'notify:graceful', 'timer:150']);

    await h.coordinator.requestFatal('unhandled-rejection');

    assert.equal(h.coordinator.getPhase(), 'fatal');
    assert.deepEqual(h.exits, [1]);
    assert.equal(h.events.filter((event) => event === 'cleanup').length, 1);
    assert.equal(h.events.includes('notify:fatal'), false, 'rooms were told already');
    assert.ok(h.logged.some((entry) => entry[0] === 'error' && /exiting after unhandled-rejection/.test(entry[1])));

    // The graceful flush ends later: it must neither clean up again nor close the listener.
    const before = h.events.length;
    h.fireTimer(150);
    await graceful;
    assert.equal(h.events.length, before);
    assert.deepEqual(h.exits, [1]);
});

test('a fatal error after the graceful cleanup, while the listener is still closing, exits 1 and cleans up again', async () => {
    const h = createHarness();
    const graceful = h.coordinator.requestGraceful('SIGTERM');
    h.fireTimer(150);
    await graceful;
    assert.equal(h.events.filter((event) => event === 'cleanup').length, 1);

    await h.coordinator.requestFatal('uncaught-exception');
    assert.deepEqual(h.exits, [1]);
    assert.equal(h.events.filter((event) => event === 'cleanup').length, 2);

    // Neither the listener closing nor the graceful force-exit timer can turn it into exit 0.
    h.closeServerCallback()();
    h.fireTimer(5000);
    assert.deepEqual(h.exits, [1]);
});

test('a fatal error exits 1 even when the graceful force-exit timer fires while the fatal flush waits', async () => {
    // Rooms were not told by the graceful path (no socket server then), so the fatal path flushes.
    const notified = [];
    const h = createHarness({ notifyRoomsEnded: (kind) => { notified.push(kind); return kind === 'fatal'; } });
    const graceful = h.coordinator.requestGraceful('SIGTERM');
    await graceful;

    const fatal = h.coordinator.requestFatal('uncaught-exception');
    assert.deepEqual(notified, ['graceful', 'fatal']);
    assert.deepEqual(h.exits, [], 'the fatal flush is still waiting');

    h.fireTimer(5000);
    assert.deepEqual(h.exits, [1], 'a phase that is fatal never exits 0');

    h.fireTimer(150);
    await fatal;
    assert.deepEqual(h.exits, [1]);
});

test('a graceful shutdown that throws before cleanup is handled as a fatal error and exits 1', async () => {
    const h = createHarness({ notifyRoomsEnded: (kind) => { if (kind === 'graceful') throw new Error('emit failed'); return false; } });

    await h.coordinator.requestGraceful('SIGTERM');

    assert.deepEqual(h.exits, [1]);
    assert.equal(h.events.includes('closeServer'), false);
    assert.ok(h.events.includes('cleanup'));
    assert.equal(h.events[0], 'timer:5000');
    assert.ok(h.logged.some((entry) => entry[0] === 'error' && /Graceful shutdown failed/.test(entry[1])));
    assert.ok(h.logged.some((entry) => entry[0] === 'error' && /exiting after graceful-shutdown-failed/.test(entry[1])));
});

test('a graceful shutdown whose cleanup throws exits 1 and does not close the listener', async () => {
    let calls = 0;
    const h = createHarness({
        notifyRoomsEnded: () => false,
        cleanup: () => { calls += 1; if (calls === 1) throw new Error('cleanup failed'); },
    });

    await h.coordinator.requestGraceful('SIGTERM');

    assert.deepEqual(h.exits, [1]);
    assert.equal(calls, 2, 'the fatal path tries the cleanup again');
    assert.equal(h.events.includes('closeServer'), false);
});

test('a graceful shutdown that cannot close the listener exits 1', async () => {
    const h = createHarness({
        notifyRoomsEnded: () => false,
        closeServer: () => { throw new Error('close failed'); },
    });

    await h.coordinator.requestGraceful('SIGTERM');

    assert.deepEqual(h.exits, [1]);
});

test('a fatal error while running tells rooms, waits for the flush, cleans up and exits 1', async () => {
    const h = createHarness();
    const done = h.coordinator.requestFatal('uncaught-exception');

    assert.equal(h.coordinator.getPhase(), 'fatal');
    assert.deepEqual(h.events, ['timer:4000', 'start', 'notify:fatal', 'timer:150']);
    h.fireTimer(150);
    await done;

    assert.deepEqual(h.events, ['timer:4000', 'start', 'notify:fatal', 'timer:150', 'cleanup', 'exit:1']);
    assert.ok(h.logged.some((entry) => entry[0] === 'error' && /external supervisor must restart Nextra/.test(entry[1])));
});

test('a fatal error with no socket server exits 1 at once', async () => {
    const h = createHarness({ notifyRoomsEnded: () => false });
    await h.coordinator.requestFatal('unhandled-rejection');

    assert.deepEqual(h.events, ['timer:4000', 'start', 'notify:fatal', 'cleanup', 'exit:1']);
});

test('the fatal force-exit timer ends the process with 1 if the flush never finishes', () => {
    const h = createHarness();
    h.coordinator.requestFatal('uncaught-exception');
    assert.equal(h.events[0], 'timer:4000');

    h.fireTimer(4000);
    assert.deepEqual(h.exits, [1]);
});

test('a fatal error exits 1 even when the room notice and the cleanup both throw', async () => {
    const h = createHarness({
        notifyRoomsEnded: () => { throw new Error('emit failed'); },
        cleanup: () => { throw new Error('cleanup failed'); },
    });

    await h.coordinator.requestFatal('uncaught-exception');

    assert.deepEqual(h.exits, [1]);
});

test('later requests while a stop is in progress do not exit twice or start another stop', async () => {
    const h = createHarness({ notifyRoomsEnded: () => false });
    await h.coordinator.requestFatal('uncaught-exception');
    await h.coordinator.requestFatal('unhandled-rejection');
    await h.coordinator.requestGraceful('SIGTERM');

    assert.deepEqual(h.exits, [1]);
    assert.equal(h.events.filter((event) => event === 'cleanup').length, 1);

    const g = createHarness({ notifyRoomsEnded: () => false });
    await g.coordinator.requestGraceful('SIGINT');
    await g.coordinator.requestGraceful('SIGTERM');
    assert.equal(g.events.filter((event) => event === 'timer:5000').length, 1);
    assert.equal(g.events.filter((event) => event === 'closeServer').length, 1);
});

test('a coordinator needs its side effects', () => {
    assert.throws(() => createShutdownCoordinator({ closeServer() {}, exit() {} }), /cleanup/);
    assert.throws(() => createShutdownCoordinator({ cleanup() {}, exit() {} }), /closeServer/);
    assert.throws(() => createShutdownCoordinator({ cleanup() {}, closeServer() {} }), /exit/);
});
