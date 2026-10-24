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
        restartForceExitMs: 3000,
        restartCloseWaitMs: 2000,
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

// A replacement launcher that records what the coordinator asks of it, in the
// harness's event order.
function createFakeLauncher(events) {
    const launcher = {
        launches: [],
        forwarded: [],
        stopped: 0,
        launch(handlers) {
            events.push('launch');
            launcher.launches.push(handlers);
            return {
                forwardSignal: (signal) => { launcher.forwarded.push(signal); },
                stop: () => { launcher.stopped += 1; },
            };
        },
    };
    return launcher;
}

// Lets the awaits in the coordinator run without firing any timer.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Runs a restart up to the point where it waits for the listener to close.
async function startRestart(h, launcher, options = {}) {
    const done = h.coordinator.requestRestart('media-worker-died', {
        launchReplacement: launcher.launch,
        ...options,
    });
    if (h.timers.some((timer) => timer.ms === 150)) {
        h.fireTimer(150);
        await settle();
    }
    return done;
}

test('a restart tells rooms, cleans up and closes the listener before it starts the replacement', async () => {
    const h = createHarness();
    const launcher = createFakeLauncher(h.events);
    const done = h.coordinator.requestRestart('media-worker-died', { launchReplacement: launcher.launch });

    assert.equal(h.coordinator.getPhase(), 'restart');
    assert.equal(h.coordinator.isShuttingDown(), true);
    assert.deepEqual(h.events, ['timer:3000', 'start', 'notify:restart', 'timer:150']);

    h.fireTimer(150);
    await settle();
    assert.deepEqual(h.events, ['timer:3000', 'start', 'notify:restart', 'timer:150', 'cleanup', 'timer:2000', 'closeServer']);
    assert.equal(launcher.launches.length, 0, 'the port is released before the replacement can bind');

    h.closeServerCallback()();
    await done;
    assert.equal(h.events.at(-1), 'launch');
    assert.equal(launcher.launches.length, 1);
    assert.deepEqual(h.exits, [], 'this process waits for the replacement');
});

test('a restart tells rooms through the notice the caller supplies', async () => {
    const h = createHarness();
    const launcher = createFakeLauncher(h.events);
    const done = startRestart(h, launcher, { notifyRooms: () => { h.events.push('custom-notice'); return false; } });
    await settle();
    h.closeServerCallback()();
    await done;

    assert.equal(h.events.includes('notify:restart'), false);
    assert.equal(h.events.indexOf('custom-notice') < h.events.indexOf('cleanup'), true);
    assert.equal(h.events.includes('timer:150'), false, 'nothing was sent, so there is no flush to wait for');
    assert.equal(launcher.launches.length, 1);
});

test('a restart does not wait longer than the close wait for a listener that will not close', async () => {
    const h = createHarness({ notifyRoomsEnded: () => false });
    const launcher = createFakeLauncher(h.events);
    const done = startRestart(h, launcher);
    await settle();
    assert.equal(launcher.launches.length, 0);

    h.fireTimer(2000);
    await done;
    assert.equal(launcher.launches.length, 1);

    // The listener closing later changes nothing.
    h.closeServerCallback()();
    assert.equal(launcher.launches.length, 1);
    assert.deepEqual(h.exits, []);
});

test('the process exits with the exit code of the replacement', async () => {
    for (const code of [0, 7]) {
        const h = createHarness({ notifyRoomsEnded: () => false });
        const launcher = createFakeLauncher(h.events);
        const done = startRestart(h, launcher);
        await settle();
        h.closeServerCallback()();
        await done;

        launcher.launches[0].onExit(code);
        launcher.launches[0].onExit(code);
        assert.deepEqual(h.exits, [code]);
    }
});

test('a replacement that cannot be started ends the process with 1', async () => {
    const h = createHarness({ notifyRoomsEnded: () => false });
    const launcher = createFakeLauncher(h.events);
    const done = startRestart(h, launcher);
    await settle();
    h.closeServerCallback()();
    await done;

    launcher.launches[0].onFailed(new Error('spawn failed'));
    assert.deepEqual(h.exits, [1]);
});

test('a stop signal while the replacement runs is passed on to it and does not end this process', async () => {
    const h = createHarness({ notifyRoomsEnded: () => false });
    const launcher = createFakeLauncher(h.events);
    const done = startRestart(h, launcher);
    await settle();
    h.closeServerCallback()();
    await done;

    await h.coordinator.requestGraceful('SIGTERM');
    await h.coordinator.requestGraceful('SIGINT');

    assert.deepEqual(launcher.forwarded, ['SIGTERM', 'SIGINT']);
    assert.equal(h.coordinator.getPhase(), 'restart');
    assert.deepEqual(h.exits, []);
    assert.equal(h.events.includes('timer:5000'), false, 'no graceful shutdown of its own starts');

    // The replacement ends after the stop; this process follows with its code.
    launcher.launches[0].onExit(0);
    assert.deepEqual(h.exits, [0]);
});

test('a stop signal before the replacement starts means no replacement is started', async () => {
    const h = createHarness();
    const launcher = createFakeLauncher(h.events);
    const done = h.coordinator.requestRestart('media-worker-died', { launchReplacement: launcher.launch });

    await h.coordinator.requestGraceful('SIGINT');
    assert.deepEqual(h.exits, []);

    h.fireTimer(150);
    await settle();
    h.closeServerCallback()();
    await done;

    assert.equal(launcher.launches.length, 0);
    assert.deepEqual(h.exits, [0]);
    assert.ok(h.logged.some((entry) => entry[0] === 'log' && /SIGINT received during the restart/.test(entry[1])));
});

test('the restart force-exit timer ends the process with 1 if the replacement was never started', () => {
    const h = createHarness();
    const launcher = createFakeLauncher(h.events);
    h.coordinator.requestRestart('media-worker-died', { launchReplacement: launcher.launch });
    assert.equal(h.events[0], 'timer:3000');

    h.fireTimer(3000);
    assert.deepEqual(h.exits, [1]);
});

test('the restart force-exit timer does nothing once the replacement runs', async () => {
    const h = createHarness({ notifyRoomsEnded: () => false });
    const launcher = createFakeLauncher(h.events);
    const done = startRestart(h, launcher);
    await settle();
    h.closeServerCallback()();
    await done;

    h.fireTimer(3000);
    assert.deepEqual(h.exits, []);
});

test('a fatal error while a restart flushes rooms exits 1 and starts no replacement', async () => {
    const h = createHarness();
    const launcher = createFakeLauncher(h.events);
    const restart = h.coordinator.requestRestart('media-worker-died', { launchReplacement: launcher.launch });

    await h.coordinator.requestFatal('uncaught-exception');
    assert.deepEqual(h.exits, [1]);
    assert.equal(h.events.includes('notify:fatal'), false, 'rooms were told already');

    h.fireTimer(150);
    await restart;
    assert.equal(launcher.launches.length, 0);
    assert.deepEqual(h.exits, [1]);
});

test('a fatal error while the replacement runs stops it and exits 1', async () => {
    const h = createHarness({ notifyRoomsEnded: () => false });
    const launcher = createFakeLauncher(h.events);
    const done = startRestart(h, launcher);
    await settle();
    h.closeServerCallback()();
    await done;

    await h.coordinator.requestFatal('uncaught-exception');
    assert.equal(launcher.stopped, 1, 'no unattended second instance is left behind');
    assert.deepEqual(h.exits, [1]);

    // The replacement ending because it was stopped does not exit a second time.
    launcher.launches[0].onExit(0);
    assert.deepEqual(h.exits, [1]);
});

test('a restart whose cleanup or listener close throws is handled as a fatal error and exits 1', async () => {
    const cleanupFails = createHarness({
        notifyRoomsEnded: () => false,
        cleanup: () => { throw new Error('cleanup failed'); },
    });
    const launcherA = createFakeLauncher(cleanupFails.events);
    await cleanupFails.coordinator.requestRestart('media-worker-died', { launchReplacement: launcherA.launch });
    assert.deepEqual(cleanupFails.exits, [1]);
    assert.equal(launcherA.launches.length, 0);
    assert.ok(cleanupFails.logged.some((entry) => entry[0] === 'error' && /Restart after media-worker-died failed/.test(entry[1])));

    const closeFails = createHarness({
        notifyRoomsEnded: () => false,
        closeServer: () => { throw new Error('close failed'); },
    });
    const launcherB = createFakeLauncher(closeFails.events);
    await closeFails.coordinator.requestRestart('media-worker-died', { launchReplacement: launcherB.launch });
    assert.deepEqual(closeFails.exits, [1]);
    assert.equal(launcherB.launches.length, 0);
});

test('a restart needs a launcher and does nothing while another stop is in progress', async () => {
    const h = createHarness({ notifyRoomsEnded: () => false });
    await assert.rejects(h.coordinator.requestRestart('media-worker-died'), /launchReplacement/);
    assert.equal(h.coordinator.getPhase(), 'running');

    const launcher = createFakeLauncher(h.events);
    await h.coordinator.requestFatal('uncaught-exception');
    await h.coordinator.requestRestart('media-worker-died', { launchReplacement: launcher.launch });
    assert.equal(launcher.launches.length, 0);
    assert.deepEqual(h.exits, [1]);

    const g = createHarness({ notifyRoomsEnded: () => false });
    const graceLauncher = createFakeLauncher(g.events);
    await g.coordinator.requestGraceful('SIGTERM');
    await g.coordinator.requestRestart('media-worker-died', { launchReplacement: graceLauncher.launch });
    assert.equal(graceLauncher.launches.length, 0);
    assert.equal(g.coordinator.getPhase(), 'graceful');
});

test('a fatal error tells rooms through the notice the caller supplies', async () => {
    const h = createHarness();
    const done = h.coordinator.requestFatal('media-worker-died', { notifyRooms: () => { h.events.push('custom-notice'); return true; } });
    h.fireTimer(150);
    await done;

    assert.equal(h.events.includes('notify:fatal'), false);
    assert.deepEqual(h.events, ['timer:4000', 'start', 'custom-notice', 'timer:150', 'cleanup', 'exit:1']);
});

test('a coordinator needs its side effects', () => {
    assert.throws(() => createShutdownCoordinator({ closeServer() {}, exit() {} }), /cleanup/);
    assert.throws(() => createShutdownCoordinator({ cleanup() {}, exit() {} }), /closeServer/);
    assert.throws(() => createShutdownCoordinator({ cleanup() {}, closeServer() {} }), /exit/);
});
