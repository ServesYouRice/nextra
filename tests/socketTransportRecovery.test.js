const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createRoom,
    destroyRoom,
    findRoomBySocket,
    joinRoom,
} = require('../lib/rooms');
const { __testing } = require('../lib/socket');

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
