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
    const serverHost = ioServer.sockets.sockets.get(host.id);
    return {
        host,
        viewers,
        room,
        // Runs the server's own handler for an event from the host, for chunks
        // above the test server's 1 MB Socket.IO message limit.
        fromHost(event, payload) {
            const [listener] = serverHost.listeners(event);
            return listener(payload);
        },
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

// ── A later relay viewer's bootstrap against the browser's relay queue ──
//
// WatchView feeds relay media through src/lib/relayAppendQueue.mjs. These tests
// run that queue, with its own limits, on what the server sends a later viewer:
// the live chunks it receives from its start, and the bootstrap from the
// acknowledgement in front of them, against a SourceBuffer whose appends the
// test ends by hand.

const WEBM_MIME = 'video/webm;codecs=vp8,opus';
const MB = 1024 * 1024;
const loadRelayQueue = () => import('../src/lib/relayAppendQueue.mjs');

class ManualSourceBuffer extends EventTarget {
    constructor() {
        super();
        this.updating = false;
        this.appended = [];
    }

    appendBuffer(data) {
        assert.equal(this.updating, false, 'one append at a time');
        this.updating = true;
        this.appended.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    }

    remove() {
        assert.fail('nothing is evicted here');
    }

    // Ends the running append and each one the queue starts after it.
    finishAll() {
        while (this.updating) {
            this.updating = false;
            this.dispatchEvent(new Event('updateend'));
        }
    }
}

class OpenMediaSource extends EventTarget {
    constructor() {
        super();
        this.readyState = 'open';
    }
}

// What startRelayPlayback does for a later relay viewer, up to its first append.
async function startLateRelayViewer(viewer) {
    const { createRelayAppendQueue, RELAY_QUEUE_MAX_BYTES, RELAY_QUEUE_MAX_CHUNKS } = await loadRelayQueue();
    const failures = [];
    const queue = createRelayAppendQueue({
        maxChunks: RELAY_QUEUE_MAX_CHUNKS,
        maxBytes: RELAY_QUEUE_MAX_BYTES,
        onFailure: (failure) => failures.push(failure.message),
    });
    viewer.on('media-chunk', ({ chunk }) => queue.enqueue(new Uint8Array(chunk)));
    const start = await request(viewer, 'relay-consume-start');
    assert.equal(start.success, true);
    assert.equal(start.relayViewerCount, 2);
    const sourceBuffer = new ManualSourceBuffer();
    queue.attach(sourceBuffer, new OpenMediaSource());
    queue.prepend(start.bootstrapChunks.map((chunk) => new Uint8Array(chunk)));
    queue.pump();
    return { start, sourceBuffer, failures };
}

// Records a WebM generation of `total` bytes in chunks of `size`, each one
// delivered to the viewer already watching before the next is sent.
async function recordWebm(relay, watcher, total, size) {
    const recorded = [];
    let bytes = 0;
    while (bytes < total) {
        const chunk = Buffer.alloc(Math.min(size, total - bytes), recorded.length % 251);
        const delivered = nextEvent(watcher, 'media-chunk', () => true);
        relay.fromHost('media-chunk', { generation: 1, chunk });
        await delivered;
        recorded.push(chunk);
        bytes += chunk.length;
    }
    return recorded;
}

async function startWebmGeneration(relay, firstViewer) {
    assert.equal((await request(firstViewer, 'relay-consume-start')).success, true);
    relay.host.emit('media-init', { mimeType: WEBM_MIME, generation: 1 });
    await request(relay.host, 'get-media-init');
}

// The browser's queue holds 240 live chunks (72 s of 300 ms recorder slices).
// The bootstrap reaches it as one buffer, so a viewer that joins long after
// the generation began still starts.
test('a late relay viewer starts from a bootstrap of more recorder chunks than the browser queue holds', { concurrency: false }, async () => {
    const { RELAY_QUEUE_MAX_CHUNKS } = await loadRelayQueue();
    const relay = await startRelayRoom({}, ['first', 'late']);
    const [firstViewer, lateViewer] = relay.viewers;
    try {
        await startWebmGeneration(relay, firstViewer);
        const recorded = await recordWebm(relay, firstViewer, (RELAY_QUEUE_MAX_CHUNKS + 60) * 1024, 1024);

        const late = await startLateRelayViewer(lateViewer);
        assert.equal(late.start.bootstrapComplete, true);
        assert.ok(late.start.bootstrapChunks.length <= RELAY_QUEUE_MAX_CHUNKS);
        const live = Buffer.alloc(1024, 0xee);
        const arrived = nextEvent(lateViewer, 'media-chunk', () => true);
        relay.fromHost('media-chunk', { generation: 1, chunk: live });
        await arrived;
        late.sourceBuffer.finishAll();
        assert.deepEqual(late.failures, []);
        assert.deepEqual(late.sourceBuffer.appended, [Buffer.concat(recorded), live]);
    } finally {
        await relay.close();
    }
});

// The server keeps a bootstrap up to the browser queue's byte ceiling. The
// live chunks that reach the viewer while its browser appends that bootstrap
// queue behind it, and must still fit.
test('a late relay viewer whose bootstrap is near the byte ceiling keeps the live chunks that arrive while it is appended', { concurrency: false }, async () => {
    const { RELAY_QUEUE_MAX_BYTES } = await loadRelayQueue();
    const relay = await startRelayRoom({}, ['first', 'late']);
    const [firstViewer, lateViewer] = relay.viewers;
    try {
        await startWebmGeneration(relay, firstViewer);
        const recorded = await recordWebm(relay, firstViewer, RELAY_QUEUE_MAX_BYTES - 64 * 1024, MB);

        const late = await startLateRelayViewer(lateViewer);
        assert.equal(late.start.bootstrapComplete, true);
        assert.equal(late.start.bootstrapChunks[0].length, RELAY_QUEUE_MAX_BYTES - 64 * 1024);
        // One 300 ms slice of the 14 Mbps relay tier (1440p at 30 fps).
        const slice = Buffer.alloc(525_000, 0xee);
        const arrived = nextEvent(lateViewer, 'media-chunk', () => true);
        relay.fromHost('media-chunk', { generation: 1, chunk: slice });
        await arrived;
        assert.deepEqual(late.failures, []);
        late.sourceBuffer.finishAll();
        assert.equal(late.sourceBuffer.appended.length, 2);
        assert.ok(late.sourceBuffer.appended[0].equals(Buffer.concat(recorded)));
        assert.ok(late.sourceBuffer.appended[1].equals(slice));
    } finally {
        await relay.close();
    }
});

// The browser's queue takes a bootstrap of up to RELAY_QUEUE_MAX_BYTES next to
// its live allowance. The server keeps a WebM bootstrap up to exactly that;
// past it the generation is too long for a late join, which WatchView refuses.
test("the server keeps a WebM relay bootstrap up to the browser queue's ceiling and no further", { concurrency: false }, async () => {
    const { RELAY_QUEUE_MAX_BYTES } = await loadRelayQueue();
    const relay = await startRelayRoom({}, ['first', 'late']);
    const [firstViewer, lateViewer] = relay.viewers;
    try {
        await startWebmGeneration(relay, firstViewer);
        await recordWebm(relay, firstViewer, RELAY_QUEUE_MAX_BYTES, MB);
        const atCeiling = await request(lateViewer, 'relay-consume-start');
        assert.equal(atCeiling.bootstrapComplete, true);
        assert.equal(atCeiling.bootstrapChunks.length, 1);
        assert.equal(atCeiling.bootstrapChunks[0].length, RELAY_QUEUE_MAX_BYTES);
        assert.equal((await request(lateViewer, 'relay-consume-stop')).success, true);

        await recordWebm(relay, firstViewer, 1, 1);
        const past = await request(lateViewer, 'relay-consume-start');
        assert.equal(past.bootstrapComplete, false);
        assert.deepEqual(past.bootstrapChunks, []);
    } finally {
        await relay.close();
    }
});

// The same ceiling holds for an MP4 bootstrap, its init segment included.
test("a late MP4 relay viewer's bootstrap, init segment included, stays within the browser queue's ceiling", { concurrency: false }, async () => {
    const { RELAY_QUEUE_MAX_BYTES } = await loadRelayQueue();
    // No viewer counts as behind here, however large a fragment.
    const relay = await startRelayRoom({ measureRelayBacklogBytes: () => 0 }, ['first', 'late']);
    const [firstViewer, lateViewer] = relay.viewers;
    const send = (bytes) => {
        for (let offset = 0; offset < bytes.length; offset += MB) {
            relay.fromHost('media-chunk', { generation: 1, chunk: bytes.subarray(offset, offset + MB) });
        }
    };
    const lateStart = async () => {
        const start = await request(lateViewer, 'relay-consume-start');
        assert.equal((await request(lateViewer, 'relay-consume-stop')).success, true);
        return {
            complete: start.bootstrapComplete,
            bytes: start.bootstrapChunks.reduce((sum, chunk) => sum + chunk.length, 0),
        };
    };
    try {
        assert.equal((await request(firstViewer, 'relay-consume-start')).success, true);
        relay.host.emit('media-init', { mimeType: MP4_MIME, generation: 1 });
        await request(relay.host, 'get-media-init');
        send(init);

        // A keyframe fragment that fits the ceiling alone, but not after the init segment.
        send(keyFragment(RELAY_QUEUE_MAX_BYTES - init.length - keyFragment(0).length + 1));
        assert.deepEqual(await lateStart(), { complete: false, bytes: 0 });

        // A GOP that reaches the ceiling exactly, then passes it by one fragment.
        const key = keyFragment(1000);
        send(key);
        assert.deepEqual(await lateStart(), { complete: true, bytes: init.length + key.length });
        send(deltaFragment(RELAY_QUEUE_MAX_BYTES - init.length - key.length - deltaFragment(0).length));
        assert.deepEqual(await lateStart(), { complete: true, bytes: RELAY_QUEUE_MAX_BYTES });
        send(deltaFragment(0));
        assert.deepEqual(await lateStart(), { complete: false, bytes: 0 });
    } finally {
        await relay.close();
    }
});
