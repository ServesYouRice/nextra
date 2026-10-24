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
