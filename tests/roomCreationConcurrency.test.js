const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const config = require('../config');
const {
    prepareRoom,
    findRoomBySocket,
    getRoomCount,
    destroyRoom,
} = require('../lib/rooms');
const { __testing, registerSocketHandlers, stopJoinCleanup } = require('../lib/socket');

function request(client, event, data = {}) {
    return new Promise((resolve) => client.emit(event, data, resolve));
}

function waitFor(predicate, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (predicate()) {
                resolve();
                return;
            }
            if (Date.now() >= deadline) {
                reject(new Error('condition timed out'));
                return;
            }
            setTimeout(poll, 5);
        };
        poll();
    });
}

test('pending room reservations bound capacity, duplicates, failure, disconnect, and replacement', { concurrency: false }, async () => {
    const previousMaxRooms = config.MAX_ACTIVE_ROOMS;
    const baselineRooms = getRoomCount();
    config.MAX_ACTIVE_ROOMS = baselineRooms + 1;
    let mode = 'defer';
    let releaseDeferred = null;
    let enteredDeferred = null;
    const deferredEntered = () => new Promise((resolve) => { enteredDeferred = resolve; });
    const prepareForTest = async (hostSocketId, options) => {
        if (mode === 'fail') {
            return prepareRoom(hostSocketId, {
                ...options,
                passphrase: options.passphrase || 'hash failure',
                scrypt: (_passphrase, _salt, _length, callback) => {
                    setImmediate(() => callback(new Error('injected scrypt failure')));
                },
            });
        }
        if (mode === 'defer') {
            enteredDeferred?.();
            enteredDeferred = null;
            await new Promise((resolve) => { releaseDeferred = resolve; });
        }
        return prepareRoom(hostSocketId, options);
    };
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer, {}, { prepareRoom: prepareForTest });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    const first = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    const second = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    await Promise.all([
        new Promise((resolve) => first.once('connect', resolve)),
        new Promise((resolve) => second.once('connect', resolve)),
    ]);
    let room = null;

    try {
        const firstEntered = deferredEntered();
        const firstCreate = request(first, 'create-room', { passphrase: 'protected' });
        await firstEntered;
        assert.equal(__testing.getPendingRoomCreationCount(), 1);

        const duplicate = await request(first, 'create-room');
        assert.equal(duplicate.success, false);
        assert.match(duplicate.error, /already in progress/);
        const overCapacity = await request(second, 'create-room');
        assert.equal(overCapacity.success, false);
        assert.match(overCapacity.error, /capacity/);
        assert.equal(getRoomCount(), baselineRooms);

        releaseDeferred();
        const created = await firstCreate;
        assert.equal(created.success, true);
        room = findRoomBySocket(first.id);
        assert.equal(getRoomCount(), baselineRooms + 1);
        assert.equal(__testing.getPendingRoomCreationCount(), 0);

        mode = 'fail';
        const replacementFailure = await request(first, 'create-room', { passphrase: 'fail hashing' });
        assert.equal(replacementFailure.success, false);
        assert.equal(findRoomBySocket(first.id)?.code, room.code);
        assert.equal(getRoomCount(), baselineRooms + 1);
        assert.equal(__testing.getPendingRoomCreationCount(), 0);

        assert.deepEqual(await request(first, 'leave-room'), { success: true });
        room = null;
        assert.equal(getRoomCount(), baselineRooms);

        mode = 'defer';
        const disconnectEntered = deferredEntered();
        request(second, 'create-room', { passphrase: 'disconnect hashing' });
        await disconnectEntered;
        assert.equal(__testing.getPendingRoomCreationCount(), 1);
        second.close();
        await waitFor(() => __testing.getPendingRoomCreationCount() === 0);
        releaseDeferred();
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(getRoomCount(), baselineRooms);
    } finally {
        releaseDeferred?.();
        first.close();
        second.close();
        if (room) destroyRoom(room.code);
        config.MAX_ACTIVE_ROOMS = previousMaxRooms;
        stopJoinCleanup();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    }
});
