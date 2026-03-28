const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createRoom,
    joinRoom,
    findRoomByCode,
    findRoomByHost,
    findRoomBySocket,
    reclaimHostRoom,
    removeViewer,
    destroyRoom,
    startRoomCleanup,
    stopRoomCleanup,
} = require('../lib/rooms');
const config = require('../config');

test('room lifecycle tracks host and viewer membership', { concurrency: false }, () => {
    const room = createRoom('host-a');

    try {
        assert.equal(findRoomByCode(room.code)?.code, room.code);
        assert.equal(findRoomByHost('host-a')?.code, room.code);

        const joinedRoom = joinRoom(room.code, 'viewer-a');
        assert.equal(joinedRoom?.code, room.code);
        assert.equal(findRoomBySocket('viewer-a')?.code, room.code);

        const updatedRoom = removeViewer('viewer-a');
        assert.equal(updatedRoom?.code, room.code);
        assert.equal(findRoomBySocket('viewer-a'), null);
    } finally {
        destroyRoom(room.code);
    }
});

test('reclaimHostRoom swaps host ownership using the host token', { concurrency: false }, () => {
    const room = createRoom('host-old');

    try {
        const reclaimedRoom = reclaimHostRoom(room.code, 'host-new', room.hostToken);
        assert.equal(reclaimedRoom?.code, room.code);
        assert.equal(findRoomByHost('host-old'), null);
        assert.equal(findRoomByHost('host-new')?.code, room.code);
    } finally {
        destroyRoom(room.code);
    }
});

test('startRoomCleanup can delegate stale-room teardown to a callback', { concurrency: false }, async () => {
    const room = createRoom('host-stale');
    const previousInterval = config.ROOM_HEARTBEAT_INTERVAL_MS;
    const previousTimeout = config.ROOM_STALE_TIMEOUT_MS;
    const cleanedRooms = [];

    try {
        config.ROOM_HEARTBEAT_INTERVAL_MS = 10;
        config.ROOM_STALE_TIMEOUT_MS = 5;
        room.lastHeartbeat = Date.now() - 1000;

        startRoomCleanup({
            onStaleRoom: (staleRoom) => {
                cleanedRooms.push(staleRoom.code);
                destroyRoom(staleRoom.code);
                return true;
            },
        });

        await new Promise((resolve) => setTimeout(resolve, 40));

        assert.deepEqual(cleanedRooms, [room.code]);
        assert.equal(findRoomByCode(room.code), null);
    } finally {
        stopRoomCleanup();
        config.ROOM_HEARTBEAT_INTERVAL_MS = previousInterval;
        config.ROOM_STALE_TIMEOUT_MS = previousTimeout;
        destroyRoom(room.code);
    }
});
