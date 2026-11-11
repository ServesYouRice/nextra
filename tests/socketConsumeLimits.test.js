const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const { findRoomBySocket, destroyRoom } = require('../lib/rooms');
const {
    getSocketRuntimeMetrics,
    registerSocketHandlers,
    stopJoinCleanup,
} = require('../lib/socket');

const VIDEO_PRODUCER_ID = 'consume-limits-video-producer';
const AUDIO_PRODUCER_ID = 'consume-limits-audio-producer';
const RTP_CAPABILITIES = { codecs: [] };

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

function activeConsumers() {
    return getSocketRuntimeMetrics().counters.activeConsumers;
}

/** A consumer that behaves like mediasoup's: close() is idempotent and fires the observer. */
function createFakeConsumer(id, { producerId, kind }) {
    const consumer = new EventEmitter();
    consumer.observer = new EventEmitter();
    Object.assign(consumer, {
        id,
        producerId,
        kind,
        rtpParameters: { codecs: [], encodings: [{ ssrc: 1 }] },
        closed: false,
        closeCalls: 0,
        resumeCalls: 0,
    });
    consumer.close = () => {
        consumer.closeCalls += 1;
        if (consumer.closed) return;
        consumer.closed = true;
        consumer.observer.emit('close');
    };
    consumer.resume = async () => { consumer.resumeCalls += 1; };
    consumer.setPriority = async () => {};
    return consumer;
}

function createHarness(label) {
    const state = {
        consumers: [],
        consumeCalls: [],
        deferConsume: false,
        transports: [],
    };
    let nextTransport = 0;
    let nextConsumer = 0;

    const createWebRtcTransport = async () => {
        const transport = new EventEmitter();
        transport.id = `${label}-transport-${++nextTransport}`;
        transport.close = () => transport.emit('close');
        transport.connect = async () => {};
        transport.consume = async (options) => {
            const call = { options };
            state.consumeCalls.push(call);
            if (state.deferConsume) {
                await new Promise((resolve) => { call.release = resolve; });
            }
            const kind = options.producerId === AUDIO_PRODUCER_ID ? 'audio' : 'video';
            const consumer = createFakeConsumer(`${label}-consumer-${++nextConsumer}`, {
                producerId: options.producerId,
                kind,
            });
            call.consumer = consumer;
            state.consumers.push(consumer);
            return consumer;
        };
        state.transports.push(transport);
        return {
            transport,
            params: { id: transport.id, iceParameters: {}, iceCandidates: [], dtlsParameters: {} },
        };
    };

    return { state, createWebRtcTransport };
}

async function withViewer(label, callback) {
    const harness = createHarness(label);
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    registerSocketHandlers(
        ioServer,
        { canConsume: () => true },
        { createWebRtcTransport: harness.createWebRtcTransport }
    );
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    const host = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    const viewer = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    await Promise.all([
        new Promise((resolve) => host.once('connect', resolve)),
        new Promise((resolve) => viewer.once('connect', resolve)),
    ]);
    let room = null;
    const baselineConsumers = activeConsumers();

    try {
        const created = await request(host, 'create-room');
        assert.equal(created.success, true);
        room = findRoomBySocket(host.id);
        room.producer = { id: VIDEO_PRODUCER_ID, kind: 'video', close() {} };
        room.audioProducer = { id: AUDIO_PRODUCER_ID, kind: 'audio', close() {} };
        assert.equal((await request(viewer, 'join-room', { code: created.code })).success, true);
        const recv = await request(viewer, 'create-recv-transport');
        assert.equal(recv.success, true);

        const consume = (producerId = VIDEO_PRODUCER_ID) => request(viewer, 'consume', {
            transportId: recv.params.id,
            producerId,
            rtpCapabilities: RTP_CAPABILITIES,
        });
        const viewerData = () => room.viewerTransports.get(viewer.id);

        await callback({
            harness,
            room,
            viewer,
            recv,
            consume,
            viewerData,
            liveCount: () => activeConsumers() - baselineConsumers,
        });
    } finally {
        // Release anything a failed assertion left waiting so teardown cannot hang.
        for (const call of harness.state.consumeCalls) call.release?.();
        host.close();
        viewer.close();
        if (room) destroyRoom(room.code);
        stopJoinCleanup();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    }
}

test('repeated consume of one producer leaves one live consumer and closes the superseded ones', { concurrency: false }, async () => {
    await withViewer('sequential', async ({ harness, consume, viewerData, viewer, liveCount }) => {
        const responses = [];
        for (let i = 0; i < 6; i += 1) responses.push(await consume());

        assert.ok(responses.every((response) => response.success === true));
        const created = harness.state.consumers;
        assert.equal(created.length, 6);

        const consumers = viewerData().consumers;
        assert.equal(consumers.length, 1);
        assert.equal(consumers[0], created[5]);
        assert.equal(liveCount(), 1);
        for (const superseded of created.slice(0, 5)) {
            assert.equal(superseded.closeCalls, 1, `${superseded.id} closed once`);
        }
        assert.equal(created[5].closeCalls, 0);

        // Consumers are still created paused and resumed only through consumer-resume.
        for (const call of harness.state.consumeCalls) assert.equal(call.options.paused, true);
        assert.ok(created.every((consumer) => consumer.resumeCalls === 0));

        const stale = await request(viewer, 'consumer-resume', { consumerId: created[0].id });
        assert.deepEqual(stale, { success: false, error: 'Consumer not found.' });
        assert.equal(created[0].resumeCalls, 0);

        const current = await request(viewer, 'consumer-resume', { consumerId: created[5].id });
        assert.deepEqual(current, { success: true });
        assert.equal(created[5].resumeCalls, 1);

        // The callback for the surviving consumer still carries the unchanged params.
        assert.deepEqual(responses[5], {
            success: true,
            params: {
                id: created[5].id,
                producerId: VIDEO_PRODUCER_ID,
                kind: 'video',
                rtpParameters: created[5].rtpParameters,
            },
        });
    });
});

test('a viewer keeps one live consumer for each producer, video and audio', { concurrency: false }, async () => {
    await withViewer('both-kinds', async ({ harness, consume, viewerData, liveCount }) => {
        for (let i = 0; i < 3; i += 1) {
            assert.equal((await consume(VIDEO_PRODUCER_ID)).success, true);
            assert.equal((await consume(AUDIO_PRODUCER_ID)).success, true);
        }

        const consumers = viewerData().consumers;
        assert.equal(consumers.length, 2);
        assert.deepEqual(
            consumers.map((consumer) => consumer.producerId).sort(),
            [AUDIO_PRODUCER_ID, VIDEO_PRODUCER_ID].sort()
        );
        assert.equal(liveCount(), 2);
        assert.equal(harness.state.consumers.filter((consumer) => !consumer.closed).length, 2);
    });
});

test('overlapping consume calls for one producer converge on the newest consumer', { concurrency: false }, async () => {
    await withViewer('overlap', async ({ harness, consume, viewerData, liveCount }) => {
        harness.state.deferConsume = true;
        const first = consume();
        const second = consume();
        await waitFor(() => harness.state.consumeCalls.length === 2, 'both consume calls to reach the transport');

        harness.state.consumeCalls[0].release();
        assert.equal((await first).success, true);
        harness.state.consumeCalls[1].release();
        assert.equal((await second).success, true);

        const [older, newer] = harness.state.consumers;
        assert.deepEqual(viewerData().consumers, [newer]);
        assert.equal(older.closed, true);
        assert.equal(older.closeCalls, 1);
        assert.equal(newer.closed, false);
        assert.equal(liveCount(), 1);
    });
});

test('overlapping consume calls finishing out of order still leave exactly one live consumer', { concurrency: false }, async () => {
    await withViewer('overlap-reversed', async ({ harness, consume, viewerData, liveCount }) => {
        harness.state.deferConsume = true;
        const first = consume();
        const second = consume();
        const third = consume();
        await waitFor(() => harness.state.consumeCalls.length === 3, 'three consume calls to reach the transport');

        harness.state.consumeCalls[2].release();
        assert.equal((await third).success, true);
        harness.state.consumeCalls[0].release();
        assert.equal((await first).success, true);
        harness.state.consumeCalls[1].release();
        assert.equal((await second).success, true);

        assert.equal(harness.state.consumers.length, 3);
        assert.equal(viewerData().consumers.length, 1);
        assert.equal(harness.state.consumers.filter((consumer) => !consumer.closed).length, 1);
        assert.equal(liveCount(), 1);
        for (const consumer of harness.state.consumers) {
            assert.ok(consumer.closeCalls <= 1, `${consumer.id} closed at most once`);
        }
    });
});

test('consume closes its new consumer when the receive transport was replaced during the await', { concurrency: false }, async () => {
    await withViewer('replaced', async ({ harness, viewer, consume, viewerData, liveCount }) => {
        harness.state.deferConsume = true;
        const pending = consume();
        await waitFor(() => harness.state.consumeCalls.length === 1, 'consume to reach the transport');

        const replacement = await request(viewer, 'create-recv-transport');
        assert.equal(replacement.success, true);
        harness.state.consumeCalls[0].release();
        const response = await pending;

        assert.equal(response.success, false);
        const [orphan] = harness.state.consumers;
        assert.equal(orphan.closed, true);
        assert.equal(orphan.closeCalls, 1);
        assert.deepEqual(viewerData().consumers, []);
        assert.equal(viewerData().recvTransport.id, replacement.params.id);
        assert.equal(liveCount(), 0);
    });
});

test('consume closes its new consumer when the receive transport was closed during the await', { concurrency: false }, async () => {
    await withViewer('closed', async ({ harness, viewer, recv, consume, viewerData, liveCount }) => {
        harness.state.deferConsume = true;
        const pending = consume();
        await waitFor(() => harness.state.consumeCalls.length === 1, 'consume to reach the transport');

        const closed = await request(viewer, 'close-viewer-transport', { transportId: recv.params.id });
        assert.equal(closed.success, true);
        harness.state.consumeCalls[0].release();
        const response = await pending;

        assert.equal(response.success, false);
        const [orphan] = harness.state.consumers;
        assert.equal(orphan.closed, true);
        assert.equal(orphan.closeCalls, 1);
        assert.equal(viewerData().recvTransport, null);
        assert.deepEqual(viewerData().consumers, []);
        assert.equal(liveCount(), 0);
    });
});

test('consume closes its new consumer when the room was destroyed during the await', { concurrency: false }, async () => {
    await withViewer('destroyed', async ({ harness, room, consume, liveCount }) => {
        harness.state.deferConsume = true;
        const pending = consume();
        await waitFor(() => harness.state.consumeCalls.length === 1, 'consume to reach the transport');

        destroyRoom(room.code);
        harness.state.consumeCalls[0].release();
        const response = await pending;

        assert.equal(response.success, false);
        const [orphan] = harness.state.consumers;
        assert.equal(orphan.closed, true);
        assert.equal(liveCount(), 0);
    });
});

test('consuming a new producer id after a producer change still succeeds', { concurrency: false }, async () => {
    await withViewer('producer-change', async ({ harness, room, consume, viewerData, liveCount }) => {
        assert.equal((await consume(VIDEO_PRODUCER_ID)).success, true);
        const [old] = harness.state.consumers;

        // The host's producer is replaced; mediasoup tells the old consumer first.
        room.producer = { id: `${VIDEO_PRODUCER_ID}-2`, kind: 'video', close() {} };
        old.emit('producerclose');

        const response = await consume(`${VIDEO_PRODUCER_ID}-2`);
        assert.equal(response.success, true);
        assert.equal(response.params.producerId, `${VIDEO_PRODUCER_ID}-2`);
        assert.equal(viewerData().consumers.length, 1);
        assert.equal(viewerData().consumers[0].producerId, `${VIDEO_PRODUCER_ID}-2`);
        assert.equal(liveCount(), 1);
    });
});
