const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const {
    createRoom,
    destroyRoom,
    findRoomBySocket,
    joinRoom,
} = require('../lib/rooms');
const { __testing, registerSocketHandlers, stopJoinCleanup } = require('../lib/socket');

function request(client, event, data = {}) {
    return new Promise((resolve) => client.emit(event, data, resolve));
}

test('viewer transport failure is recoverable and keeps room membership', { concurrency: false }, () => {
    const room = createRoom('host-recovery');
    const viewerSocketId = 'viewer-recovery';
    joinRoom(room.code, viewerSocketId);

    const emittedToSocket = [];
    const emittedToRoom = [];
    const socket = {
        id: viewerSocketId,
        emit: (event, payload) => emittedToSocket.push({ event, payload }),
    };
    const io = {
        to: (target) => ({
            emit: (event, payload) => emittedToRoom.push({ target, event, payload }),
        }),
    };

    let transportClosed = false;
    let consumerClosed = false;
    const transport = {
        id: 'recv-transport-recovery',
        close: () => { transportClosed = true; },
    };
    const consumer = {
        close: () => { consumerClosed = true; },
    };
    room.viewerTransports.set(viewerSocketId, {
        recvTransport: transport,
        consumers: [consumer],
    });

    try {
        const handled = __testing.handleViewerTransportFailure(
            io,
            socket,
            room.code,
            transport.id,
            'ice',
            'failed'
        );

        assert.equal(handled, true);
        assert.equal(findRoomBySocket(viewerSocketId)?.code, room.code);
        assert.equal(room.viewers.has(viewerSocketId), true);
        assert.equal(room.viewerTransports.has(viewerSocketId), true);
        assert.equal(room.viewerTransports.get(viewerSocketId).recvTransport, null);
        assert.deepEqual(room.viewerTransports.get(viewerSocketId).consumers, []);
        assert.equal(transportClosed, true);
        assert.equal(consumerClosed, true);
        assert.deepEqual(emittedToSocket, [{
            event: 'transport-failed',
            payload: {
                recoverable: true,
                reason: 'Stream connection interrupted. Reconnecting...',
            },
        }]);
        assert.equal(emittedToRoom.some(({ event }) => event === 'viewer-count'), false);
    } finally {
        destroyRoom(room.code);
    }
});

test('relay backpressure reads the installed Engine.IO write-buffer packet shape', { concurrency: false }, () => {
    const socket = {
        conn: {
            // Engine.IO 6 packets use a data property containing text or binary.
            writeBuffer: [
                { type: 'message', data: 'hello' },
                { type: 'message', data: Buffer.alloc(7) },
                { type: 'message', data: new Uint8Array(3) },
            ],
        },
    };

    assert.equal(__testing.getSocketBufferedBytes(socket), 15);
});

test('installed Engine.IO exposes the writeBuffer shape used by relay backpressure', { concurrency: false }, async () => {
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    const serverSocketPromise = new Promise((resolve) => ioServer.once('connection', resolve));
    const client = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });

    try {
        const serverSocket = await serverSocketPromise;
        assert.ok(Array.isArray(serverSocket.conn.writeBuffer));
        assert.equal(__testing.getSocketBufferedBytes(serverSocket), 0);
    } finally {
        client.close();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    }
});

test('missing Engine.IO writeBuffer logs one compatibility warning', { concurrency: false }, () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(message);
    __testing.resetEngineWriteBufferWarning();

    try {
        assert.equal(__testing.getSocketBufferedBytes({ conn: {} }), 0);
        assert.equal(__testing.getSocketBufferedBytes({ conn: {} }), 0);
    } finally {
        console.warn = originalWarn;
        __testing.resetEngineWriteBufferWarning();
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /writeBuffer is unavailable/);
});

test('opted-in reload reclaim resets stale browser media before capture resumes', { concurrency: false }, async () => {
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer, {});
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    const firstClient = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    await new Promise((resolve) => firstClient.once('connect', resolve));

    let producerClosed = false;
    let transportClosed = false;
    let room = null;
    let secondClient = null;
    try {
        const created = await request(firstClient, 'create-room', {
            ingestMode: 'browser',
            reloadRecoveryEnabled: true,
        });
        assert.equal(created.success, true);
        room = findRoomBySocket(firstClient.id);
        room.producer = { close: () => { producerClosed = true; } };
        room.hostTransport = { close: () => { transportClosed = true; } };

        firstClient.close();
        await new Promise((resolve) => setTimeout(resolve, 20));
        secondClient = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
        await new Promise((resolve) => secondClient.once('connect', resolve));
        const reclaimed = await request(secondClient, 'reclaim-host', {
            code: created.code,
            hostToken: created.hostToken,
            reloadRecovery: true,
        });

        assert.equal(reclaimed.success, true);
        assert.equal(producerClosed, true);
        assert.equal(transportClosed, true);
        assert.equal(room.producer, null);
        assert.equal(room.hostTransport, null);
    } finally {
        firstClient.close();
        secondClient?.close();
        if (room) destroyRoom(room.code);
        stopJoinCleanup();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    }
});
