const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mediasoup = require('mediasoup');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const { findRoomBySocket } = require('../lib/rooms');
const {
    __testing,
    destroyRoomWithReason,
    registerSocketHandlers,
    stopJoinCleanup,
} = require('../lib/socket');

// The socket handlers mark a transport they close themselves so its last state change is not
// taken for a media failure, and must forget it once the transport has closed. These tests use
// real mediasoup transports, because the point is which emitter mediasoup reports the close on.
// They are DirectTransports, which bind no ports; mediasoup reports close the same way for every
// transport type (the Transport base class), WebRtcTransports included.

let worker = null;

before(async () => {
    worker = await mediasoup.createWorker({ logLevel: 'error' });
});

after(() => {
    worker?.close();
});

function request(client, event, data = {}) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), 3_000);
        client.emit(event, data, (response) => {
            clearTimeout(timeout);
            resolve(response);
        });
    });
}

async function waitFor(predicate, label) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

/** A host with a room and a joined viewer, on a real socket.io server and a real mediasoup router. */
async function withRoom(callback) {
    const router = await worker.createRouter({ mediaCodecs: [] });
    const transports = [];
    const createWebRtcTransport = async () => {
        const transport = await router.createDirectTransport();
        transports.push(transport);
        return {
            transport,
            params: { id: transport.id, iceParameters: {}, iceCandidates: [], dtlsParameters: {} },
        };
    };
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer, router, { createWebRtcTransport });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${httpServer.address().port}`;
    const clients = [];
    const connect = async () => {
        const client = createClient(url, { transports: ['websocket'] });
        clients.push(client);
        await new Promise((resolve) => client.once('connect', resolve));
        return client;
    };
    let room = null;
    const baselineIgnored = __testing.getIgnoredTransportCount();

    try {
        const host = await connect();
        const created = await request(host, 'create-room');
        assert.equal(created.success, true);
        room = findRoomBySocket(host.id);
        const viewer = await connect();
        assert.equal((await request(viewer, 'join-room', { code: created.code })).success, true);

        await callback({ router, transports, ioServer, host, viewer, room, baselineIgnored });
    } finally {
        clients.forEach((client) => client.close());
        if (room) destroyRoomWithReason(ioServer, room.code, null);
        stopJoinCleanup();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
        router.close();
    }
}

test('mediasoup reports a closed transport on its observer, not on the transport', async () => {
    const router = await worker.createRouter({ mediaCodecs: [] });
    try {
        const transport = await router.createDirectTransport();
        const seen = [];
        transport.on('close', () => seen.push('transport'));
        transport.observer.on('close', () => seen.push('observer'));
        transport.close();
        assert.deepEqual(seen, ['observer']);
    } finally {
        router.close();
    }
});

test('a receive transport closed when its viewer leaves is dropped from the ignore list', { concurrency: false }, async () => {
    await withRoom(async ({ transports, viewer, baselineIgnored }) => {
        assert.equal((await request(viewer, 'create-recv-transport')).success, true);
        assert.equal((await request(viewer, 'leave-room')).success, true);

        assert.equal(transports[0].closed, true);
        assert.equal(__testing.getIgnoredTransportCount(), baselineIgnored, 'a closed transport leaves nothing in the ignore list');
    });
});

test('receive transports replaced by a new one or closed on disconnect are dropped from the ignore list', { concurrency: false }, async () => {
    await withRoom(async ({ transports, ioServer, viewer, baselineIgnored }) => {
        assert.equal((await request(viewer, 'create-recv-transport')).success, true);
        assert.equal((await request(viewer, 'create-recv-transport')).success, true);
        assert.equal(transports[0].closed, true, 'the first receive transport is replaced');
        assert.equal(__testing.getIgnoredTransportCount(), baselineIgnored);

        const viewerId = viewer.id;
        viewer.close();
        await waitFor(() => !ioServer.sockets.sockets.has(viewerId), 'the server to see the viewer leave');
        await waitFor(() => transports[1].closed, 'the second receive transport to close');
        assert.equal(__testing.getIgnoredTransportCount(), baselineIgnored);
    });
});

test('a host send transport replaced by create-send-transport is dropped from the ignore list', { concurrency: false }, async () => {
    await withRoom(async ({ transports, host, room, baselineIgnored }) => {
        assert.equal((await request(host, 'create-send-transport')).success, true);
        assert.equal((await request(host, 'create-send-transport')).success, true);

        assert.equal(transports[0].closed, true);
        assert.equal(room.hostTransport, transports[1]);
        assert.equal(__testing.getIgnoredTransportCount(), baselineIgnored);
    });
});

test('destroying a room drops its host and viewer transports from the ignore list', { concurrency: false }, async () => {
    await withRoom(async ({ transports, ioServer, host, viewer, room, baselineIgnored }) => {
        assert.equal((await request(host, 'create-send-transport')).success, true);
        assert.equal((await request(viewer, 'create-recv-transport')).success, true);

        destroyRoomWithReason(ioServer, room.code, 'Host stopped sharing');

        assert.deepEqual(transports.map((transport) => transport.closed), [true, true]);
        assert.equal(__testing.getIgnoredTransportCount(), baselineIgnored);
    });
});

test('transports already closed by their router are not added to the ignore list when the room is destroyed', { concurrency: false }, async () => {
    await withRoom(async ({ router, transports, ioServer, host, viewer, room, baselineIgnored }) => {
        assert.equal((await request(host, 'create-send-transport')).success, true);
        assert.equal((await request(viewer, 'create-recv-transport')).success, true);

        // What a router closing under the room (a worker death) does before the room is torn down.
        router.close();
        assert.deepEqual(transports.map((transport) => transport.closed), [true, true]);
        destroyRoomWithReason(ioServer, room.code, 'Media server restarted');

        assert.equal(__testing.getIgnoredTransportCount(), baselineIgnored);
    });
});
