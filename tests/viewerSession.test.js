'use strict';

// Deterministic tests of src/lib/viewerSession.mjs: the session a room join of
// WatchView belongs to, and what a join does when its session has ended (Leave
// Room pressed while a reconnect is rejoining, ...). Every async step is a
// promise the test settles by hand; no timers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const loadModule = () => import('../src/lib/viewerSession.mjs');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

// The shape of WatchView.joinRoomAndLoadDevice: awaits, each followed by a
// session check, then a synchronous commit. `steps` are the promises it awaits;
// `commits` is what a completed join writes.
async function runJoin(module, session, { steps, commits, leaveRoom }) {
    const { abandonStaleJoin } = module;
    let mayBeInRoom = true;
    try {
        try {
            await steps.joinRoom.promise;
        } catch (err) {
            if (err.phase === 'server' || err.phase === 'connect') mayBeInRoom = false;
            throw err;
        }
        session.assertCurrent();
        await steps.capabilities.promise;
        session.assertCurrent();
        commits.push('joined');
    } catch (err) {
        if (session.isCurrent()) throw err;
        throw abandonStaleJoin(session, { mayBeInRoom, leaveRoom });
    }
}

function joinSteps() {
    return { joinRoom: deferred(), capabilities: deferred() };
}

test('a session is current until something ends it or a newer one begins', async () => {
    const { createViewerSession, isStaleViewerSessionError } = await loadModule();
    const viewer = createViewerSession();
    assert.equal(viewer.active, false, 'nothing has begun yet');

    const first = viewer.begin();
    assert.equal(first.isCurrent(), true);
    assert.equal(viewer.active, true);
    first.assertCurrent();

    const second = viewer.begin();
    assert.equal(first.isCurrent(), false, 'a newer join makes the older stale');
    assert.equal(second.isCurrent(), true);
    assert.throws(() => first.assertCurrent(), (err) => isStaleViewerSessionError(err));
    second.assertCurrent();

    // handleLeave, the room-ended and transport-failed resets do this.
    viewer.invalidate();
    assert.equal(second.isCurrent(), false);
    assert.equal(viewer.active, false, 'an ended session is not one to rejoin');
    assert.throws(() => second.assertCurrent(), (err) => isStaleViewerSessionError(err));

    const third = viewer.begin();
    assert.equal(third.isCurrent(), true);
    assert.equal(viewer.active, true);
});

test('a join completion whose session is behind the current one is rejected, and commits nothing', async () => {
    const module = await loadModule();
    const { createViewerSession, isStaleViewerSessionError } = module;
    const viewer = createViewerSession();
    const session = viewer.begin();
    const steps = joinSteps();
    const commits = [];
    const leaves = [];
    const join = runJoin(module, session, { steps, commits, leaveRoom: () => leaves.push('leave-room') });

    // Leave Room is pressed while the rejoin waits for the server.
    viewer.invalidate();
    steps.joinRoom.resolve();
    await assert.rejects(join, (err) => isStaleViewerSessionError(err));
    assert.deepEqual(commits, [], 'a stale join restores no joined state');
    assert.deepEqual(leaves, ['leave-room'], 'it asks the server to drop the viewer it put back');
});

test('a join that finishes while its session is current commits and sends no leave', async () => {
    const module = await loadModule();
    const viewer = module.createViewerSession();
    const session = viewer.begin();
    const steps = joinSteps();
    const commits = [];
    const leaves = [];
    const join = runJoin(module, session, { steps, commits, leaveRoom: () => leaves.push('leave-room') });
    steps.joinRoom.resolve();
    steps.capabilities.resolve();
    await join;
    assert.deepEqual(commits, ['joined']);
    assert.deepEqual(leaves, []);
});

test('every await of a join is followed by a check: the session can end at any of them', async () => {
    const module = await loadModule();
    const { createViewerSession, isStaleViewerSessionError } = module;
    const viewer = createViewerSession();
    const session = viewer.begin();
    const steps = joinSteps();
    const commits = [];
    const leaves = [];
    const join = runJoin(module, session, { steps, commits, leaveRoom: () => leaves.push('leave-room') });

    steps.joinRoom.resolve();
    await Promise.resolve();
    viewer.invalidate();
    steps.capabilities.resolve();
    await assert.rejects(join, (err) => isStaleViewerSessionError(err));
    assert.deepEqual(commits, []);
    assert.deepEqual(leaves, ['leave-room']);
});

test('the compensating leave is sent only when no newer join has begun since the session ended', async () => {
    const module = await loadModule();
    const { createViewerSession, isStaleViewerSessionError } = module;
    const viewer = createViewerSession();
    const old = viewer.begin();
    const steps = joinSteps();
    const leaves = [];
    const join = runJoin(module, old, { steps, commits: [], leaveRoom: () => leaves.push('leave-room') });

    // Leave Room, then a new Join before the old rejoin's answer arrives: the
    // server keeps one room per socket, so a leave now would remove the new join.
    viewer.invalidate();
    const newer = viewer.begin();
    assert.equal(old.hasNewerJoin(), true);
    assert.equal(old.mayUndoJoin(), false);

    steps.joinRoom.resolve();
    await assert.rejects(join, (err) => isStaleViewerSessionError(err));
    assert.deepEqual(leaves, [], 'the newer join is left alone');
    assert.equal(newer.isCurrent(), true);
});

test('a join the server refused, or that never left, has nothing to undo', async () => {
    const module = await loadModule();
    const { createViewerSession, isStaleViewerSessionError } = module;

    for (const phase of ['server', 'connect']) {
        const viewer = createViewerSession();
        const session = viewer.begin();
        const steps = joinSteps();
        const leaves = [];
        const join = runJoin(module, session, { steps, commits: [], leaveRoom: () => leaves.push('leave-room') });
        viewer.invalidate();
        steps.joinRoom.reject(Object.assign(new Error('Room not found.'), { phase }));
        await assert.rejects(join, (err) => isStaleViewerSessionError(err), 'a stale join reports only that');
        assert.deepEqual(leaves, [], `${phase}: no viewer was put in the room`);
    }

    // An answer that never came may still have put the viewer in the room.
    const viewer = createViewerSession();
    const session = viewer.begin();
    const steps = joinSteps();
    const leaves = [];
    const join = runJoin(module, session, { steps, commits: [], leaveRoom: () => leaves.push('leave-room') });
    viewer.invalidate();
    steps.joinRoom.reject(Object.assign(new Error('timed out'), { phase: 'ack-timeout' }));
    await assert.rejects(join, (err) => isStaleViewerSessionError(err));
    assert.deepEqual(leaves, ['leave-room']);
});

test('a join that fails while its session is current reports its own error', async () => {
    const module = await loadModule();
    const viewer = module.createViewerSession();
    const session = viewer.begin();
    const steps = joinSteps();
    const leaves = [];
    const join = runJoin(module, session, { steps, commits: [], leaveRoom: () => leaves.push('leave-room') });
    const failure = Object.assign(new Error('Room passphrase required or incorrect.'), { phase: 'server' });
    steps.joinRoom.reject(failure);
    await assert.rejects(join, (err) => err === failure);
    assert.deepEqual(leaves, []);
});

test('a view that unmounted sends no leave: the socket may belong to another view now', async () => {
    const module = await loadModule();
    const { createViewerSession, isStaleViewerSessionError } = module;
    const viewer = createViewerSession();
    const session = viewer.begin();
    const steps = joinSteps();
    const leaves = [];
    const join = runJoin(module, session, { steps, commits: [], leaveRoom: () => leaves.push('leave-room') });

    viewer.close();
    steps.joinRoom.resolve();
    await assert.rejects(join, (err) => isStaleViewerSessionError(err));
    assert.deepEqual(leaves, []);
    assert.equal(session.mayUndoJoin(), false);

    // A view that mounts again (StrictMode runs the unmount cleanup once) can join.
    const again = viewer.begin();
    assert.equal(again.isCurrent(), true);
    viewer.invalidate();
    assert.equal(again.mayUndoJoin(), true, 'closing ended with the next begin');
});

test('a leave that throws because the socket went away does not hide the stale join', async () => {
    const { createViewerSession, abandonStaleJoin, isStaleViewerSessionError } = await loadModule();
    const viewer = createViewerSession();
    const session = viewer.begin();
    viewer.invalidate();
    const error = abandonStaleJoin(session, {
        mayBeInRoom: true,
        leaveRoom: () => { throw new Error('socket closed'); },
    });
    assert.equal(isStaleViewerSessionError(error), true);
});

test('WatchView ends the session before Leave Room waits for the server, and commits a join only after a check', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'WatchView.jsx'), 'utf8');
    const bodyOf = (start, end) => {
        const from = source.indexOf(start);
        assert.ok(from > 0, `${start} is defined`);
        const to = source.indexOf(end, from);
        assert.ok(to > from, `${end} follows ${start}`);
        return source.slice(from, to);
    };

    // handleLeave: the session ends synchronously, before the first await.
    const leave = bodyOf('const handleLeave = useCallback(async () => {', '}, [cleanupPlayback, recoveryGuard');
    assert.ok(leave.indexOf('viewerSession.invalidate()') > 0, 'handleLeave ends the session');
    assert.ok(leave.indexOf('viewerSession.invalidate()') < leave.indexOf('await '), 'before it awaits anything');

    // The only setJoined(true) is in joinRoomAndLoadDevice, after a check with no await between.
    assert.equal((source.match(/setJoined\(true\)/g) ?? []).length, 1);
    const join = bodyOf('const joinRoomAndLoadDevice = useCallback(', '}, [socket, passphrase]);');
    const commit = join.indexOf('setJoined(true)');
    const lastCheck = join.lastIndexOf('session.assertCurrent()', commit);
    assert.ok(lastCheck > 0 && lastCheck < commit, 'a session check comes before the commit');
    assert.doesNotMatch(join.slice(lastCheck, commit), /\bawait\b/, 'nothing awaits between the check and the commit');
    for (const awaited of ["await socketRequest(socket, 'get-rtp-capabilities')", 'await getDevice()', 'await device.load(']) {
        const at = join.indexOf(awaited);
        assert.ok(at > 0, `${awaited} is in the join`);
        assert.match(join.slice(at, at + 220), /session\.assertCurrent\(\)/, `${awaited} is followed by a check`);
    }

    // The other joins and resets end or follow the session.
    assert.match(source, /const session = viewerSession\.begin\(\);\s+try \{\s+await joinRoomAndLoadDevice\(code, session\)/);
    assert.match(source, /await joinRoomAndLoadDevice\(roomCode, session\)/);
    assert.equal((source.match(/viewerSession\.invalidate\(\)/g) ?? []).length, 5,
        'Leave Room, room-ended, the terminal transport-failed branch, and the failed handleJoin and rejoin');
    assert.match(source, /viewerSession\.close\(\);/, 'unmounting');
    assert.match(source, /if \(!viewerSession\.active\) return;/, 'a reconnect rejoins only a session that has not ended');
});

// ── The relay fallback start (fallback-consume-start) of a viewer session ──
//
// WatchView.enterFallbackMode sends the start through beginFallbackStart
// (fallbackStart.mjs: emitClaimedStart on top of emitWithTimedAck), keeps the
// claim in fallbackClaimRef, and asks the viewer session whether the answer is
// still wanted. The model below makes the same calls as enterFallbackMode,
// exitFallbackMode and the resets that drop the claim (Leave Room, a room that
// ended, a reconnect), against a fake socket whose answers the test delivers.

class FakeSocket {
    constructor(id = 'socket-1') {
        this.id = id;
        this.connected = true;
        this.emitted = [];
        this.pendingAcks = [];
        this.listeners = new Map();
    }

    on(event, listener) {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event).add(listener);
    }

    off(event, listener) {
        this.listeners.get(event)?.delete(listener);
    }

    emit(event, payload, ack) {
        this.emitted.push({ event, socketId: this.id, connected: this.connected });
        if (typeof ack === 'function') this.pendingAcks.push({ event, ack });
    }

    takeAck(event) {
        const index = this.pendingAcks.findIndex((pending) => pending.event === event);
        assert.notEqual(index, -1, `no pending ack for ${event}`);
        return this.pendingAcks.splice(index, 1)[0].ack;
    }

    drop(reason = 'transport close') {
        this.connected = false;
        this.id = undefined;
        this.pendingAcks = [];
        for (const listener of [...(this.listeners.get('disconnect') ?? [])]) listener(reason);
    }

    reconnect(id) {
        this.id = id;
        this.connected = true;
    }

    count(event) {
        return this.emitted.filter((entry) => entry.event === event).length;
    }
}

async function drainMicrotasks() {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

async function createFallbackViewer(socket) {
    const { createViewerSession } = await loadModule();
    const { createSubscriptionLedger, releaseSubscription } = await import('../src/lib/subscriptionLedger.mjs');
    const { beginFallbackStart } = await import('../src/lib/fallbackStart.mjs');
    const { isSocketNotConnectedError } = await import('../src/lib/timedAck.mjs');

    const ledger = createSubscriptionLedger();
    const viewerSession = createViewerSession();
    const refs = {
        claim: null,
        entering: false,
        joined: true,
        roomCode: 'ABC123',
        terminalRoomEnded: false,
        player: null,
        rejected: false,
        resume: false,
    };
    const ui = { fallbackMode: false, fallbackState: null, error: '' };
    const log = [];
    viewerSession.begin();

    // The resets that drop the claim without a stop: the server dropped the viewer's
    // subscription itself (leave-room, a room that ended, a connection that closed).
    const dropFallbackClaim = () => {
        const claim = refs.claim;
        refs.claim = null;
        refs.entering = false;
        if (claim) ledger.release('fallback', claim);
    };

    // enterFallbackMode, up to the player.
    const enter = () => {
        if (refs.player || refs.entering) return null;
        const roomCode = refs.roomCode;
        const session = viewerSession.current();
        if (!refs.joined || !roomCode || !session || refs.terminalRoomEnded) return null;

        let start;
        try {
            start = beginFallbackStart({
                ledger,
                socket,
                token: session.generation,
                isCurrent: (claim) => refs.claim === claim && session.isCurrent() && refs.joined
                    && refs.roomCode === roomCode && !refs.terminalRoomEnded,
            });
        } catch (err) {
            if (!isSocketNotConnectedError(err)) throw err;
            refs.resume = true;
            ui.error = 'Connection interrupted. Reconnecting...';
            return { notConnected: true };
        }
        const { claim } = start;
        refs.claim = claim;
        refs.entering = true;
        ui.error = '';
        ui.fallbackMode = true;
        ui.fallbackState = 'connecting';

        const done = (async () => {
            let owned = false;
            try {
                const result = await start.settled;
                const settle = () => {
                    owned = refs.claim === claim;
                    if (owned) {
                        refs.claim = null;
                        refs.entering = false;
                    }
                    return owned;
                };
                log.push(result.status);
                if (result.status === 'started') {
                    if (refs.claim !== claim) return result;
                    owned = true;
                    refs.rejected = false;
                    refs.player = { roomCode };
                    return result;
                }
                if (result.status === 'stale') { settle(); return result; }
                if (!settle()) return result;
                ui.fallbackMode = false;
                ui.fallbackState = null;
                if (result.status === 'rejected') {
                    refs.rejected = true;
                    ui.error = result.error;
                } else if (result.status === 'timeout') {
                    refs.rejected = true;
                    ui.error = 'Relay mode did not respond in time. Try again in a moment.';
                } else {
                    refs.resume = true;
                    ui.error = 'Connection interrupted. Reconnecting...';
                }
                return result;
            } finally {
                if (owned || refs.claim === claim) refs.entering = false;
            }
        })();
        return { claim, done };
    };

    // exitFallbackMode.
    const exit = () => {
        refs.player = null;
        const claim = refs.claim;
        refs.claim = null;
        refs.entering = false;
        refs.resume = false;
        releaseSubscription(ledger, 'fallback', claim, socket, 'fallback-consume-stop');
        ui.fallbackMode = false;
        ui.fallbackState = null;
    };

    // handleLeave: the session ends before anything is awaited; the server drops the viewer.
    const leave = () => {
        viewerSession.invalidate();
        dropFallbackClaim();
        refs.resume = false;
        refs.player = null;
        refs.joined = false;
        refs.roomCode = '';
        ui.fallbackMode = false;
        ui.fallbackState = null;
    };

    // A join on the same connection (the Join button again).
    const join = (roomCode = 'ABC123') => {
        viewerSession.begin();
        refs.joined = true;
        refs.roomCode = roomCode;
    };

    return { ledger, viewerSession, refs, ui, log, enter, exit, leave, join, dropFallbackClaim };
}

test('the session in progress can be asked for without beginning one', async () => {
    const { createViewerSession } = await loadModule();
    const viewer = createViewerSession();
    assert.equal(viewer.current(), null, 'no session has begun');

    const first = viewer.begin();
    const current = viewer.current();
    assert.equal(current.generation, first.generation);
    assert.equal(current.isCurrent(), true);
    assert.equal(viewer.active, true, 'asking did not begin another session');

    viewer.invalidate();
    assert.equal(viewer.current(), null, 'an ended session is not one to run work in');
    assert.equal(current.isCurrent(), false, 'and a token taken before is stale now');

    const second = viewer.begin();
    assert.equal(viewer.current().generation, second.generation);
    viewer.close();
    assert.equal(viewer.current(), null);
});

test('a { ok: true, fallbackAvailable: true } answer reaches the success path and keeps the claim', async () => {
    const socket = new FakeSocket();
    const viewer = await createFallbackViewer(socket);

    const entry = viewer.enter();
    assert.equal(viewer.ui.fallbackState, 'connecting');
    assert.equal(viewer.refs.entering, true);
    assert.deepEqual(socket.emitted.map((e) => e.event), ['fallback-consume-start']);
    assert.equal(viewer.ledger.latest('fallback'), entry.claim, 'claimed in the block that emitted');

    socket.takeAck('fallback-consume-start')({ ok: true, fallbackAvailable: true });
    const result = await entry.done;

    assert.equal(result.status, 'started');
    assert.deepEqual(result.response, { ok: true, fallbackAvailable: true });
    assert.deepEqual(viewer.refs.player, { roomCode: 'ABC123' }, 'the player is created for the joined room');
    assert.equal(viewer.refs.entering, false);
    assert.equal(viewer.ui.fallbackMode, true);
    assert.equal(viewer.refs.claim, entry.claim, 'exitFallbackMode will release this claim');
    assert.equal(socket.count('fallback-consume-stop'), 0);
});

test('the answer is classified as it was: only an error refuses, any other answer starts', async () => {
    for (const [response, status] of [
        [{ ok: true }, 'started'],
        [{ ok: true, fallbackAvailable: false }, 'started'],
        [undefined, 'started'],
        [{ ok: false, error: 'Relay mode is unavailable for AV1 rooms.' }, 'rejected'],
        [{ error: 'Not an OBS room' }, 'rejected'],
    ]) {
        const socket = new FakeSocket();
        const viewer = await createFallbackViewer(socket);
        const entry = viewer.enter();
        socket.takeAck('fallback-consume-start')(response);
        const result = await entry.done;
        assert.equal(result.status, status, JSON.stringify(response));
        if (status === 'rejected') {
            assert.equal(viewer.refs.rejected, true, 'latched, so the auto-enter effect does not spin');
            assert.equal(viewer.ui.error, response.error);
            assert.equal(viewer.ui.fallbackMode, false);
            assert.equal(viewer.ledger.latest('fallback'), null, 'the claim is released');
            assert.equal(socket.count('fallback-consume-stop'), 0, 'the server subscribed nobody');
            assert.equal(viewer.refs.entering, false);
        }
    }
});

test("a stale answer delivered after a newer start was emitted and acknowledged sends no fallback-consume-stop", async () => {
    const socket = new FakeSocket();
    const viewer = await createFallbackViewer(socket);

    // A asks, and its answer is slow.
    const a = viewer.enter();
    const ackA = socket.takeAck('fallback-consume-start');

    // The viewer leaves and joins again on the same connection: the server dropped A's
    // subscription with leave-room. B asks and is acknowledged.
    viewer.leave();
    viewer.join();
    const b = viewer.enter();
    assert.notEqual(b.claim, a.claim);
    socket.takeAck('fallback-consume-start')({ ok: true, fallbackAvailable: true });
    assert.equal((await b.done).status, 'started');

    // Only now does A's answer come.
    ackA({ ok: true, fallbackAvailable: true });
    const staleResult = await a.done;

    assert.equal(staleResult.status, 'stale');
    assert.equal(socket.count('fallback-consume-stop'), 0, 'B owns the socket-wide subscription');
    assert.equal(socket.count('fallback-consume-start'), 2);
    assert.equal(viewer.ledger.latest('fallback'), b.claim, "B's claim is still the latest");
    assert.equal(viewer.refs.claim, b.claim);
    assert.deepEqual(viewer.refs.player, { roomCode: 'ABC123' }, "B's player is untouched");
    assert.equal(viewer.refs.entering, false);
    assert.equal(viewer.ui.fallbackMode, true);
});

test('a stale answer with no newer start sends exactly one stop, on the same connection', async () => {
    const socket = new FakeSocket();
    const viewer = await createFallbackViewer(socket);

    const a = viewer.enter();
    const ackA = socket.takeAck('fallback-consume-start');

    // The session ended without the claim being dropped (here: the room ended).
    viewer.refs.terminalRoomEnded = true;
    ackA({ ok: true, fallbackAvailable: true });
    const result = await a.done;

    assert.equal(result.status, 'stale');
    assert.deepEqual(socket.emitted.map((e) => e.event), ['fallback-consume-start', 'fallback-consume-stop']);
    assert.equal(socket.emitted[1].socketId, 'socket-1');
    assert.equal(viewer.ledger.latest('fallback'), null);
    assert.equal(viewer.refs.player, null, 'no player for an ended room');
    assert.equal(viewer.refs.entering, false);

    // Nothing is left to stop afterwards.
    viewer.exit();
    assert.equal(socket.count('fallback-consume-stop'), 1);
});

test('a late answer after Leave Room starts no player and sends no stop', async () => {
    const socket = new FakeSocket();
    const viewer = await createFallbackViewer(socket);
    const a = viewer.enter();
    const ackA = socket.takeAck('fallback-consume-start');

    viewer.leave();
    assert.equal(viewer.refs.entering, false, 'leaving clears the entering flag');

    ackA({ ok: true, fallbackAvailable: true });
    assert.equal((await a.done).status, 'stale');
    assert.equal(viewer.refs.player, null);
    assert.equal(viewer.ui.fallbackMode, false);
    assert.equal(socket.count('fallback-consume-stop'), 0, 'leave-room removed the subscription on the server');

    // A new join can enter the fallback again at once.
    viewer.join('XYZ789');
    const b = viewer.enter();
    assert.ok(b.claim);
    assert.equal(socket.count('fallback-consume-start'), 2);
});

test('a start that is given up on by exitFallbackMode is stopped once, and its late answer sends nothing more', async () => {
    const socket = new FakeSocket();
    const viewer = await createFallbackViewer(socket);
    const a = viewer.enter();
    const ackA = socket.takeAck('fallback-consume-start');

    viewer.exit();
    assert.deepEqual(socket.emitted.map((e) => e.event), ['fallback-consume-start', 'fallback-consume-stop'],
        'the stop is ordered after the start on this connection');

    ackA({ ok: true, fallbackAvailable: true });
    assert.equal((await a.done).status, 'stale');
    assert.equal(socket.count('fallback-consume-stop'), 1);
    assert.equal(viewer.refs.player, null);
    assert.equal(viewer.ui.fallbackMode, false);
});

test('exitFallbackMode stops only the latest claim, and only once', async () => {
    const socket = new FakeSocket();
    const viewer = await createFallbackViewer(socket);
    viewer.exit();
    assert.equal(socket.count('fallback-consume-stop'), 0, 'nothing was started, so nothing is stopped');

    const a = viewer.enter();
    socket.takeAck('fallback-consume-start')({ ok: true, fallbackAvailable: true });
    await a.done;
    viewer.exit();
    viewer.exit();
    assert.equal(socket.count('fallback-consume-stop'), 1);
});

test('a missing answer ends the connecting state after the timeout, stops the start once, and a later start is sent', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const socket = new FakeSocket();
    const viewer = await createFallbackViewer(socket);

    const a = viewer.enter();
    const ackA = socket.takeAck('fallback-consume-start');
    assert.equal(viewer.refs.entering, true);

    t.mock.timers.tick(10000);
    const result = await a.done;
    assert.equal(result.status, 'timeout');
    assert.equal(viewer.refs.entering, false, 'the flag no longer blocks the next start');
    assert.equal(viewer.ui.fallbackMode, false);
    assert.equal(viewer.ui.fallbackState, null);
    assert.match(viewer.ui.error, /did not respond/);
    assert.equal(viewer.refs.rejected, true, 'latched, so the auto-enter effect does not retry in a loop');
    assert.deepEqual(socket.emitted.map((e) => e.event), ['fallback-consume-start', 'fallback-consume-stop'],
        'the server may still have processed the start; a stop on this connection is ordered after it');

    // The answer that comes after all changes nothing.
    ackA({ ok: true, fallbackAvailable: true });
    await drainMicrotasks();
    assert.equal(viewer.refs.player, null);
    assert.equal(socket.count('fallback-consume-stop'), 1);

    // The Switch to Relay Mode control calls enterFallbackMode again.
    const b = viewer.enter();
    assert.ok(b.claim);
    assert.equal(socket.count('fallback-consume-start'), 2);
    socket.takeAck('fallback-consume-start')({ ok: true, fallbackAvailable: true });
    assert.equal((await b.done).status, 'started');
    assert.deepEqual(viewer.refs.player, { roomCode: 'ABC123' });
});

test('a timeout after a newer start sends no stop', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const socket = new FakeSocket();
    const viewer = await createFallbackViewer(socket);

    const a = viewer.enter();
    socket.takeAck('fallback-consume-start');
    viewer.leave();
    viewer.join();
    const b = viewer.enter();
    socket.takeAck('fallback-consume-start')({ ok: true, fallbackAvailable: true });
    await b.done;

    t.mock.timers.tick(10000);
    assert.equal((await a.done).status, 'timeout');
    assert.equal(socket.count('fallback-consume-stop'), 0, "A's timeout must not remove B's subscription");
    assert.equal(viewer.ledger.latest('fallback'), b.claim);
    assert.deepEqual(viewer.refs.player, { roomCode: 'ABC123' });
    assert.equal(viewer.ui.fallbackMode, true, "A's timeout leaves B's view alone");
});

test('a connection that drops before the answer sends no stop, clears the flag, and resumes on reconnect', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const socket = new FakeSocket('socket-1');
    const viewer = await createFallbackViewer(socket);

    const a = viewer.enter();
    socket.takeAck('fallback-consume-start');
    socket.drop();
    const result = await a.done;

    assert.equal(result.status, 'disconnected');
    assert.equal(viewer.refs.entering, false);
    assert.equal(viewer.ui.fallbackMode, false);
    assert.equal(viewer.refs.rejected, false, 'not latched: the reconnect can retry');
    assert.equal(viewer.refs.resume, true, 'the reconnect resumes the start the drop interrupted');
    assert.equal(viewer.ledger.latest('fallback'), null);
    assert.equal(socket.count('fallback-consume-stop'), 0, "the subscription belonged to the old socket.id");

    // While disconnected a new attempt neither emits nor claims, and does not toggle the view.
    const whileDown = viewer.enter();
    assert.deepEqual(whileDown, { notConnected: true });
    assert.equal(socket.count('fallback-consume-start'), 1, 'nothing is buffered into the next connection');
    assert.equal(viewer.ledger.latest('fallback'), null);
    assert.equal(viewer.ui.fallbackMode, false);
    assert.equal(viewer.refs.entering, false);

    // The reconnect: a start on the new connection.
    socket.reconnect('socket-2');
    viewer.refs.resume = false;
    const b = viewer.enter();
    assert.equal(viewer.ledger.latest('fallback').socketId, 'socket-2');
    socket.takeAck('fallback-consume-start')({ ok: true, fallbackAvailable: true });
    assert.equal((await b.done).status, 'started');
});

test('no stop goes out on a connection other than the one the start used', async () => {
    const socket = new FakeSocket('socket-1');
    const viewer = await createFallbackViewer(socket);

    const a = viewer.enter();
    const ackA = socket.takeAck('fallback-consume-start');
    viewer.refs.terminalRoomEnded = true;
    // socket.io-client has not reported the drop, but the connection is a new one.
    socket.reconnect('socket-2');
    ackA({ ok: true, fallbackAvailable: true });
    assert.equal((await a.done).status, 'stale');
    assert.equal(socket.count('fallback-consume-stop'), 0, 'a stop on socket-2 could remove a newer subscription');

    // Committed on socket-2, then the socket reports it is disconnected: exit emits nothing.
    viewer.refs.terminalRoomEnded = false;
    const b = viewer.enter();
    socket.takeAck('fallback-consume-start')({ ok: true, fallbackAvailable: true });
    await b.done;
    socket.connected = false;
    viewer.exit();
    assert.equal(socket.count('fallback-consume-stop'), 0, 'a buffered stop would be sent on the next connection');
});

test('no start is attempted for a viewer that is not joined, or whose room ended', async () => {
    const socket = new FakeSocket();
    const viewer = await createFallbackViewer(socket);

    viewer.refs.roomCode = '';
    assert.equal(viewer.enter(), null, 'a room code is required, and the code box is never used');
    viewer.refs.roomCode = 'ABC123';
    viewer.refs.terminalRoomEnded = true;
    assert.equal(viewer.enter(), null);
    viewer.refs.terminalRoomEnded = false;
    viewer.viewerSession.invalidate();
    assert.equal(viewer.enter(), null, 'no session in progress');
    assert.equal(socket.count('fallback-consume-start'), 0);
});

test('WatchView sends the fallback start through the ledger and ties every stop and flag reset to the viewer session', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'WatchView.jsx'), 'utf8');
    const bodyOf = (start, end) => {
        const from = source.indexOf(start);
        assert.ok(from > 0, `${start} is defined`);
        const to = source.indexOf(end, from);
        assert.ok(to > from, `${end} follows ${start}`);
        return source.slice(from, to);
    };

    const enter = bodyOf('const enterFallbackMode = useCallback(', 'Auto-enter fallback mode');
    assert.match(enter, /viewerSession\.current\(\)/, 'the session is captured at entry');
    assert.match(enter, /beginFallbackStart\(\{/);
    assert.match(enter, /ledger: subscriptionLedger/);
    assert.match(enter, /isCurrent: \(claim\) =>/);
    assert.match(enter, /session\.isCurrent\(\)/, 'the answer checks the session');
    assert.match(enter, /joinedRef\.current/, 'and that the viewer is joined');
    assert.match(enter, /terminalRoomEndedRef\.current/, 'and that the room has not ended');
    assert.match(enter, /finally \{/, 'the entering flag is cleared in a finally block');
    assert.doesNotMatch(enter, /codeInput/, 'the code box is not a room code');
    assert.doesNotMatch(enter, /socket\.emit\(/, 'the start and its compensation are the ledger\'s');
    assert.doesNotMatch(source, /socket\.emit\(\s*['"]fallback-consume-start['"]/);

    // Every stop goes through releaseSubscription (ledger.canRelease), from the module and exitFallbackMode.
    assert.doesNotMatch(source, /emit\(\s*['"]fallback-consume-stop['"]/, 'no direct stop in WatchView');
    const exit = bodyOf('const exitFallbackMode = useCallback(', 'const handleTryMediasoup');
    assert.match(exit, /releaseSubscription\(subscriptionLedger, 'fallback', claim, socket, 'fallback-consume-stop'\)/);
    const fallbackModule = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "fallbackStart.mjs"), "utf8");
    assert.doesNotMatch(fallbackModule, /emit\(\s*['"]fallback-consume-stop['"]/);
    assert.equal((fallbackModule.match(/releaseSubscription\(ledger, 'fallback', claim, socket, 'fallback-consume-stop'\)/g) ?? []).length, 2,
        'a stale answer and a timeout');

    // The entering flag and the claim are dropped by exit, leave, room end and reconnect.
    const leave = bodyOf('const handleLeave = useCallback(async () => {', '}, [cleanupPlayback, recoveryGuard');
    assert.match(leave, /dropFallbackClaim\(\)/);
    assert.ok(leave.indexOf('dropFallbackClaim()') < leave.indexOf('await '), 'before Leave Room waits for the server');
    assert.match(bodyOf('const onRoomEnded = ', 'const onHostDisconnected'), /dropFallbackClaim\(\)/);
    assert.match(bodyOf('const onReconnect = () => {', 'socket.on(\'connect\', onReconnect)'), /dropFallbackClaim\(\)/);
    assert.match(exit, /isEnteringFallbackRef\.current = false/);
});
