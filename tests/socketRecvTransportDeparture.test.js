const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const { findRoomBySocket } = require('../lib/rooms');
const {
    __testing,
    destroyRoomWithReason,
    registerSocketHandlers,
    stopJoinCleanup,
} = require('../lib/socket');

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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A fake mediasoup transport factory whose allocation can be held back: while
 * state.deferCreates is set, each call waits until its entry in state.creates is released.
 */
function createHarness(label) {
    const state = { transports: [], creates: [], deferCreates: false };
    let nextTransport = 0;

    const createWebRtcTransport = (_router, options) => {
        const transport = new EventEmitter();
        Object.assign(transport, {
            id: `${label}-transport-${++nextTransport}`,
            purpose: options?.purpose,
            closed: false,
            closeCalls: 0,
        });
        transport.close = () => {
            transport.closeCalls += 1;
            if (transport.closed) return;
            transport.closed = true;
            transport.emit('close');
        };
        state.transports.push(transport);
        const result = {
            transport,
            params: { id: transport.id, iceParameters: {}, iceCandidates: [], dtlsParameters: {} },
        };
        if (!state.deferCreates) return Promise.resolve(result);
        return new Promise((resolve) => {
            state.creates.push({ transport, release: () => resolve(result) });
        });
    };

    return { state, createWebRtcTransport };
}

/** A host with a room and one viewer that has joined it, on a real socket.io server. */
async function withViewer(label, callback) {
    const harness = createHarness(label);
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer, {}, { createWebRtcTransport: harness.createWebRtcTransport });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    const url = `http://127.0.0.1:${port}`;
    const clients = [];
    const rooms = [];
    const connect = async () => {
        const client = createClient(url, { transports: ['websocket'] });
        clients.push(client);
        await new Promise((resolve) => client.once('connect', resolve));
        return client;
    };
    const createRoomWithHost = async () => {
        const host = await connect();
        const created = await request(host, 'create-room');
        assert.equal(created.success, true);
        const room = findRoomBySocket(host.id);
        rooms.push(room);
        return { host, created, room };
    };
    const baselineIgnored = __testing.getIgnoredTransportCount();

    try {
        const { host, created, room } = await createRoomWithHost();
        const viewer = await connect();
        assert.equal((await request(viewer, 'join-room', { code: created.code })).success, true);

        await callback({
            ...harness,
            ioServer,
            host,
            viewer,
            room,
            created,
            connect,
            createRoomWithHost,
            baselineIgnored,
        });
    } finally {
        clients.forEach((client) => client.close());
        rooms.forEach((room) => destroyRoomWithReason(ioServer, room.code, null));
        stopJoinCleanup();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    }
}

function openTransports(state) {
    return state.transports.filter((transport) => !transport.closed);
}

test('create-recv-transport stores the transport and succeeds for a viewer that stays', { concurrency: false }, async () => {
    await withViewer('stays', async ({ state, viewer, room, baselineIgnored }) => {
        state.deferCreates = true;
        const pending = request(viewer, 'create-recv-transport');
        await waitFor(() => state.creates.length === 1, 'the transport being created');
        state.creates[0].release();
        const response = await pending;

        assert.equal(response.success, true);
        assert.equal(response.params.id, state.transports[0].id);
        assert.ok(Array.isArray(response.iceServers));
        assert.equal(state.transports[0].purpose, 'viewer');
        assert.equal(state.transports[0].closed, false);
        assert.equal(room.viewerTransports.get(viewer.id).recvTransport, state.transports[0]);
        assert.deepEqual(room.viewerTransports.get(viewer.id).consumers, []);
        assert.equal(__testing.getIgnoredTransportCount(), baselineIgnored);
    });
});

test('create-recv-transport stores nothing, closes its transport and fails when the viewer left the room during the await', { concurrency: false }, async () => {
    await withViewer('left', async ({ state, viewer, room, baselineIgnored }) => {
        state.deferCreates = true;
        const pending = request(viewer, 'create-recv-transport');
        await waitFor(() => state.creates.length === 1, 'the transport being created');

        assert.equal((await request(viewer, 'leave-room')).success, true);
        assert.equal(room.viewers.has(viewer.id), false);
        state.creates[0].release();
        const response = await pending;

        assert.deepEqual(response, { success: false, error: 'Not in a room.' });
        assert.equal(state.transports[0].closed, true, 'the allocated transport is closed');
        assert.equal(room.viewerTransports.has(viewer.id), false, 'no transport is stored for a viewer that left');
        assert.equal(openTransports(state).length, 0);
        assert.equal(__testing.getIgnoredTransportCount(), baselineIgnored, 'a closed transport leaves nothing in the ignore list');
    });
});

test('create-recv-transport stores nothing and closes its transport when the viewer disconnected during the await', { concurrency: false }, async () => {
    await withViewer('disconnected', async ({ state, ioServer, viewer, room, baselineIgnored }) => {
        const viewerId = viewer.id;
        state.deferCreates = true;
        viewer.emit('create-recv-transport', {}, () => {});
        await waitFor(() => state.creates.length === 1, 'the transport being created');

        viewer.close();
        await waitFor(() => !ioServer.sockets.sockets.has(viewerId), 'the server to see the viewer leave');
        assert.equal(room.viewers.has(viewerId), false);
        state.creates[0].release();
        await waitFor(() => state.transports[0].closed, 'the stale transport to be closed');

        assert.equal(room.viewerTransports.has(viewerId), false, 'no transport is stored for a viewer that disconnected');
        assert.equal(openTransports(state).length, 0);
        assert.equal(__testing.getIgnoredTransportCount(), baselineIgnored);
    });
});

test('create-recv-transport fails and stores nothing in either room when the viewer moved to another room during the await', { concurrency: false }, async () => {
    await withViewer('moved', async ({ state, viewer, room, createRoomWithHost, baselineIgnored }) => {
        const other = await createRoomWithHost();
        state.deferCreates = true;
        const pending = request(viewer, 'create-recv-transport');
        await waitFor(() => state.creates.length === 1, 'the transport being created');

        assert.equal((await request(viewer, 'leave-room')).success, true);
        assert.equal((await request(viewer, 'join-room', { code: other.created.code })).success, true);
        assert.equal(findRoomBySocket(viewer.id), other.room);
        state.creates[0].release();
        const response = await pending;

        assert.deepEqual(response, { success: false, error: 'Not in a room.' });
        assert.equal(state.transports[0].closed, true);
        assert.equal(room.viewerTransports.has(viewer.id), false);
        assert.equal(other.room.viewerTransports.has(viewer.id), false);
        assert.equal(__testing.getIgnoredTransportCount(), baselineIgnored);
    });
});

test('create-recv-transport fails and closes its transport when the room was destroyed during the await', { concurrency: false }, async () => {
    await withViewer('destroyed', async ({ state, ioServer, viewer, room, baselineIgnored }) => {
        state.deferCreates = true;
        const pending = request(viewer, 'create-recv-transport');
        await waitFor(() => state.creates.length === 1, 'the transport being created');

        destroyRoomWithReason(ioServer, room.code, 'Host stopped sharing');
        assert.equal(findRoomBySocket(viewer.id), null);
        state.creates[0].release();
        const response = await pending;

        assert.deepEqual(response, { success: false, error: 'Not in a room.' });
        assert.equal(state.transports[0].closed, true);
        assert.equal(room.viewerTransports.has(viewer.id), false);
        assert.equal(__testing.getIgnoredTransportCount(), baselineIgnored);
    });
});

for (const order of ['in order', 'out of order']) {
    test(`overlapping create-recv-transport calls resolving ${order} still leave one open transport`, { concurrency: false }, async () => {
        await withViewer(`overlap-${order.replace(' ', '-')}`, async ({ state, viewer, room, baselineIgnored }) => {
            state.deferCreates = true;
            const first = request(viewer, 'create-recv-transport');
            const second = request(viewer, 'create-recv-transport');
            await waitFor(() => state.creates.length === 2, 'both transports being created');

            const [firstCreate, secondCreate] = state.creates;
            if (order === 'in order') {
                firstCreate.release();
                await sleep(20);
                secondCreate.release();
            } else {
                secondCreate.release();
                await sleep(20);
                firstCreate.release();
            }
            const responses = await Promise.all([first, second]);

            assert.deepEqual(responses.map((response) => response.success), [true, true]);
            const open = openTransports(state);
            assert.equal(open.length, 1, 'exactly one receive transport stays open');
            assert.equal(room.viewerTransports.get(viewer.id).recvTransport, open[0]);
            assert.equal(open[0], order === 'in order' ? secondCreate.transport : firstCreate.transport);
            assert.equal(__testing.getIgnoredTransportCount(), baselineIgnored);
        });
    });
}
