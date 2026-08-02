const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const { findRoomBySocket, destroyRoom } = require('../lib/rooms');
const { registerSocketHandlers, stopJoinCleanup } = require('../lib/socket');

function request(client, event, data = {}) {
    return new Promise((resolve) => client.emit(event, data, resolve));
}

test('socket transports pass explicit host and viewer bandwidth purposes', { concurrency: false }, async () => {
    const purposes = [];
    let nextId = 0;
    const createTransport = async (_router, options) => {
        purposes.push(options?.purpose);
        const transport = new EventEmitter();
        transport.id = `transport-${++nextId}`;
        transport.iceParameters = {};
        transport.iceCandidates = [];
        transport.dtlsParameters = {};
        transport.close = () => transport.emit('close');
        return {
            transport,
            params: {
                id: transport.id,
                iceParameters: {},
                iceCandidates: [],
                dtlsParameters: {},
            },
        };
    };
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer, {}, { createWebRtcTransport: createTransport });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    const host = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    const viewer = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    await Promise.all([
        new Promise((resolve) => host.once('connect', resolve)),
        new Promise((resolve) => viewer.once('connect', resolve)),
    ]);
    let room = null;

    try {
        const created = await request(host, 'create-room');
        assert.equal(created.success, true);
        room = findRoomBySocket(host.id);
        assert.equal((await request(viewer, 'join-room', { code: created.code })).success, true);
        assert.equal((await request(host, 'create-send-transport')).success, true);
        assert.equal((await request(viewer, 'create-recv-transport')).success, true);
        assert.deepEqual(purposes, ['host', 'viewer']);
    } finally {
        host.close();
        viewer.close();
        if (room) destroyRoom(room.code);
        stopJoinCleanup();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    }
});
