'use strict';

// Deterministic tests of src/lib/subscriptionLedger.mjs with a fake socket
// whose acknowledgements the test delivers by hand. The viewer model below
// makes the same ledger calls as WatchView's startRelayPlayback (claim at
// emit, commit after a current acknowledgement, release from the catch) and
// as the relay-subscription owner of useViewerSessionController's cleanup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const loadLedger = () => import('../src/lib/subscriptionLedger.mjs');
const loadAttempt = () => import('../src/lib/playbackAttempt.mjs');

class FakeSocket {
    constructor(id = 'socket-1') {
        this.id = id;
        this.connected = true;
        this.emitted = [];
        this.pendingAcks = [];
        this.listeners = new Map();
        this.onEmit = null;
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
        this.onEmit?.(event);
        if (typeof ack === 'function') this.pendingAcks.push({ event, ack });
    }

    // Hands back the acknowledgement callback of the oldest pending request.
    takeAck(event) {
        const index = this.pendingAcks.findIndex((pending) => pending.event === event);
        assert.notEqual(index, -1, `no pending ack for ${event}`);
        return this.pendingAcks.splice(index, 1)[0].ack;
    }

    // socket.io-client drops the id and fires 'disconnect'; acks of sent packets never come.
    drop(reason = 'transport close') {
        this.connected = false;
        this.id = undefined;
        this.pendingAcks = [];
        for (const listener of [...(this.listeners.get('disconnect') || [])]) listener(reason);
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

async function createViewerModel(socket) {
    const { createSubscriptionLedger, emitClaimedStart, releaseSubscription } = await loadLedger();
    const { beginPlaybackAttempt } = await loadAttempt();
    const ledger = createSubscriptionLedger();
    const attemptRef = { current: 0 };
    const relayClaimRef = { current: null };
    const relaySubscribedRef = { current: false };

    // useViewerSessionController's cleanup: supersede, then the relay-subscription owner.
    const cleanupPlayback = () => {
        attemptRef.current += 1;
        const claim = relayClaimRef.current;
        relayClaimRef.current = null;
        if (relaySubscribedRef.current) releaseSubscription(ledger, 'relay', claim, socket, 'relay-consume-stop');
        relaySubscribedRef.current = false;
    };

    // startRelayPlayback up to the commit; `committed` resolves with the attempt.
    const startRelay = () => {
        const attempt = beginPlaybackAttempt(attemptRef);
        let ownedClaim = null;
        const run = async () => {
            try {
                const request = emitClaimedStart(ledger, 'relay', attempt.id, socket, 'relay-consume-start');
                ownedClaim = request.claim;
                const ack = await request.acknowledged;
                if (!ack?.success) {
                    ledger.release('relay', ownedClaim);
                    ownedClaim = null;
                    throw new Error(ack?.error || 'refused');
                }
                attempt.assertCurrent();
                relayClaimRef.current = ownedClaim;
                ownedClaim = null;
                relaySubscribedRef.current = true;
                return attempt;
            } catch (err) {
                if (ownedClaim) {
                    releaseSubscription(ledger, 'relay', ownedClaim, socket, 'relay-consume-stop');
                    ownedClaim = null;
                }
                throw attempt.settleFailure(err);
            }
        };
        const committed = run();
        committed.catch(() => { });
        return { attempt, committed, claim: () => ledger.latest('relay') };
    };

    return { ledger, attemptRef, relayClaimRef, relaySubscribedRef, cleanupPlayback, startRelay };
}

test("a stale attempt's late acknowledgement after a newer start sends no relay-consume-stop", async () => {
    const { isSupersededAttemptError } = await loadAttempt();
    const socket = new FakeSocket();
    const viewer = await createViewerModel(socket);

    // A claims and emits its start.
    const a = viewer.startRelay();
    const aClaim = viewer.ledger.latest('relay');
    assert.equal(aClaim.token, a.attempt.id);
    const ackA = socket.takeAck('relay-consume-start');

    // Cleanup runs (A is not committed yet, so the owner sends nothing).
    viewer.cleanupPlayback();

    // B claims, emits and is acknowledged.
    const b = viewer.startRelay();
    const bClaim = viewer.ledger.latest('relay');
    socket.takeAck('relay-consume-start')({ success: true, relayViewerCount: 1 });
    assert.equal(await b.committed, b.attempt);

    // Only now is A's acknowledgement delivered.
    ackA({ success: true, relayViewerCount: 1 });
    await assert.rejects(a.committed, (err) => isSupersededAttemptError(err));

    assert.equal(socket.count('relay-consume-stop'), 0, 'no stop: B owns the socket-wide subscription');
    assert.equal(socket.count('relay-consume-start'), 2);
    assert.equal(viewer.ledger.latest('relay'), bClaim, "B's claim stays the latest");
    assert.equal(viewer.relayClaimRef.current, bClaim, "B's committed refs are untouched");
    assert.equal(viewer.relaySubscribedRef.current, true);
    assert.notEqual(aClaim, bClaim);
});

test('a stale attempt that is still the latest claimant on the same socket sends exactly one stop', async () => {
    const { isSupersededAttemptError } = await loadAttempt();
    const socket = new FakeSocket();
    const viewer = await createViewerModel(socket);

    const a = viewer.startRelay();
    const ackA = socket.takeAck('relay-consume-start');
    viewer.cleanupPlayback();
    ackA({ success: true, relayViewerCount: 1 });
    await assert.rejects(a.committed, (err) => isSupersededAttemptError(err));

    assert.deepEqual(socket.emitted.map((entry) => entry.event), ['relay-consume-start', 'relay-consume-stop']);
    assert.equal(viewer.ledger.latest('relay'), null, 'the claim is released');
    assert.equal(viewer.relaySubscribedRef.current, false, 'the stale attempt committed nothing');

    // A later cleanup has nothing left to stop.
    viewer.cleanupPlayback();
    assert.equal(socket.count('relay-consume-stop'), 1);
});

test('a committed subscription is stopped once, by cleanupPlayback, and never again by its attempt', async () => {
    const socket = new FakeSocket();
    const viewer = await createViewerModel(socket);

    const a = viewer.startRelay();
    socket.takeAck('relay-consume-start')({ success: true, relayViewerCount: 1 });
    await a.committed;
    viewer.cleanupPlayback();
    viewer.cleanupPlayback();
    assert.equal(socket.count('relay-consume-stop'), 1);
    assert.equal(viewer.ledger.latest('relay'), null);
});

test('no stop after the socket reconnected under a new socket.id', async () => {
    const { isSupersededAttemptError } = await loadAttempt();
    const socket = new FakeSocket('socket-1');
    const viewer = await createViewerModel(socket);

    // Committed on socket-1, then the connection is replaced.
    const a = viewer.startRelay();
    socket.takeAck('relay-consume-start')({ success: true, relayViewerCount: 1 });
    await a.committed;
    socket.drop();
    socket.reconnect('socket-2');
    viewer.cleanupPlayback();
    assert.equal(socket.count('relay-consume-stop'), 0, 'the old subscription left with socket-1');

    // In flight on socket-1 when it dropped: the start is never acknowledged.
    const b = viewer.startRelay();
    assert.equal(viewer.ledger.latest('relay').socketId, 'socket-2');
    socket.drop();
    await assert.rejects(b.committed, /Connection lost while waiting for "relay-consume-start"/);
    socket.reconnect('socket-3');
    viewer.cleanupPlayback();
    assert.equal(socket.count('relay-consume-stop'), 0);

    // Superseded, then acknowledged after a reconnect (a stray late ack).
    const c = viewer.startRelay();
    const ackC = socket.takeAck('relay-consume-start');
    viewer.cleanupPlayback();
    socket.reconnect('socket-4');
    ackC({ success: true, relayViewerCount: 1 });
    await assert.rejects(c.committed, (err) => isSupersededAttemptError(err));
    assert.equal(socket.count('relay-consume-stop'), 0, 'a stop on socket-4 could remove a newer subscription');
});

test('no stop while the socket is disconnected, and no start either', async () => {
    const { SocketNotConnectedError, emitClaimedStart, releaseSubscription, createSubscriptionLedger } = await loadLedger();
    const socket = new FakeSocket();
    const viewer = await createViewerModel(socket);

    const a = viewer.startRelay();
    socket.takeAck('relay-consume-start')({ success: true, relayViewerCount: 1 });
    await a.committed;
    const committed = viewer.relayClaimRef.current;

    // The connection is gone but socket.io-client has not reported a new id yet.
    socket.connected = false;
    assert.equal(viewer.ledger.canRelease('relay', committed, socket), false);
    viewer.cleanupPlayback();
    assert.equal(socket.count('relay-consume-stop'), 0, 'a buffered stop would be sent on the next connection');

    const b = viewer.startRelay();
    await assert.rejects(b.committed, (err) => err instanceof SocketNotConnectedError);
    assert.equal(socket.count('relay-consume-start'), 1, 'no start is emitted, so none is buffered');

    // The same, called directly.
    const ledger = createSubscriptionLedger();
    assert.throws(
        () => emitClaimedStart(ledger, 'relay', 'token', socket, 'relay-consume-start'),
        (err) => err instanceof SocketNotConnectedError && /relay-consume-start/.test(err.message),
    );
    assert.equal(ledger.latest('relay'), null, 'nothing is claimed');
    const stale = { kind: 'relay', token: 'x', socketId: 'socket-1' };
    assert.equal(releaseSubscription(ledger, 'relay', stale, socket, 'relay-consume-stop'), false);
    assert.equal(socket.count('relay-consume-stop'), 0);
});

test('the claim is recorded in the same synchronous block as the start emit', async () => {
    const { createSubscriptionLedger, emitClaimedStart } = await loadLedger();
    const ledger = createSubscriptionLedger();
    const socket = new FakeSocket('socket-7');
    let latestAtEmit = 'not emitted';
    socket.onEmit = () => { latestAtEmit = ledger.latest('relay'); };

    const { claim, acknowledged } = emitClaimedStart(ledger, 'relay', 42, socket, 'relay-consume-start');
    assert.equal(latestAtEmit, claim, 'the emit saw its own claim as the latest');
    assert.deepEqual({ ...claim }, { kind: 'relay', token: 42, socketId: 'socket-7' });
    assert.equal(Object.isFrozen(claim), true);

    const response = { success: true, relayViewerCount: 2, bootstrapChunks: [] };
    socket.takeAck('relay-consume-start')(response);
    assert.equal(await acknowledged, response, 'the raw acknowledgement is returned');
    assert.equal(socket.listeners.get('disconnect').size, 0, 'the disconnect listener is removed on settle');
});

test('a start acknowledgement times out once, and a late answer is ignored', async (t) => {
    const { createSubscriptionLedger, emitClaimedStart } = await loadLedger();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ledger = createSubscriptionLedger();
    const socket = new FakeSocket();

    const { acknowledged } = emitClaimedStart(ledger, 'relay', 1, socket, 'relay-consume-start', {}, { timeoutMs: 15000 });
    const ack = socket.takeAck('relay-consume-start');
    t.mock.timers.tick(15000);
    await assert.rejects(acknowledged, /Request "relay-consume-start" timed out after 15s/);
    ack({ success: true });
    await drainMicrotasks();
    assert.equal(socket.count('relay-consume-start'), 1, 'never retried');
    assert.equal(socket.listeners.get('disconnect').size, 0);
});

test('canRelease and release act only on the latest claim of the same kind', async () => {
    const { createSubscriptionLedger } = await loadLedger();
    const ledger = createSubscriptionLedger();
    const socket = new FakeSocket('socket-1');

    const relayA = ledger.claim('relay', 'a', 'socket-1');
    const fallback = ledger.claim('fallback', 'f', 'socket-1');
    const relayB = ledger.claim('relay', 'b', 'socket-1');

    assert.equal(ledger.canRelease('relay', relayA, socket), false, 'superseded by a newer relay claim');
    assert.equal(ledger.canRelease('relay', relayB, socket), true);
    assert.equal(ledger.canRelease('fallback', fallback, socket), true, 'kinds are independent');
    assert.equal(ledger.canRelease('relay', fallback, socket), false);
    assert.equal(ledger.canRelease('relay', null, socket), false);
    assert.equal(ledger.canRelease('relay', relayB, null), false);
    assert.equal(ledger.canRelease('relay', relayB, { connected: true, id: 'socket-2', emit() {} }), false);

    assert.equal(ledger.release('relay', relayA), false, 'an older claim cannot clear the newer one');
    assert.equal(ledger.latest('relay'), relayB);
    assert.equal(ledger.release('relay', relayB), true);
    assert.equal(ledger.latest('relay'), null);
    assert.equal(ledger.canRelease('relay', relayB, socket), false, 'a released claim cannot be stopped again');
    assert.equal(ledger.latest('fallback'), fallback);

    assert.throws(() => ledger.claim('webrtc', 'x', 'socket-1'), /Unknown subscription kind/);
});

test('WatchView and its session controller send relay starts and stops only through the ledger', () => {
    const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    for (const file of ['WatchView.jsx', 'hooks/useViewerSessionController.js']) {
        const source = read(file);
        assert.doesNotMatch(source, /emit\(\s*['"]relay-consume-(start|stop)['"]/,
            `${file} must not emit relay-consume-start/stop directly`);
        assert.doesNotMatch(source, /socketRequest\(\s*socket,\s*['"]relay-consume-start['"]/,
            `${file} must claim relay-consume-start in the ledger at emit time`);
    }
    const watchView = read('WatchView.jsx');
    assert.match(watchView, /emitClaimedStart\(subscriptionLedger, 'relay', attempt\.id, socket, 'relay-consume-start'\)/);
    assert.match(read('hooks/useViewerSessionController.js'),
        /releaseSubscription\(subscriptionLedger, 'relay', claim, socket, 'relay-consume-stop'\)/);
});

// startRelayPlayback reads the relay start's answer (its generation) in the
// answer's own dispatch, before the live chunks that follow it are dispatched.
test('a claimed start hands its answer to onAnswer listeners before anything awaiting the acknowledgement', async () => {
    const { createSubscriptionLedger, emitClaimedStart } = await loadLedger();
    const ledger = createSubscriptionLedger();
    const socket = new FakeSocket('socket-3');
    const order = [];
    const { acknowledged } = emitClaimedStart(ledger, 'relay', 7, socket, 'relay-consume-start');
    acknowledged.onAnswer((answer) => order.push(`onAnswer ${answer.generation}`));
    void acknowledged.then((answer) => order.push(`then ${answer.generation}`));

    const ack = socket.takeAck('relay-consume-start');
    void Promise.resolve().then(() => ack({ success: true, generation: 5 }));
    void Promise.resolve().then(() => order.push('media-chunk'));
    await drainMicrotasks();
    assert.deepEqual(order, ['onAnswer 5', 'media-chunk', 'then 5']);
});

test('WatchView takes the relay start\'s generation from the answer in its own dispatch, and prepends only that generation\'s bootstrap', () => {
    const watchView = fs.readFileSync(path.join(__dirname, '..', 'src', 'WatchView.jsx'), 'utf8');
    const from = watchView.indexOf('const startRelayPlayback = useCallback(');
    const to = watchView.indexOf('}, [socket, playVideoElement', from);
    assert.ok(from > 0 && to > from, 'startRelayPlayback is defined');
    const start = watchView.slice(from, to);
    const emit = start.indexOf("emitClaimedStart(subscriptionLedger, 'relay', attempt.id, socket, 'relay-consume-start')");
    const onAnswer = start.indexOf('relayRequest.acknowledged.onAnswer(');
    const awaited = start.indexOf('await relayRequest.acknowledged');
    assert.ok(emit > 0 && onAnswer > emit && awaited > onAnswer, 'the listener is registered before the answer is awaited');
    assert.match(start.slice(onAnswer, awaited), /selectedGeneration = answer\.generation/);
    assert.match(start, /relayStart\.generation === selectedGeneration/, 'a bootstrap of a generation since replaced is not prepended');

    const server = fs.readFileSync(path.join(__dirname, '..', 'lib', 'socket.js'), 'utf8');
    const handler = server.slice(server.indexOf("socket.on('relay-consume-start'"), server.indexOf("socket.on('relay-consume-stop'"));
    assert.match(handler, /generation: room\.mediaGeneration \?\? null/, 'the server names the generation in its answer');
});
