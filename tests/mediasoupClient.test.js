const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

class FakeSocket extends EventEmitter {
    constructor({ connected = true, onRequest, onConnect } = {}) {
        super();
        this.connected = connected;
        this.onRequest = onRequest;
        this.onConnect = onConnect;
        this.connectCalls = 0;
    }

    connect() {
        this.connectCalls += 1;
        this.onConnect?.(this);
    }

    emit(event, ...args) {
        if (event === 'connect' || event === 'connect_error' || event === 'disconnect') {
            return super.emit(event, ...args);
        }
        this.onRequest?.(event, ...args);
        return true;
    }
}

async function loadClientModule() {
    return import('../src/lib/mediasoupClient.js');
}

test('socketRequest retries a timed-out idempotent request and accepts the later acknowledgement', async () => {
    const { socketRequest } = await loadClientModule();
    let requests = 0;
    const socket = new FakeSocket({
        onRequest(_event, _payload, callback) {
            requests += 1;
            if (requests === 2) callback({ success: true, code: 'ABC123' });
        },
    });

    const response = await socketRequest(socket, 'join-room', {}, { timeoutMs: 10 });

    assert.equal(response.code, 'ABC123');
    assert.equal(requests, 2);
});

test('socketRequest does not retry an application-level rejection', async () => {
    const { socketRequest } = await loadClientModule();
    let requests = 0;
    const socket = new FakeSocket({
        onRequest(_event, _payload, callback) {
            requests += 1;
            callback({ success: false, error: 'Room is full', retryAfterMs: 5000 });
        },
    });

    await assert.rejects(
        socketRequest(socket, 'join-room'),
        (err) => err.message === 'Room is full' && err.retryAfterMs === 5000,
    );
    assert.equal(requests, 1);
});

test('socketRequest rejects immediately when the connection drops before acknowledgement', async () => {
    const { socketRequest } = await loadClientModule();
    const socket = new FakeSocket({
        onRequest() {
            queueMicrotask(() => socket.emit('disconnect', 'transport close'));
        },
    });

    await assert.rejects(
        socketRequest(socket, 'get-rtp-capabilities', {}, { timeoutMs: 100 }),
        /Connection lost while waiting for "get-rtp-capabilities" \(transport close\)/,
    );
});

test('socketRequest waits for a delayed connection and removes connection listeners', async () => {
    const { socketRequest } = await loadClientModule();
    const socket = new FakeSocket({
        connected: false,
        onConnect(instance) {
            setTimeout(() => {
                instance.connected = true;
                instance.emit('connect');
            }, 5);
        },
        onRequest(_event, _payload, callback) {
            callback({ success: true });
        },
    });

    await socketRequest(socket, 'get-rtp-capabilities', {}, { connectTimeoutMs: 100 });

    assert.equal(socket.connectCalls, 1);
    assert.equal(socket.listenerCount('connect'), 0);
    assert.equal(socket.listenerCount('connect_error'), 0);
    assert.equal(socket.listenerCount('disconnect'), 0);
});

test('socketRequest reports a useful endpoint error when connection attempts fail', async () => {
    const { socketRequest } = await loadClientModule();
    const socket = new FakeSocket({
        connected: false,
        onConnect(instance) {
            queueMicrotask(() => instance.emit('connect_error', new Error('websocket error')));
        },
    });

    await assert.rejects(
        socketRequest(socket, 'get-rtp-capabilities', {}, { connectTimeoutMs: 20 }),
        /cannot reach the Nextra server at \/socket\.io/,
    );
    assert.equal(socket.listenerCount('connect'), 0);
    assert.equal(socket.listenerCount('connect_error'), 0);
});
