'use strict';

// Tests of src/lib/timedAck.mjs, the single-attempt request WatchView sends
// fallback-consume-start with, against a fake socket whose acknowledgements and
// disconnects the test delivers by hand.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const loadModule = () => import('../src/lib/timedAck.mjs');

class FakeSocket {
    constructor(id = 'socket-1') {
        this.id = id;
        this.connected = true;
        this.emitted = [];
        this.pendingAcks = [];
        this.listeners = new Map();
        this.connectCalls = 0;
    }

    on(event, listener) {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event).add(listener);
    }

    off(event, listener) {
        this.listeners.get(event)?.delete(listener);
    }

    connect() {
        this.connectCalls += 1;
    }

    emit(event, payload, ack) {
        this.emitted.push({ event, payload });
        if (typeof ack === 'function') this.pendingAcks.push(ack);
    }

    listenerCount(event) {
        return this.listeners.get(event)?.size ?? 0;
    }

    // socket.io-client fires 'disconnect' and never calls the ack of a sent packet.
    drop(reason = 'transport close') {
        this.connected = false;
        this.pendingAcks = [];
        for (const listener of [...(this.listeners.get('disconnect') ?? [])]) listener(reason);
    }
}

async function drainMicrotasks() {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

test('the raw acknowledgement is resolved unchanged, whatever its shape', async () => {
    const { emitWithTimedAck } = await loadModule();

    // The server answers fallback-consume-start with { ok, fallbackAvailable }, not { success }.
    for (const response of [
        { ok: true, fallbackAvailable: true },
        { ok: true, fallbackAvailable: false },
        { error: 'Not an OBS room' },
        { success: false, error: 'x' },
        undefined,
        null,
    ]) {
        const socket = new FakeSocket();
        const request = emitWithTimedAck(socket, 'fallback-consume-start', {});
        socket.pendingAcks[0](response);
        assert.equal(await request, response, `resolves with ${JSON.stringify(response)} as it is`);
    }
});

test('the request is emitted once, before the helper returns, with its payload and an ack', async () => {
    const { emitWithTimedAck } = await loadModule();
    const socket = new FakeSocket();
    const payload = { roomCode: 'ABC123' };
    const request = emitWithTimedAck(socket, 'fallback-consume-start', payload);

    assert.deepEqual(socket.emitted, [{ event: 'fallback-consume-start', payload }], 'emitted synchronously, once');
    assert.equal(socket.pendingAcks.length, 1);
    socket.pendingAcks[0]({ ok: true });
    await request;
    assert.equal(socket.emitted.length, 1);
});

test('a missing answer rejects with a timeout error after 10 s by default, and the helper cleans up', async (t) => {
    const { emitWithTimedAck, AckTimeoutError, isAckTimeoutError, DEFAULT_ACK_TIMEOUT_MS } = await loadModule();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal(DEFAULT_ACK_TIMEOUT_MS, 10000);

    const socket = new FakeSocket();
    const request = emitWithTimedAck(socket, 'fallback-consume-start', {});
    request.catch(() => { });
    assert.equal(socket.listenerCount('disconnect'), 1);

    t.mock.timers.tick(9999);
    await drainMicrotasks();
    assert.equal(socket.listenerCount('disconnect'), 1, 'still waiting just before the timeout');

    t.mock.timers.tick(1);
    await assert.rejects(request, (err) => err instanceof AckTimeoutError && isAckTimeoutError(err)
        && /Request "fallback-consume-start" timed out after 10s/.test(err.message));
    assert.equal(socket.listenerCount('disconnect'), 0, 'the disconnect listener is removed');
    assert.equal(socket.connectCalls, 0, 'it never reconnects the socket');
});

test('timeoutMs sets the wait', async (t) => {
    const { emitWithTimedAck, isAckTimeoutError } = await loadModule();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const socket = new FakeSocket();
    const request = emitWithTimedAck(socket, 'fallback-consume-start', {}, { timeoutMs: 2500 });
    request.catch(() => { });
    t.mock.timers.tick(2499);
    await drainMicrotasks();
    t.mock.timers.tick(1);
    await assert.rejects(request, (err) => isAckTimeoutError(err) && /timed out after 3s/.test(err.message));
});

test('a connection that drops first rejects with a disconnect error, and nothing is emitted again', async (t) => {
    const { emitWithTimedAck, isAckDisconnectError, isAckTimeoutError } = await loadModule();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const socket = new FakeSocket();
    const request = emitWithTimedAck(socket, 'fallback-consume-start', {});
    request.catch(() => { });

    socket.drop('transport close');
    await assert.rejects(request, (err) => isAckDisconnectError(err) && !isAckTimeoutError(err)
        && /Connection lost while waiting for "fallback-consume-start" \(transport close\)/.test(err.message));
    assert.equal(socket.listenerCount('disconnect'), 0);

    // The timer went with it: ticking past the timeout settles nothing again.
    t.mock.timers.tick(60000);
    await drainMicrotasks();
    assert.equal(socket.emitted.length, 1, 'never retried');
    assert.equal(socket.connectCalls, 0);
});

test('an answer that arrives after the timeout or the disconnect is ignored', async (t) => {
    const { emitWithTimedAck, isAckTimeoutError, isAckDisconnectError } = await loadModule();
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const late = new FakeSocket();
    const afterTimeout = emitWithTimedAck(late, 'fallback-consume-start', {});
    const lateAck = late.pendingAcks[0];
    t.mock.timers.tick(10000);
    await assert.rejects(afterTimeout, (err) => isAckTimeoutError(err));
    assert.doesNotThrow(() => lateAck({ ok: true, fallbackAvailable: true }));
    await drainMicrotasks();
    assert.equal(late.emitted.length, 1);
    assert.equal(late.listenerCount('disconnect'), 0);

    const dropped = new FakeSocket();
    const afterDrop = emitWithTimedAck(dropped, 'fallback-consume-start', {});
    const droppedAck = dropped.pendingAcks[0];
    dropped.drop();
    await assert.rejects(afterDrop, (err) => isAckDisconnectError(err));
    assert.doesNotThrow(() => droppedAck({ ok: true }));
});

test('a disconnect after the answer changes nothing', async () => {
    const { emitWithTimedAck } = await loadModule();
    const socket = new FakeSocket();
    const request = emitWithTimedAck(socket, 'fallback-consume-start', {});
    socket.pendingAcks[0]({ ok: true, fallbackAvailable: true });
    assert.deepEqual(await request, { ok: true, fallbackAvailable: true });
    assert.equal(socket.listenerCount('disconnect'), 0, 'the listener is removed on settle');
    socket.drop();
});

test('nothing is emitted while the socket is disconnected, so nothing is buffered into a later connection', async (t) => {
    const { emitWithTimedAck, SocketNotConnectedError, isSocketNotConnectedError } = await loadModule();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const socket = new FakeSocket();
    socket.connected = false;

    const request = emitWithTimedAck(socket, 'fallback-consume-start', {});
    await assert.rejects(request, (err) => err instanceof SocketNotConnectedError && isSocketNotConnectedError(err)
        && /"fallback-consume-start" was not sent/.test(err.message));
    assert.deepEqual(socket.emitted, [], 'no emit');
    assert.equal(socket.listenerCount('disconnect'), 0);
    assert.equal(socket.connectCalls, 0, 'it does not connect the socket either');

    // No timer was left behind either: reconnecting and ticking emits and settles nothing.
    socket.connected = true;
    t.mock.timers.tick(60000);
    await drainMicrotasks();
    assert.deepEqual(socket.emitted, []);
});

test('the request is never retried, whatever the answer or the silence', async (t) => {
    const { emitWithTimedAck } = await loadModule();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const socket = new FakeSocket();
    const request = emitWithTimedAck(socket, 'fallback-consume-start', {});
    request.catch(() => { });
    t.mock.timers.tick(10000 * 5);
    await drainMicrotasks();
    assert.equal(socket.emitted.length, 1);
    assert.equal(socket.connectCalls, 0);
});

test('a socket that throws on emit rejects the request and leaves nothing behind', async (t) => {
    const { emitWithTimedAck } = await loadModule();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const socket = new FakeSocket();
    socket.emit = () => { throw new Error('emit failed'); };
    await assert.rejects(emitWithTimedAck(socket, 'fallback-consume-start', {}), /emit failed/);
    assert.equal(socket.listenerCount('disconnect'), 0);
});

test('WatchView sends fallback-consume-start only through the timed helper, never raw or through socketRequest', () => {
    const watchView = fs.readFileSync(path.join(__dirname, '..', 'src', 'WatchView.jsx'), 'utf8');
    assert.doesNotMatch(watchView, /emit\(\s*['"]fallback-consume-start['"]/,
        'no raw emit of fallback-consume-start remains');
    assert.doesNotMatch(watchView, /socketRequest\(\s*socket,\s*['"]fallback-consume-start['"]/,
        'socketRequest treats { ok: true } as a failure');
    assert.match(watchView, /beginFallbackStart\(/);

    const fallbackStart = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'fallbackStart.mjs'), 'utf8');
    assert.match(fallbackStart, /emitClaimedStart\(\s*ledger, 'fallback', token, socket, 'fallback-consume-start'/);
    const ledger = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'subscriptionLedger.mjs'), 'utf8');
    assert.match(ledger, /emitWithTimedAck\(socket, event, payload, \{ timeoutMs \}\)/);
});
