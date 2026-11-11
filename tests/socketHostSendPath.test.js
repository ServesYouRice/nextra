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
    getSocketRuntimeMetrics,
    registerSocketHandlers,
    stopJoinCleanup,
} = require('../lib/socket');

const PRODUCE_PAYLOAD = { rtpParameters: { codecs: [], encodings: [] }, appData: {} };

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

function activeProducers() {
    return getSocketRuntimeMetrics().counters.activeProducers;
}

/**
 * A producer that behaves like mediasoup's: close() is idempotent and reports through the
 * observer only, and a closing transport ends it with 'transportclose'.
 */
function createFakeProducer(id, kind) {
    const producer = new EventEmitter();
    producer.observer = new EventEmitter();
    Object.assign(producer, { id, kind, closed: false, closeCalls: 0 });
    producer.close = () => {
        producer.closeCalls += 1;
        if (producer.closed) return;
        producer.closed = true;
        producer.observer.emit('close');
    };
    producer.transportClosed = () => {
        if (producer.closed) return;
        producer.closed = true;
        producer.emit('transportclose');
        producer.observer.emit('close');
    };
    return producer;
}

function createHarness(label) {
    const state = {
        transports: [],
        creates: [],
        deferCreates: false,
        produceCalls: [],
        producers: [],
        deferProduce: false,
    };
    let nextTransport = 0;
    let nextProducer = 0;

    const createWebRtcTransport = (_router, options) => {
        const transport = new EventEmitter();
        Object.assign(transport, {
            id: `${label}-transport-${++nextTransport}`,
            purpose: options?.purpose,
            closed: false,
            closeCalls: 0,
            producers: [],
            observer: new EventEmitter(),
        });
        // Like mediasoup's, the transport reports its close through the observer only.
        transport.close = () => {
            transport.closeCalls += 1;
            if (transport.closed) return;
            transport.closed = true;
            transport.producers.forEach((producer) => producer.transportClosed());
            transport.observer.emit('close');
        };
        transport.connect = async () => {};
        transport.produce = async (options) => {
            const call = { options, transport };
            state.produceCalls.push(call);
            if (state.deferProduce) {
                await new Promise((resolve) => { call.release = resolve; });
            }
            const producer = createFakeProducer(`${label}-producer-${++nextProducer}`, options.kind);
            call.producer = producer;
            state.producers.push(producer);
            transport.producers.push(producer);
            return producer;
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

async function withHost(label, callback) {
    const harness = createHarness(label);
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer, {}, { createWebRtcTransport: harness.createWebRtcTransport });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    const url = `http://127.0.0.1:${port}`;
    const clients = [];
    const connect = async () => {
        const client = createClient(url, { transports: ['websocket'] });
        clients.push(client);
        await new Promise((resolve) => client.once('connect', resolve));
        return client;
    };
    const host = await connect();
    const viewer = await connect();
    let room = null;
    const baselineProducers = activeProducers();
    const baselineIgnored = __testing.getIgnoredTransportCount();

    try {
        const created = await request(host, 'create-room');
        assert.equal(created.success, true);
        room = findRoomBySocket(host.id);
        assert.equal((await request(viewer, 'join-room', { code: created.code })).success, true);
        const newProducers = [];
        viewer.on('new-producer', (event) => newProducers.push(event));

        await callback({
            ...harness,
            ioServer,
            host,
            viewer,
            room,
            created,
            connect,
            newProducers,
            baselineProducers,
            baselineIgnored,
        });
    } finally {
        clients.forEach((client) => client.close());
        if (room) destroyRoomWithReason(ioServer, room.code, null);
        stopJoinCleanup();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    }
}

function openTransports(state) {
    return state.transports.filter((transport) => !transport.closed);
}

for (const order of ['in order', 'out of order']) {
    test(`overlapping create-send-transport calls resolving ${order} leave one open host transport`, { concurrency: false }, async () => {
        await withHost(`overlap-${order.replace(' ', '-')}`, async ({ state, host, room, baselineIgnored }) => {
            state.deferCreates = true;
            const first = request(host, 'create-send-transport');
            const second = request(host, 'create-send-transport');
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
            assert.equal(state.transports.length, 2);
            const open = openTransports(state);
            assert.equal(open.length, 1, 'exactly one host transport stays open');
            assert.equal(room.hostTransport, open[0], 'the open transport is the one the room holds');
            // The one that resolved last wins; the other one is closed, not orphaned.
            assert.equal(open[0], order === 'in order' ? secondCreate.transport : firstCreate.transport);
            assert.equal(__testing.getIgnoredTransportCount(), baselineIgnored, 'a closed transport leaves nothing in the ignore list');
        });
    });
}

test('a single create-send-transport still closes the old producers and transport and returns its parameters', { concurrency: false }, async () => {
    await withHost('single', async ({ state, host, room, newProducers }) => {
        const first = await request(host, 'create-send-transport');
        assert.equal(first.success, true);
        assert.equal(first.params.id, state.transports[0].id);
        assert.ok(Array.isArray(first.iceServers));
        assert.equal((await request(host, 'produce', { kind: 'video', ...PRODUCE_PAYLOAD })).success, true);
        assert.equal((await request(host, 'produce', { kind: 'audio', ...PRODUCE_PAYLOAD })).success, true);
        await waitFor(() => newProducers.length === 2, 'both new-producer events');

        const second = await request(host, 'create-send-transport');
        assert.equal(second.success, true);
        assert.equal(second.params.id, state.transports[1].id);
        assert.deepEqual(state.producers.map((producer) => producer.closed), [true, true]);
        assert.equal(state.transports[0].closed, true);
        assert.equal(state.transports[1].closed, false);
        assert.equal(room.hostTransport, state.transports[1]);
        assert.equal(room.producer, null);
        assert.equal(room.audioProducer, null);
    });
});

test('create-send-transport stores nothing and closes its transport when the host socket left during the await', { concurrency: false }, async () => {
    await withHost('left', async ({ state, ioServer, host, room }) => {
        const hostId = host.id;
        state.deferCreates = true;
        host.emit('create-send-transport', {}, () => {});
        await waitFor(() => state.creates.length === 1, 'the transport being created');

        host.close();
        await waitFor(() => !ioServer.sockets.sockets.has(hostId), 'the server to see the host leave');
        state.creates[0].release();
        await waitFor(() => state.transports[0].closed, 'the stale transport to be closed');

        assert.equal(room.hostTransport, null);
        assert.equal(openTransports(state).length, 0);
    });
});

test('create-send-transport reports failure and closes its transport when another socket reclaimed the room during the await', { concurrency: false }, async () => {
    await withHost('reclaimed', async ({ state, host, room, created, connect, baselineIgnored }) => {
        state.deferCreates = true;
        const pending = request(host, 'create-send-transport');
        await waitFor(() => state.creates.length === 1, 'the transport being created');

        const other = await connect();
        const reclaimed = await request(other, 'reclaim-host', { code: created.code, hostToken: created.hostToken });
        assert.equal(reclaimed.success, true);
        assert.equal(room.hostSocketId, other.id);

        state.creates[0].release();
        const response = await pending;

        assert.equal(response.success, false);
        assert.equal(state.transports[0].closed, true);
        assert.equal(room.hostTransport, null);
        assert.equal(__testing.getIgnoredTransportCount(), baselineIgnored);
    });
});

for (const kind of ['video', 'audio']) {
    const slot = kind === 'video' ? 'producer' : 'audioProducer';

    test(`a repeated ${kind} produce closes the producer it supersedes`, { concurrency: false }, async () => {
        await withHost(`repeat-${kind}`, async ({ state, host, room, newProducers, baselineProducers }) => {
            assert.equal((await request(host, 'create-send-transport')).success, true);

            const first = await request(host, 'produce', { kind, ...PRODUCE_PAYLOAD });
            assert.equal(first.success, true);
            assert.equal(activeProducers(), baselineProducers + 1);
            const second = await request(host, 'produce', { kind, ...PRODUCE_PAYLOAD });
            assert.equal(second.success, true);
            assert.notEqual(second.producerId, first.producerId);

            const [firstProducer, secondProducer] = state.producers;
            assert.equal(firstProducer.id, first.producerId);
            assert.equal(firstProducer.closed, true, 'the superseded producer is closed');
            assert.equal(secondProducer.closed, false);
            assert.equal(room[slot], secondProducer);
            assert.equal(activeProducers(), baselineProducers + 1, 'only the surviving producer counts as active');
            await waitFor(() => newProducers.length === 2, 'both new-producer events');
            assert.deepEqual(newProducers.map((event) => event.producerId), [first.producerId, second.producerId]);
        });
    });
}

test('a produce of the other kind leaves the existing producer alone', { concurrency: false }, async () => {
    await withHost('other-kind', async ({ state, host, room, baselineProducers }) => {
        assert.equal((await request(host, 'create-send-transport')).success, true);
        assert.equal((await request(host, 'produce', { kind: 'video', ...PRODUCE_PAYLOAD })).success, true);
        assert.equal((await request(host, 'produce', { kind: 'audio', ...PRODUCE_PAYLOAD })).success, true);

        assert.deepEqual(state.producers.map((producer) => producer.closed), [false, false]);
        assert.equal(room.producer, state.producers[0]);
        assert.equal(room.audioProducer, state.producers[1]);
        assert.equal(activeProducers(), baselineProducers + 2);
    });
});

test('a produce that resolves after the send transport was replaced is closed and not published', { concurrency: false }, async () => {
    await withHost('replaced', async ({ state, host, room, newProducers, baselineProducers }) => {
        assert.equal((await request(host, 'create-send-transport')).success, true);
        state.deferProduce = true;
        const pending = request(host, 'produce', { kind: 'video', ...PRODUCE_PAYLOAD });
        await waitFor(() => state.produceCalls.length === 1, 'the produce call');

        state.deferProduce = false;
        assert.equal((await request(host, 'create-send-transport')).success, true);
        assert.equal(state.transports[0].closed, true);
        state.produceCalls[0].release();
        const response = await pending;

        assert.equal(response.success, false);
        assert.equal(state.producers.length, 1);
        assert.equal(state.producers[0].closed, true, 'the producer made on the replaced transport is closed');
        assert.equal(room.producer, null);
        assert.equal(room.hostTransport, state.transports[1]);
        assert.equal(activeProducers(), baselineProducers);
        await sleep(30);
        assert.deepEqual(newProducers, []);
    });
});

test('a produce that resolves after another socket reclaimed the room is closed and not published', { concurrency: false }, async () => {
    await withHost('produce-reclaimed', async ({ state, host, room, created, connect, newProducers, baselineProducers }) => {
        assert.equal((await request(host, 'create-send-transport')).success, true);
        state.deferProduce = true;
        const pending = request(host, 'produce', { kind: 'audio', ...PRODUCE_PAYLOAD });
        await waitFor(() => state.produceCalls.length === 1, 'the produce call');

        const other = await connect();
        assert.equal((await request(other, 'reclaim-host', { code: created.code, hostToken: created.hostToken })).success, true);
        state.produceCalls[0].release();
        const response = await pending;

        assert.equal(response.success, false);
        assert.equal(state.producers[0].closed, true);
        assert.equal(room.audioProducer, null);
        assert.equal(activeProducers(), baselineProducers);
        await sleep(30);
        assert.deepEqual(newProducers, []);
    });
});
