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

    const response = await socketRequest(socket, 'get-media-init', {}, { timeoutMs: 10 });

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

// A request that timed out on the client may still have reached the server, so only events the
// server can safely handle twice are sent again. Failures before the emit are retried for any event.

test('socketRequest emits create-room exactly once when the acknowledgement times out', async () => {
    const { socketRequest } = await loadClientModule();
    let requests = 0;
    const socket = new FakeSocket({
        onRequest() {
            requests += 1;
        },
    });

    const err = await socketRequest(socket, 'create-room', {}, { timeoutMs: 10 }).then(() => null, (e) => e);

    assert.equal(requests, 1);
    assert.match(err.message, /Request "create-room" timed out/);
    assert.equal(err.phase, 'ack-timeout');
});

test('socketRequest emits join-room exactly once when the acknowledgement times out', async () => {
    const { socketRequest } = await loadClientModule();
    let requests = 0;
    const socket = new FakeSocket({
        onRequest() {
            requests += 1;
        },
    });

    const err = await socketRequest(socket, 'join-room', { code: 'ABC123' }, { timeoutMs: 10 }).then(() => null, (e) => e);

    assert.equal(requests, 1);
    assert.match(err.message, /Request "join-room" timed out/);
    assert.equal(err.phase, 'ack-timeout');
});

test('socketRequest does not resend create-room or join-room after a disconnect that follows the emit', async () => {
    const { socketRequest } = await loadClientModule();
    for (const event of ['create-room', 'join-room']) {
        let requests = 0;
        const socket = new FakeSocket({
            onRequest() {
                requests += 1;
                queueMicrotask(() => socket.emit('disconnect', 'transport close'));
            },
        });

        const err = await socketRequest(socket, event, {}, { timeoutMs: 100 }).then(() => null, (e) => e);

        assert.equal(requests, 1, `${event} must be emitted once`);
        assert.match(err.message, /Connection lost while waiting/);
        assert.equal(err.phase, 'disconnect-after-emit');
        assert.equal(socket.listenerCount('disconnect'), 0);
    }
});

test('socketRequest throws a server error that says "timed out" without retrying it', async () => {
    const { socketRequest } = await loadClientModule();
    for (const event of ['create-room', 'join-room', 'get-media-init', 'reclaim-host', 'leave-room']) {
        let requests = 0;
        const socket = new FakeSocket({
            onRequest(_event, _payload, callback) {
                requests += 1;
                callback({ success: false, error: 'operation timed out' });
            },
        });

        const err = await socketRequest(socket, event).then(() => null, (e) => e);

        assert.equal(requests, 1, `${event} must not be retried after a server error`);
        assert.equal(err.message, 'operation timed out');
        assert.equal(err.phase, 'server');
    }
});

test('socketRequest does not retry server errors that mention a lost or failed connection', async () => {
    const { socketRequest } = await loadClientModule();
    for (const message of ['Connection lost to the media worker', 'Socket connect failed upstream', 'Socket is not connected to the relay']) {
        let requests = 0;
        const socket = new FakeSocket({
            onRequest(_event, _payload, callback) {
                requests += 1;
                callback({ success: false, error: message });
            },
        });

        await assert.rejects(socketRequest(socket, 'get-media-init'), (err) => err.message === message);
        assert.equal(requests, 1, message);
    }
});

test('socketRequest keeps the phase tag when a server response carries its own phase field', async () => {
    const { socketRequest } = await loadClientModule();
    const socket = new FakeSocket({
        onRequest(_event, _payload, callback) {
            callback({ success: false, error: 'Room is full', phase: 'connect' });
        },
    });

    await assert.rejects(
        socketRequest(socket, 'get-media-init'),
        (err) => err.message === 'Room is full' && err.phase === 'server',
    );
});

test('socketRequest tags an empty acknowledgement as a server failure and does not retry it', async () => {
    const { socketRequest } = await loadClientModule();
    let requests = 0;
    const socket = new FakeSocket({
        onRequest(_event, _payload, callback) {
            requests += 1;
            callback(undefined);
        },
    });

    await assert.rejects(
        socketRequest(socket, 'get-media-init'),
        (err) => /empty response/.test(err.message) && err.phase === 'server',
    );
    assert.equal(requests, 1);
});

test('socketRequest still retries get-media-init after an acknowledgement timeout', async () => {
    const { socketRequest } = await loadClientModule();
    let requests = 0;
    const socket = new FakeSocket({
        onRequest(_event, _payload, callback) {
            requests += 1;
            if (requests === 2) callback({ success: true, initSegment: 'abc' });
        },
    });

    const response = await socketRequest(socket, 'get-media-init', { format: 'fmp4' }, { timeoutMs: 10 });

    assert.equal(response.initSegment, 'abc');
    assert.equal(requests, 2);
});

test('socketRequest still retries get-media-init after a disconnect that follows the emit', async () => {
    const { socketRequest } = await loadClientModule();
    let requests = 0;
    const socket = new FakeSocket({
        onRequest(_event, _payload, callback) {
            requests += 1;
            if (requests === 1) {
                queueMicrotask(() => socket.emit('disconnect', 'transport close'));
                return;
            }
            callback({ success: true });
        },
    });

    await socketRequest(socket, 'get-media-init', {}, { timeoutMs: 100 });

    assert.equal(requests, 2);
});

test('socketRequest still retries reclaim-host and leave-room after a timeout, because the server handles them twice safely', async () => {
    const { socketRequest } = await loadClientModule();
    for (const event of ['reclaim-host', 'leave-room']) {
        let requests = 0;
        const socket = new FakeSocket({
            onRequest(_event, _payload, callback) {
                requests += 1;
                if (requests === 2) callback({ success: true });
            },
        });

        await socketRequest(socket, event, {}, { timeoutMs: 10 });
        assert.equal(requests, 2, event);
    }
});

test('socketRequest retries a connect failure before the emit for create-room and join-room', async () => {
    const { socketRequest } = await loadClientModule();
    for (const event of ['create-room', 'join-room']) {
        let requests = 0;
        let connectAttempts = 0;
        const socket = new FakeSocket({
            connected: false,
            onConnect(instance) {
                connectAttempts += 1;
                queueMicrotask(() => {
                    if (connectAttempts === 1) {
                        instance.emit('connect_error', new Error('websocket error'));
                        return;
                    }
                    instance.connected = true;
                    instance.emit('connect');
                });
            },
            onRequest(_event, _payload, callback) {
                requests += 1;
                callback({ success: true, code: 'ABC123' });
            },
        });

        const response = await socketRequest(socket, event, {}, { connectTimeoutMs: 20 });

        assert.equal(response.code, 'ABC123', event);
        assert.equal(requests, 1, `${event} must be emitted once`);
        assert.ok(connectAttempts >= 2, `${event} must have reconnected`);
    }
});

test('socketRequest tags a failed connect with the connect phase', async () => {
    const { socketRequest } = await loadClientModule();
    const socket = new FakeSocket({
        connected: false,
        onConnect(instance) {
            queueMicrotask(() => instance.emit('connect_error', new Error('websocket error')));
        },
    });

    await assert.rejects(
        socketRequest(socket, 'create-room', {}, { connectTimeoutMs: 10 }),
        (err) => /cannot reach the Nextra server/.test(err.message) && err.phase === 'connect',
    );
});

test('socketRequest tags a connect that never reports an error with the connect phase', async () => {
    const { socketRequest } = await loadClientModule();
    const socket = new FakeSocket({ connected: false });

    await assert.rejects(
        socketRequest(socket, 'get-rtp-capabilities', {}, { connectTimeoutMs: 10 }),
        (err) => err.message === 'Socket is not connected' && err.phase === 'connect',
    );
});
