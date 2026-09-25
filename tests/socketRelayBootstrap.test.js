const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const { findRoomBySocket, destroyRoom } = require('../lib/rooms');
const { registerSocketHandlers, stopJoinCleanup } = require('../lib/socket');
const { NON_SYNC, box, fragment, initSegment, traf } = require('./mp4Boxes');

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

// socket.io-parser rejects packets carrying more than 10 binary attachments and
// drops the connection with "parse error". A later relay viewer's start
// acknowledgement replays the active generation, which after a few seconds
// holds far more than 10 recorder chunks.
test('a later relay viewer receives a long bootstrap without being disconnected', { concurrency: false }, async () => {
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer, {}, { authorizeRelay: () => true });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${httpServer.address().port}`;
    const clients = ['host', 'first', 'late'].map(() => createClient(url, { transports: ['websocket'] }));
    const [host, firstViewer, lateViewer] = clients;
    await Promise.all(clients.map((client) => new Promise((resolve) => client.once('connect', resolve))));
    let room = null;

    try {
        const created = await request(host, 'create-room');
        assert.equal(created.success, true);
        room = findRoomBySocket(host.id);
        assert.equal((await request(firstViewer, 'join-room', { code: created.code })).success, true);
        assert.equal((await request(lateViewer, 'join-room', { code: created.code })).success, true);
        assert.equal((await request(firstViewer, 'relay-consume-start')).success, true);

        host.emit('media-init', { mimeType: 'video/webm;codecs=vp8,opus', generation: 1 });
        const bootstrapBytes = [];
        for (let index = 0; index < 25; index += 1) {
            bootstrapBytes.push(index);
            host.emit('media-chunk', { generation: 1, chunk: Buffer.from([index]) });
        }
        await nextEvent(firstViewer, 'media-chunk', ({ chunk }) => Buffer.from(chunk)[0] === 24);

        const lateStart = await request(lateViewer, 'relay-consume-start');
        assert.equal(lateStart.success, true);
        assert.equal(lateStart.relayViewerCount, 2);
        assert.equal(lateStart.bootstrapChunks.length, 1);
        assert.deepEqual(Buffer.from(lateStart.bootstrapChunks[0]), Buffer.from(bootstrapBytes));
        assert.equal(lateViewer.connected, true);
    } finally {
        clients.forEach((client) => client.close());
        if (room) destroyRoom(room.code);
        stopJoinCleanup();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    }
});

async function startRelayRoom(options, viewerNames) {
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer, {}, { authorizeRelay: () => true, ...options });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${httpServer.address().port}`;
    const host = createClient(url, { transports: ['websocket'] });
    const viewers = viewerNames.map(() => createClient(url, { transports: ['websocket'] }));
    await Promise.all([host, ...viewers].map((client) => new Promise((resolve) => client.once('connect', resolve))));
    const created = await request(host, 'create-room');
    const room = findRoomBySocket(host.id);
    for (const viewer of viewers) {
        assert.equal((await request(viewer, 'join-room', { code: created.code })).success, true);
    }
    return {
        host,
        viewers,
        async close() {
            [host, ...viewers].forEach((client) => client.close());
            destroyRoom(room.code);
            stopJoinCleanup();
            await ioServer.close();
            await new Promise((resolve) => httpServer.close(resolve));
        },
    };
}

function collectChunks(client) {
    const chunks = [];
    client.on('media-chunk', ({ chunk }) => chunks.push(Buffer.from(chunk)));
    return chunks;
}

const MP4_MIME = 'video/mp4;codecs=avc1.640028,mp4a.40.2';
const init = initSegment();
const keyFragment = (marker) => fragment([traf(2, { firstSampleFlags: 0 })], marker);
const deltaFragment = (marker) => fragment([traf(2, { firstSampleFlags: NON_SYNC })], marker);

// A late joiner needs only the init segment and the GOP in progress, so it can
// join at any point of a long MP4 relay instead of being refused once the whole
// generation outgrows the replay cap.
test('a late MP4 relay viewer bootstraps from the init segment and the current GOP', { concurrency: false }, async () => {
    const relay = await startRelayRoom({}, ['first', 'late']);
    const [firstViewer, lateViewer] = relay.viewers;
    try {
        assert.equal((await request(firstViewer, 'relay-consume-start')).success, true);
        const firstChunks = collectChunks(firstViewer);
        relay.host.emit('media-init', { mimeType: MP4_MIME, generation: 1 });
        const units = [init, keyFragment(10), deltaFragment(11), keyFragment(12), deltaFragment(13)];
        // Recorder chunks do not line up with box boundaries.
        const bytes = Buffer.concat(units);
        for (let offset = 0; offset < bytes.length; offset += 50) {
            relay.host.emit('media-chunk', { generation: 1, chunk: bytes.subarray(offset, offset + 50) });
        }
        await nextEvent(firstViewer, 'media-chunk', ({ chunk }) => Buffer.from(chunk).equals(units[4]));
        assert.deepEqual(firstChunks, units);

        const lateStart = await request(lateViewer, 'relay-consume-start');
        assert.equal(lateStart.success, true);
        assert.equal(lateStart.bootstrapComplete, true);
        assert.deepEqual(Buffer.from(lateStart.bootstrapChunks[0]), Buffer.concat([init, units[3], units[4]]));
    } finally {
        await relay.close();
    }
});

test('a lagging MP4 relay viewer skips to the next keyframe without affecting the other viewer', { concurrency: false }, async () => {
    const lagging = new Set();
    let now = 1_000;
    const congestion = [];
    const relay = await startRelayRoom({
        // 1 MB queued is seconds behind these tiny fragments, yet under the
        // 16 MB hard cap that still disconnects a viewer outright.
        measureRelayBacklogBytes: (socket) => (lagging.has(socket.id) ? 1024 * 1024 : 0),
        now: () => now,
    }, ['steady', 'slow']);
    const [steady, slow] = relay.viewers;
    relay.host.on('relay-congestion', () => congestion.push(now));
    try {
        for (const viewer of relay.viewers) assert.equal((await request(viewer, 'relay-consume-start')).success, true);
        const steadyChunks = collectChunks(steady);
        const slowChunks = collectChunks(slow);
        relay.host.emit('media-init', { mimeType: MP4_MIME, generation: 1 });
        const send = async (unit) => {
            relay.host.emit('media-chunk', { generation: 1, chunk: unit });
            await nextEvent(steady, 'media-chunk', ({ chunk }) => Buffer.from(chunk).equals(unit));
        };

        await send(init);
        await send(keyFragment(20));
        lagging.add(slow.id);
        await send(deltaFragment(21));
        await send(keyFragment(22));
        lagging.delete(slow.id);
        await send(deltaFragment(23));
        const slowResumed = nextEvent(slow, 'media-chunk', ({ chunk }) => Buffer.from(chunk).equals(keyFragment(24)));
        await send(keyFragment(24));
        await slowResumed;

        assert.equal(steadyChunks.length, 6);
        // Skipped from the lag until the next keyframe after it drained.
        assert.deepEqual(slowChunks, [init, keyFragment(20), keyFragment(24)]);
        assert.deepEqual(congestion, []);

        // Every relay viewer lagging for 5 s is the host uplink: ask for less.
        lagging.add(steady.id);
        lagging.add(slow.id);
        relay.host.emit('media-chunk', { generation: 1, chunk: deltaFragment(25) });
        // An acknowledged request is an ordering barrier: the server has handled
        // the fragment above before the clock moves.
        await request(relay.host, 'get-media-init');
        now += 5_000;
        const signalled = nextEvent(relay.host, 'relay-congestion', () => true);
        relay.host.emit('media-chunk', { generation: 1, chunk: deltaFragment(26) });
        await signalled;
        assert.deepEqual(congestion, [now]);

        // The host answers by restarting its recorder at a lower bitrate. The
        // new generation must not reset the rate limit, or the bitrate would
        // collapse to the floor before viewers had a chance to catch up.
        relay.host.emit('media-init', { mimeType: MP4_MIME, generation: 2 });
        relay.host.emit('media-chunk', { generation: 2, chunk: init });
        relay.host.emit('media-chunk', { generation: 2, chunk: deltaFragment(27) });
        await request(relay.host, 'get-media-init');
        now += 6_000;
        relay.host.emit('media-chunk', { generation: 2, chunk: deltaFragment(28) });
        await request(relay.host, 'get-media-init');
        assert.equal(congestion.length, 1);
        now += 14_000;
        const signalledAgain = nextEvent(relay.host, 'relay-congestion', () => true);
        relay.host.emit('media-chunk', { generation: 2, chunk: deltaFragment(29) });
        await signalledAgain;
        assert.equal(congestion.length, 2);
    } finally {
        await relay.close();
    }
});

// A recording the server cannot parse must not leave relay viewers silent: the
// host is told once, and falls back to its VP8 recorder for a fresh generation.
test('an unparseable MP4 relay generation asks the host to fall back to VP8', { concurrency: false }, async () => {
    const relay = await startRelayRoom({}, ['viewer']);
    const [viewer] = relay.viewers;
    const failures = [];
    relay.host.on('relay-mp4-failed', (payload) => failures.push(payload));
    try {
        assert.equal((await request(viewer, 'relay-consume-start')).success, true);
        relay.host.emit('media-init', { mimeType: MP4_MIME, generation: 1 });
        relay.host.emit('media-chunk', { generation: 1, chunk: init });
        const failed = nextEvent(relay.host, 'relay-mp4-failed', () => true);
        // An mdat with no moof before it is not a stream the relay can frame.
        relay.host.emit('media-chunk', { generation: 1, chunk: box('mdat', Buffer.alloc(8)) });
        assert.deepEqual(await failed, { generation: 1 });
        relay.host.emit('media-chunk', { generation: 1, chunk: box('mdat', Buffer.alloc(8)) });
        await request(relay.host, 'get-media-init');
        assert.equal(failures.length, 1);
    } finally {
        await relay.close();
    }
});
