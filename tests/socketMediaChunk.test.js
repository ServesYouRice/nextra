const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const config = require('../config');
const { findRoomBySocket, destroyRoom } = require('../lib/rooms');
const { registerSocketHandlers, stopJoinCleanup, getSocketRuntimeMetrics } = require('../lib/socket');

const WEBM_MIME = 'video/webm;codecs=vp8,opus';
const MP4_MIME = 'video/mp4;codecs=avc1.640028,mp4a.40.2';

function request(client, event, data = {}) {
    return new Promise((resolve, reject) => {
        const onDisconnect = (reason) => reject(new Error(`${event}: disconnected (${reason})`));
        client.once('disconnect', onDisconnect);
        client.emit(event, data, (response) => {
            client.off('disconnect', onDisconnect);
            resolve(response);
        });
    });
}

function nextEvent(client, event, predicate, timeoutMs = 3_000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            client.off(event, onEvent);
            reject(new Error(`timed out waiting for ${event}`));
        }, timeoutMs);
        const onEvent = (payload) => {
            if (!predicate(payload)) return;
            clearTimeout(timeout);
            client.off(event, onEvent);
            resolve(payload);
        };
        client.on(event, onEvent);
    });
}

// A host and one relay viewer on a real socket.io server. `serverHost` is the
// server side of the host connection, so a test can call its listeners with
// values a wire client cannot produce (ArrayBuffer, typed arrays) or can only
// produce by chance (a parser that throws).
async function startRoom() {
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer, {}, { authorizeRelay: () => true });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${httpServer.address().port}`;
    const host = createClient(url, { transports: ['websocket'] });
    const viewer = createClient(url, { transports: ['websocket'] });
    await Promise.all([host, viewer].map((client) => new Promise((resolve) => client.once('connect', resolve))));
    const created = await request(host, 'create-room');
    assert.equal((await request(viewer, 'join-room', { code: created.code })).success, true);
    assert.equal((await request(viewer, 'relay-consume-start')).success, true);
    const room = findRoomBySocket(host.id);
    const serverHost = ioServer.sockets.sockets.get(host.id);
    const received = [];
    viewer.on('media-chunk', ({ chunk }) => received.push(chunk));
    return {
        host,
        viewer,
        room,
        received,
        call(event, payload) {
            const [listener] = serverHost.listeners(event);
            return listener(payload);
        },
        // An acknowledged request is an ordering barrier: the server has handled
        // every event this client emitted before it.
        barrier: () => request(host, 'get-media-init'),
        async close() {
            [host, viewer].forEach((client) => client.close());
            destroyRoom(room.code);
            stopJoinCleanup();
            await ioServer.close();
            await new Promise((resolve) => httpServer.close(resolve));
        },
    };
}

const counters = () => getSocketRuntimeMetrics().counters;

// Objects a client can send in place of binary data. The size they claim, or
// the content they carry, must never be believed.
const FORGED_CHUNKS = [
    { byteLength: 1, payload: 'x'.repeat(100_000) },
    { size: 10 },
    { byteLength: 10 },
    { type: 'Buffer', data: [1, 2, 3] },
    { length: 4, byteLength: 4 },
    [1, 2, 3],
    'text',
    12345,
    true,
];

test('forged media-chunk payloads are dropped before the WebM bootstrap buffer', { concurrency: false }, async () => {
    const relay = await startRoom();
    try {
        relay.host.emit('media-init', { mimeType: WEBM_MIME, generation: 1 });
        await relay.barrier();
        const before = counters();

        for (const chunk of FORGED_CHUNKS) relay.host.emit('media-chunk', { generation: 1, chunk });
        await relay.barrier();

        assert.equal(relay.room.initChunk, null);
        assert.deepEqual(relay.room.mediaBootstrapChunks, []);
        assert.equal(relay.room.mediaBootstrapBytes, 0);
        assert.deepEqual(relay.received, []);
        assert.equal(counters().relayChunksReceived, before.relayChunksReceived);
        assert.equal(counters().relayBytesReceived, before.relayBytesReceived);

        // A real chunk after the forged ones is still taken in.
        const real = Buffer.from([9, 8, 7, 6]);
        const delivered = nextEvent(relay.viewer, 'media-chunk', () => true);
        relay.host.emit('media-chunk', { generation: 1, chunk: real });
        await delivered;
        assert.deepEqual(relay.room.initChunk, real);
        assert.equal(relay.room.mediaBootstrapBytes, real.length);
        assert.deepEqual(relay.received, [real]);
    } finally {
        await relay.close();
    }
});

test('forged media-chunk payloads never reach the MP4 relay parser', { concurrency: false }, async () => {
    const relay = await startRoom();
    try {
        relay.host.emit('media-init', { mimeType: MP4_MIME, generation: 1 });
        await relay.barrier();
        assert.ok(relay.room.relayMp4, 'media-init with an MP4 mime type creates the relay stream');
        const pushed = [];
        relay.room.relayMp4 = { push: (chunk) => pushed.push(chunk) };
        const before = counters();

        for (const chunk of FORGED_CHUNKS) relay.host.emit('media-chunk', { generation: 1, chunk });
        await relay.barrier();

        assert.deepEqual(pushed, []);
        assert.equal(relay.room.initChunk, null);
        assert.equal(relay.room.mediaBootstrapBytes, 0);
        assert.deepEqual(relay.received, []);
        assert.equal(counters().relayChunksReceived, before.relayChunksReceived);
        assert.equal(counters().relayBytesReceived, before.relayBytesReceived);

        const real = Buffer.from([1, 2, 3]);
        relay.host.emit('media-chunk', { generation: 1, chunk: real });
        await relay.barrier();
        assert.deepEqual(pushed, [real]);
        assert.equal(counters().relayBytesReceived, before.relayBytesReceived + real.length);
    } finally {
        await relay.close();
    }
});

test('Buffer, ArrayBuffer and typed-array chunks are stored and forwarded with their real byte length', { concurrency: false }, async () => {
    const relay = await startRoom();
    try {
        relay.host.emit('media-init', { mimeType: WEBM_MIME, generation: 1 });
        await relay.barrier();
        const before = counters();

        const backing = Uint8Array.from([100, 101, 102, 103, 104, 105, 106, 107]).buffer;
        const wide = Uint16Array.from([0x0201, 0x0403, 0x0605]);
        const sent = [
            { chunk: Buffer.from([1, 2, 3]), bytes: [1, 2, 3] },
            { chunk: Uint8Array.from([4, 5, 6, 7, 8]).buffer, bytes: [4, 5, 6, 7, 8] },
            // A view into the middle of a larger buffer is its slice, not the whole buffer.
            { chunk: new Uint8Array(backing, 2, 4), bytes: [102, 103, 104, 105] },
            { chunk: wide, bytes: [1, 2, 3, 4, 5, 6] },
            { chunk: new DataView(backing, 5, 3), bytes: [105, 106, 107] },
        ];
        const expected = Buffer.from(sent.flatMap(({ bytes }) => bytes));
        const lastForwarded = nextEvent(relay.viewer, 'media-chunk', () => relay.received.length === sent.length);
        for (const { chunk } of sent) relay.call('media-chunk', { generation: 1, chunk });
        await lastForwarded;

        assert.equal(relay.room.mediaBootstrapBytes, expected.length);
        assert.ok(relay.room.mediaBootstrapChunks.every((chunk) => Buffer.isBuffer(chunk)));
        assert.deepEqual(relay.room.mediaBootstrapChunks.map((chunk) => [...chunk]), sent.map(({ bytes }) => bytes));
        assert.deepEqual(relay.room.initChunk, Buffer.from(sent[0].bytes));
        assert.deepEqual(relay.received.map((chunk) => [...chunk]), sent.map(({ bytes }) => bytes));
        assert.equal(counters().relayChunksReceived, before.relayChunksReceived + sent.length);
        assert.equal(counters().relayBytesReceived, before.relayBytesReceived + expected.length);
        assert.equal(counters().relayBytesForwarded, before.relayBytesForwarded + expected.length);
    } finally {
        await relay.close();
    }
});

test('binary chunks of every form reach the MP4 relay parser as Buffers with their bytes unchanged', { concurrency: false }, async () => {
    const relay = await startRoom();
    try {
        relay.host.emit('media-init', { mimeType: MP4_MIME, generation: 1 });
        await relay.barrier();
        const pushed = [];
        relay.room.relayMp4 = { push: (chunk) => pushed.push(chunk) };

        relay.call('media-chunk', { generation: 1, chunk: Buffer.from([1, 2]) });
        relay.call('media-chunk', { generation: 1, chunk: Uint8Array.from([3, 4, 5]).buffer });
        relay.call('media-chunk', { generation: 1, chunk: new Uint8Array(Uint8Array.from([0, 6, 7, 8]).buffer, 1, 3) });

        assert.ok(pushed.every((chunk) => Buffer.isBuffer(chunk)));
        assert.deepEqual(pushed.map((chunk) => [...chunk]), [[1, 2], [3, 4, 5], [6, 7, 8]]);
    } finally {
        await relay.close();
    }
});

test('an oversized chunk is dropped by its real byte length', { concurrency: false }, async () => {
    const relay = await startRoom();
    try {
        relay.host.emit('media-init', { mimeType: WEBM_MIME, generation: 1 });
        await relay.barrier();
        const before = counters();
        const oversized = config.MEDIA_MAX_CHUNK_SIZE + 1;

        relay.call('media-chunk', { generation: 1, chunk: Buffer.alloc(oversized) });
        relay.call('media-chunk', { generation: 1, chunk: new ArrayBuffer(oversized) });
        relay.call('media-chunk', { generation: 1, chunk: new Uint8Array(oversized) });

        assert.equal(counters().relayChunksDroppedOversized, before.relayChunksDroppedOversized + 3);
        assert.equal(relay.room.initChunk, null);
        assert.equal(relay.room.mediaBootstrapBytes, 0);
        assert.deepEqual(relay.room.mediaBootstrapChunks, []);

        // The limit itself is still allowed.
        relay.call('media-chunk', { generation: 1, chunk: Buffer.alloc(config.MEDIA_MAX_CHUNK_SIZE) });
        assert.equal(relay.room.mediaBootstrapBytes, config.MEDIA_MAX_CHUNK_SIZE);
        assert.equal(counters().relayChunksDroppedOversized, before.relayChunksDroppedOversized + 3);
    } finally {
        await relay.close();
    }
});

test('a chunk from an old generation is still ignored', { concurrency: false }, async () => {
    const relay = await startRoom();
    try {
        relay.host.emit('media-init', { mimeType: WEBM_MIME, generation: 2 });
        await relay.barrier();
        relay.call('media-chunk', { generation: 1, chunk: Buffer.from([1]) });
        relay.call('media-chunk', { generation: 3, chunk: Buffer.from([2]) });
        relay.call('media-chunk', { chunk: Buffer.from([3]) });
        assert.equal(relay.room.mediaBootstrapBytes, 0);
        relay.call('media-chunk', { generation: 2, chunk: Buffer.from([4]) });
        assert.equal(relay.room.mediaBootstrapBytes, 1);
    } finally {
        await relay.close();
    }
});

test('an exception while processing a media chunk stays inside the handler and is logged once per generation', { concurrency: false }, async (t) => {
    const relay = await startRoom();
    const logged = [];
    const capture = (...args) => { logged.push(args.join(' ')); };
    t.mock.method(console, 'warn', capture);
    t.mock.method(console, 'error', capture);
    const mediaChunkLogs = () => logged.filter((line) => /media[- ]chunk/i.test(line));
    try {
        relay.host.emit('media-init', { mimeType: MP4_MIME, generation: 1 });
        await relay.barrier();
        let calls = 0;
        const throwing = { push() { calls += 1; throw new Error('parser blew up'); } };
        relay.room.relayMp4 = throwing;

        for (let index = 0; index < 5; index += 1) {
            assert.doesNotThrow(() => relay.call('media-chunk', { generation: 1, chunk: Buffer.from([index + 1]) }));
        }
        assert.equal(calls, 5, 'every chunk still reaches the parser');
        assert.equal(mediaChunkLogs().length, 1);
        assert.match(mediaChunkLogs()[0], /parser blew up/);

        // The next generation gets its own log line, and the room keeps working.
        relay.call('media-init', { mimeType: MP4_MIME, generation: 2 });
        relay.room.relayMp4 = throwing;
        assert.doesNotThrow(() => relay.call('media-chunk', { generation: 2, chunk: Buffer.from([1]) }));
        assert.doesNotThrow(() => relay.call('media-chunk', { generation: 2, chunk: Buffer.from([2]) }));
        assert.equal(mediaChunkLogs().length, 2);
        assert.equal(relay.host.connected, true);
    } finally {
        await relay.close();
    }
});
