const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const { findRoomBySocket, destroyRoom, getRoomCount } = require('../lib/rooms');
const { registerSocketHandlers, stopJoinCleanup } = require('../lib/socket');

function request(client, event, data = {}) {
    return new Promise((resolve) => client.emit(event, data, resolve));
}

test('room creation authorization runs before validation, capacity, or replacement', { concurrency: false }, async () => {
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer, {}, {
        authorizeCreateRoom: (_socket, data) => data.operatorToken === 'approved-operator-capability',
    });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    const client = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    await new Promise((resolve) => client.once('connect', resolve));
    const baselineRooms = getRoomCount();
    let room = null;

    try {
        const unauthorized = await request(client, 'create-room', {
            operatorToken: 'wrong',
            passphrase: 'x'.repeat(256),
        });
        assert.equal(unauthorized.success, false);
        assert.match(unauthorized.error, /Operator authorization/);
        assert.equal(getRoomCount(), baselineRooms);

        const created = await request(client, 'create-room', {
            operatorToken: 'approved-operator-capability',
        });
        assert.equal(created.success, true);
        room = findRoomBySocket(client.id);
        assert.equal(getRoomCount(), baselineRooms + 1);

        const replacementDenied = await request(client, 'create-room', {
            operatorToken: 'wrong',
        });
        assert.equal(replacementDenied.success, false);
        assert.equal(findRoomBySocket(client.id)?.code, room.code);
        assert.equal(getRoomCount(), baselineRooms + 1);
    } finally {
        client.close();
        if (room) destroyRoom(room.code);
        stopJoinCleanup();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    }
});
