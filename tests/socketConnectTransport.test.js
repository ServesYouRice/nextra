const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const { findRoomBySocket, destroyRoom } = require('../lib/rooms');
const { registerSocketHandlers, stopJoinCleanup } = require('../lib/socket');

function request(client, event, data = {}) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), 3_000);
        client.emit(event, data, (response) => {
            clearTimeout(timeout);
            resolve(response);
        });
    });
}

function dtls(value) {
    return { role: 'client', fingerprints: [{ algorithm: 'sha-256', value }] };
}

test('only the host can connect the host send transport', { concurrency: false }, async () => {
    const connectCalls = new Map();
    let nextId = 0;
    const createTransport = async () => {
        const transport = new EventEmitter();
        transport.id = `transport-${++nextId}`;
        transport.close = () => transport.emit('close');
        transport.connect = async ({ dtlsParameters }) => {
            const calls = connectCalls.get(transport.id) || [];
            calls.push(dtlsParameters);
            connectCalls.set(transport.id, calls);
        };
        return {
            transport,
            params: { id: transport.id, iceParameters: {}, iceCandidates: [], dtlsParameters: {} },
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
        const send = await request(host, 'create-send-transport');
        assert.equal(send.success, true);
        const recv = await request(viewer, 'create-recv-transport');
        assert.equal(recv.success, true);

        // A viewer that learns the host's transport id must not be able to
        // connect it with its own DTLS parameters.
        const hijack = await request(viewer, 'connect-transport', {
            transportId: send.params.id,
            dtlsParameters: dtls('viewer-fingerprint'),
        });
        assert.equal(hijack.success, false);
        assert.equal(connectCalls.has(send.params.id), false);

        const hostConnect = await request(host, 'connect-transport', {
            transportId: send.params.id,
            dtlsParameters: dtls('host-fingerprint'),
        });
        assert.equal(hostConnect.success, true);
        assert.deepEqual(connectCalls.get(send.params.id), [dtls('host-fingerprint')]);

        const viewerConnect = await request(viewer, 'connect-transport', {
            transportId: recv.params.id,
            dtlsParameters: dtls('viewer-fingerprint'),
        });
        assert.equal(viewerConnect.success, true);
        assert.deepEqual(connectCalls.get(recv.params.id), [dtls('viewer-fingerprint')]);
    } finally {
        host.close();
        viewer.close();
        if (room) destroyRoom(room.code);
        stopJoinCleanup();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    }
});
