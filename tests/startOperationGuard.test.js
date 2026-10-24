'use strict';

// Deterministic tests of src/lib/startOperationGuard.mjs: every ack, capture
// and transport is a promise the test settles by hand; no timers or sleeps.

const test = require('node:test');
const assert = require('node:assert/strict');

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

function createTrack(label) {
    return {
        label,
        readyState: 'live',
        stop() { this.readyState = 'ended'; },
    };
}

function createStream(label) {
    const tracks = [createTrack(`${label}-video`), createTrack(`${label}-audio`)];
    return { tracks, getTracks: () => tracks };
}

function createClosable(label) {
    return {
        label,
        closed: false,
        close() { this.closed = true; },
    };
}

// The host socket and the server's view of it: one room per host socket.
// create-room commits the room only when the test releases it (a slow server),
// and replaces any room the socket already hosts; leave-room and host-stopped
// destroy it. Every emit lands in `log` in socket order.
function createHostSocket() {
    const log = [];
    const server = { room: null, destroyed: [] };
    const pendingCreates = [];
    const createRequested = [];
    let nextRoom = 1;

    const destroyRoom = () => {
        if (server.room) server.destroyed.push(server.room);
        server.room = null;
    };

    return {
        log,
        server,
        emit(event, owner) {
            log.push(`${owner}:${event}`);
            if (event === 'host-stopped') destroyRoom();
        },
        request(event, owner) {
            log.push(`${owner}:${event}`);
            if (event === 'leave-room') {
                destroyRoom();
                return Promise.resolve({ success: true });
            }
            const ack = deferred();
            const code = `ROOM${nextRoom}`;
            nextRoom += 1;
            pendingCreates.push({
                owner,
                code,
                commit() {
                    if (server.room) destroyRoom();
                    server.room = code;
                    log.push(`${owner}:ack ${code}`);
                    ack.resolve({ success: true, code, hostToken: `token-${code}` });
                },
                fail(message) {
                    log.push(`${owner}:ack failed`);
                    ack.reject(new Error(message));
                },
            });
            createRequested.shift()?.resolve();
            return ack.promise;
        },
        // Resolves when the next create-room is sent.
        whenCreateRequested() {
            const signal = deferred();
            createRequested.push(signal);
            return signal.promise;
        },
        pendingCreate(owner) {
            return pendingCreates.find((entry) => entry.owner === owner);
        },
    };
}

// The start flow as HostView runs it: capture, the ordered room step,
// transport, producers, then optional OBS configuration, with the stale exit
// after every await. Returns where the operation ended.
async function runStart({
    guard,
    socket,
    owner,
    createStartAttempt,
    capture = () => Promise.resolve(createStream(owner)),
    transport = () => Promise.resolve(createClosable(`${owner}-transport`)),
    produce = (kind) => Promise.resolve(createClosable(`${owner}-${kind}-producer`)),
    configureObs = null,
    resumed = false,
    state,
}) {
    const escalations = [];
    const attempt = createStartAttempt(guard, {
        emitHostStopped: () => socket.emit('host-stopped', owner),
        stopObsOutput: () => socket.emit('obs-stop', owner),
        escalate: (message) => escalations.push(message),
    });
    state.op = attempt.op;
    state.escalations = escalations;
    try {
        if (!configureObs) {
            state.stream = attempt.ownStream(await capture());
            if (attempt.abandonIfStale()) return 'stale after capture';
        }

        const roomStep = await attempt.requestRoom(resumed ? {} : {
            leave: () => socket.request('leave-room', owner),
            create: () => socket.request('create-room', owner),
        });
        if (roomStep.stale) return 'stale at room step';
        state.room = roomStep.room;

        if (!configureObs) {
            state.transport = attempt.own(await transport());
            if (attempt.abandonIfStale()) return 'stale after transport';
            state.videoProducer = attempt.own(await produce('video'));
            if (attempt.abandonIfStale()) return 'stale after video producer';
            state.audioProducer = attempt.own(await produce('audio'));
            if (attempt.abandonIfStale()) return 'stale after audio producer';
        } else {
            attempt.obsConfigureStarted();
            await configureObs();
            if (attempt.abandonIfStale()) return 'stale after OBS configure';
        }
        return 'sharing';
    } catch (err) {
        if (attempt.abandonIfStale()) return 'stale after failure';
        state.error = err.message;
        return 'failed';
    } finally {
        attempt.settleRoom();
    }
}

async function setup() {
    const { createStartOperationGuard, createStartAttempt, RELOAD_PRESERVE } = await loadGuard();
    return {
        guard: createStartOperationGuard(),
        socket: createHostSocket(),
        createStartAttempt,
        RELOAD_PRESERVE,
    };
}

test('a stopped start whose create-room ack arrives with no successor removes its room and releases its capture', async () => {
    const { guard, socket, createStartAttempt } = await setup();
    const a = {};
    const createSent = socket.whenCreateRequested();
    const done = runStart({ guard, socket, owner: 'A', createStartAttempt, state: a });
    await createSent;
    guard.roomSettled(a.op).then(() => socket.log.push('A:room settled'));

    // Teardown (Stop) while the server is still preparing the room: its own
    // host-stopped finds no room yet.
    guard.invalidate('stop');
    socket.emit('host-stopped', 'teardown');
    socket.pendingCreate('A').commit();

    assert.equal(await done, 'stale at room step');
    await drainMicrotasks();
    assert.deepEqual(socket.log, [
        'A:leave-room',
        'A:create-room',
        'teardown:host-stopped',
        'A:ack ROOM1',
        'A:host-stopped',
        'A:room settled',
    ]);
    assert.equal(socket.server.room, null, 'the late room is removed');
    assert.deepEqual(socket.server.destroyed, ['ROOM1']);
    assert.deepEqual(a.stream.getTracks().map((track) => track.readyState), ['ended', 'ended']);
    assert.equal(a.transport, undefined, 'no transport is created for the stale start');
    assert.equal(guard.activeOperation, null);
});

test('stop, a new start, then the old late ack: no host-stopped, and the new room request waits for the old one', async () => {
    const { guard, socket, createStartAttempt } = await setup();
    const a = {};
    const b = {};
    const aCreateSent = socket.whenCreateRequested();
    const aDone = runStart({ guard, socket, owner: 'A', createStartAttempt, state: a });
    await aCreateSent;

    guard.invalidate('stop');
    socket.emit('host-stopped', 'teardown');

    const bDone = runStart({ guard, socket, owner: 'B', createStartAttempt, state: b });
    await drainMicrotasks();
    assert.ok(!socket.log.some((entry) => entry.startsWith('B:')), 'B sends nothing while A\'s create-room is in flight');
    assert.equal(guard.activeOperation, b.op);

    const bCreateSent = socket.whenCreateRequested();
    socket.pendingCreate('A').commit();
    assert.equal(await aDone, 'stale at room step');
    await bCreateSent;
    socket.pendingCreate('B').commit();
    assert.equal(await bDone, 'sharing');

    assert.deepEqual(socket.log, [
        'A:leave-room',
        'A:create-room',
        'teardown:host-stopped',
        'A:ack ROOM1',
        'B:leave-room',
        'B:create-room',
        'B:ack ROOM2',
    ]);
    const bCreateIndex = socket.log.indexOf('B:create-room');
    assert.ok(
        !socket.log.slice(bCreateIndex).some((entry) => entry.endsWith('host-stopped')),
        'no host-stopped after the successor\'s create-room',
    );
    assert.equal(socket.server.room, 'ROOM2', 'the successor\'s room stays active');
    assert.deepEqual(a.stream.getTracks().map((track) => track.readyState), ['ended', 'ended']);
    assert.deepEqual(b.stream.getTracks().map((track) => track.readyState), ['live', 'live']);
    assert.equal(b.transport.closed, false);
    assert.equal(guard.activeOperation, b.op);
    assert.deepEqual(a.escalations, []);
});

test('a newer start that supersedes a pending one without a teardown gets the same ordering and no host-stopped', async () => {
    const { guard, socket, createStartAttempt } = await setup();
    const a = {};
    const b = {};
    const aCreateSent = socket.whenCreateRequested();
    const aDone = runStart({ guard, socket, owner: 'A', createStartAttempt, state: a });
    await aCreateSent;

    const bDone = runStart({ guard, socket, owner: 'B', createStartAttempt, state: b });
    await drainMicrotasks();
    assert.equal(guard.staleReason(a.op), 'superseded');
    assert.ok(!socket.log.some((entry) => entry.startsWith('B:')));

    const bCreateSent = socket.whenCreateRequested();
    socket.pendingCreate('A').commit();
    assert.equal(await aDone, 'stale at room step');
    await bCreateSent;
    socket.pendingCreate('B').commit();
    assert.equal(await bDone, 'sharing');
    assert.ok(!socket.log.some((entry) => entry.endsWith('host-stopped')));
    assert.equal(socket.server.room, 'ROOM2');
});

test('a reload-preserving pagehide never lets the stale start send host-stopped', async () => {
    const { guard, socket, createStartAttempt, RELOAD_PRESERVE } = await setup();
    const a = {};
    const createSent = socket.whenCreateRequested();
    const done = runStart({ guard, socket, owner: 'A', createStartAttempt, state: a });
    await createSent;

    guard.invalidate(RELOAD_PRESERVE);
    socket.pendingCreate('A').commit();

    assert.equal(await done, 'stale at room step');
    assert.ok(!socket.log.some((entry) => entry.endsWith('host-stopped')));
    assert.equal(socket.server.room, 'ROOM1', 'the room stays for reload recovery');
    assert.deepEqual(a.stream.getTracks().map((track) => track.readyState), ['ended', 'ended']);
});

test('a reload-preserving teardown of a later start also blocks an earlier stale start\'s host-stopped', async () => {
    const { guard, socket, createStartAttempt, RELOAD_PRESERVE } = await setup();
    const a = {};
    const b = {};
    const aCreateSent = socket.whenCreateRequested();
    const aDone = runStart({ guard, socket, owner: 'A', createStartAttempt, state: a });
    await aCreateSent;
    guard.invalidate('stop');

    // B resumes a recovered room (no create-room) and is waiting for A when the
    // page goes away with reload recovery.
    const bDone = runStart({ guard, socket, owner: 'B', createStartAttempt, state: b, resumed: true });
    await drainMicrotasks();
    guard.invalidate(RELOAD_PRESERVE);
    socket.pendingCreate('A').commit();

    assert.equal(await aDone, 'stale at room step');
    assert.equal(await bDone, 'stale at room step');
    assert.ok(!socket.log.some((entry) => entry.endsWith('host-stopped')));
    assert.deepEqual(b.stream.getTracks().map((track) => track.readyState), ['ended', 'ended']);
});

test('every stale exit releases exactly the resources that start acquired', async () => {
    const { guard, socket, createStartAttempt } = await setup();

    // Stale while the capture picker is open: the late capture is stopped and
    // no room request is sent.
    const capture = deferred();
    const a = {};
    const aDone = runStart({ guard, socket, owner: 'A', createStartAttempt, state: a, capture: () => capture.promise });
    await drainMicrotasks();
    guard.invalidate('unmount');
    capture.resolve(createStream('A'));
    assert.equal(await aDone, 'stale after capture');
    assert.deepEqual(a.stream.getTracks().map((track) => track.readyState), ['ended', 'ended']);
    assert.deepEqual(socket.log, []);

    // Stale after the room was created and the transport is being made: the
    // late transport is closed with the capture, and the room is removed.
    const transport = deferred();
    const b = {};
    const bCreateSent = socket.whenCreateRequested();
    const bDone = runStart({ guard, socket, owner: 'B', createStartAttempt, state: b, transport: () => transport.promise });
    await bCreateSent;
    socket.pendingCreate('B').commit();
    await drainMicrotasks();
    guard.invalidate('terminate');
    transport.resolve(createClosable('B-transport'));
    assert.equal(await bDone, 'stale after transport');
    assert.equal(b.transport.closed, true);
    assert.deepEqual(b.stream.getTracks().map((track) => track.readyState), ['ended', 'ended']);
    assert.equal(socket.server.room, null);

    // Stale while the audio producer is pending: both producers and the
    // transport close.
    const audio = deferred();
    const c = {};
    const cCreateSent = socket.whenCreateRequested();
    const cDone = runStart({
        guard,
        socket,
        owner: 'C',
        createStartAttempt,
        state: c,
        produce: (kind) => (kind === 'audio' ? audio.promise : Promise.resolve(createClosable('C-video-producer'))),
    });
    await cCreateSent;
    socket.pendingCreate('C').commit();
    await drainMicrotasks();
    guard.invalidate('cleanup');
    audio.resolve(createClosable('C-audio-producer'));
    assert.equal(await cDone, 'stale after audio producer');
    assert.equal(c.videoProducer.closed, true);
    assert.equal(c.audioProducer.closed, true);
    assert.equal(c.transport.closed, true);
    assert.deepEqual(c.stream.getTracks().map((track) => track.readyState), ['ended', 'ended']);

    // A request that fails after teardown: own resources released, no
    // host-stopped for a room that was never created.
    const d = {};
    const dCreateSent = socket.whenCreateRequested();
    const dDone = runStart({ guard, socket, owner: 'D', createStartAttempt, state: d });
    await dCreateSent;
    guard.invalidate('stop');
    socket.pendingCreate('D').fail('Request "create-room" timed out after 15s');
    assert.equal(await dDone, 'stale after failure');
    assert.equal(d.error, undefined, 'a stale start reports no error state');
    assert.deepEqual(d.stream.getTracks().map((track) => track.readyState), ['ended', 'ended']);
    assert.ok(!socket.log.includes('D:host-stopped'));
});

test('a start torn down during OBS configuration stops OBS only when no successor owns it', async () => {
    const { guard, socket, createStartAttempt } = await setup();
    const configure = deferred();
    const a = {};
    const aCreateSent = socket.whenCreateRequested();
    const aDone = runStart({ guard, socket, owner: 'A', createStartAttempt, state: a, configureObs: () => configure.promise });
    await aCreateSent;
    socket.pendingCreate('A').commit();
    await drainMicrotasks();
    guard.invalidate('stop');
    socket.emit('host-stopped', 'teardown');
    configure.resolve({ success: true });
    assert.equal(await aDone, 'stale after OBS configure');
    assert.deepEqual(socket.log.slice(-2), ['A:obs-stop', 'A:host-stopped']);

    // With a successor already started, the stale configure leaves OBS alone.
    const { guard: guard2, socket: socket2 } = await setup();
    const late = deferred();
    const b = {};
    const c = {};
    const bCreateSent = socket2.whenCreateRequested();
    const bDone = runStart({ guard: guard2, socket: socket2, owner: 'B', createStartAttempt, state: b, configureObs: () => late.promise });
    await bCreateSent;
    socket2.pendingCreate('B').commit();
    await drainMicrotasks();
    guard2.invalidate('stop');
    const cCreateSent = socket2.whenCreateRequested();
    const cDone = runStart({ guard: guard2, socket: socket2, owner: 'C', createStartAttempt, state: c, configureObs: () => Promise.resolve({ success: true }) });
    await cCreateSent;
    late.resolve({ success: true });
    assert.equal(await bDone, 'stale after OBS configure');
    socket2.pendingCreate('C').commit();
    assert.equal(await cDone, 'sharing');
    assert.ok(!socket2.log.includes('B:obs-stop'));
    assert.ok(!socket2.log.includes('B:host-stopped'));
    assert.equal(socket2.server.room, 'ROOM2');
});

test('a start torn down before its room request never holds up the next start', async () => {
    const { guard, socket, createStartAttempt } = await setup();
    // The picker of A is never answered.
    const a = {};
    runStart({ guard, socket, owner: 'A', createStartAttempt, state: a, capture: () => new Promise(() => {}) });
    await drainMicrotasks();
    guard.invalidate('unmount');

    const b = {};
    const bCreateSent = socket.whenCreateRequested();
    const bDone = runStart({ guard, socket, owner: 'B', createStartAttempt, state: b });
    await bCreateSent;
    socket.pendingCreate('B').commit();
    assert.equal(await bDone, 'sharing');
    assert.equal(socket.server.room, 'ROOM1');
});

test('a current start settles its room step at the ack, so a later start does not wait for its transports', async () => {
    const { guard, socket, createStartAttempt } = await setup();
    const transport = deferred();
    const a = {};
    const aCreateSent = socket.whenCreateRequested();
    const aDone = runStart({ guard, socket, owner: 'A', createStartAttempt, state: a, transport: () => transport.promise });
    await aCreateSent;
    let settled = false;
    guard.roomSettled(a.op).then(() => { settled = true; });
    socket.pendingCreate('A').commit();
    await drainMicrotasks();
    assert.equal(settled, true);
    assert.equal(guard.isCurrent(a.op), true);
    transport.resolve(createClosable('A-transport'));
    assert.equal(await aDone, 'sharing');
    assert.equal(guard.activeOperation, a.op, 'a running session keeps owning the socket');
});

test('the settle wait is bounded; a stale ack after the bound is escalated and sends nothing', async () => {
    const { createStartOperationGuard, createStartAttempt } = await loadGuard();
    const timers = [];
    const guard = createStartOperationGuard({
        settleTimeoutMs: 65_000,
        setTimer: (callback, ms) => {
            const handle = { callback, ms, cleared: false };
            timers.push(handle);
            return handle;
        },
        clearTimer: (handle) => { handle.cleared = true; },
    });
    const socket = createHostSocket();
    const a = {};
    const b = {};
    const aCreateSent = socket.whenCreateRequested();
    const aDone = runStart({ guard, socket, owner: 'A', createStartAttempt, state: a });
    await aCreateSent;
    guard.invalidate('stop');
    const bDone = runStart({ guard, socket, owner: 'B', createStartAttempt, state: b });
    await drainMicrotasks();
    const pending = timers.filter((timer) => !timer.cleared);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].ms, 65_000);

    // The bound runs out (A's request is stuck); B goes ahead.
    const bCreateSent = socket.whenCreateRequested();
    pending[0].callback();
    await bCreateSent;
    assert.equal(b.escalations.length, 1);

    // A's ack finally arrives while B owns the session.
    socket.pendingCreate('A').commit();
    assert.equal(await aDone, 'stale at room step');
    assert.ok(!socket.log.includes('A:host-stopped'));
    assert.equal(a.escalations.length, 1);
    socket.pendingCreate('B').commit();
    assert.equal(await bDone, 'sharing');
});

test('guard: ids, invalidation and the compensation fence', async () => {
    const { createStartOperationGuard, RELOAD_PRESERVE } = await loadGuard();
    const guard = createStartOperationGuard();
    const a = guard.begin();
    assert.equal(guard.isCurrent(a), true);
    assert.equal(guard.activeOperation, a);
    assert.equal(guard.mayCompensateShared(a), false, 'a current operation never compensates');

    guard.invalidate('stop');
    assert.equal(guard.isCurrent(a), false);
    assert.equal(guard.activeOperation, null);
    assert.equal(guard.staleReason(a), 'stop');
    assert.equal(guard.mayCompensateShared(a), true);
    assert.equal(guard.claimRoomRequest(a), false, 'a stale operation cannot send a room request');

    const b = guard.begin();
    assert.equal(guard.mayCompensateShared(a), false, 'a successor owns the session');
    guard.invalidate('unmount');
    assert.equal(guard.mayCompensateShared(a), true);
    assert.equal(guard.mayCompensateShared(b), true);

    guard.invalidate(RELOAD_PRESERVE);
    assert.equal(guard.mayCompensateShared(a), false, 'nothing compensates after a reload-preserving teardown');
    const c = guard.begin();
    guard.invalidate(RELOAD_PRESERVE);
    assert.equal(guard.staleReason(c), RELOAD_PRESERVE);
    assert.equal(guard.mayCompensateShared(c), false);
});

test('startOperationGuardFor keeps one guard per socket across view remounts', async () => {
    const { startOperationGuardFor } = await loadGuard();
    const socketA = {};
    const socketB = {};
    assert.equal(startOperationGuardFor(socketA), startOperationGuardFor(socketA));
    assert.notEqual(startOperationGuardFor(socketA), startOperationGuardFor(socketB));
});
