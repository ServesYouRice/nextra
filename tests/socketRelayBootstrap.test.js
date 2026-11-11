const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const config = require('../config');
const { findRoomBySocket, destroyRoom } = require('../lib/rooms');
const { registerSocketHandlers, stopJoinCleanup, __testing } = require('../lib/socket');
const { NON_SYNC, box, fragment, initSegment, traf } = require('./mp4Boxes');

// Every test here joins its viewers from 127.0.0.1: more joins than the
// per-address limit allows in a minute.
config.JOIN_RATE_LIMIT_MAX = 1000;

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
        serverSocketOf: (client) => ioServer.sockets.sockets.get(client.id),
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

// ── A later relay viewer's bootstrap against the server's slow-viewer cap ──
//
// The bootstrap goes out in the start acknowledgement as one write, and the
// cap (RELAY_SOCKET_MAX_BUFFERED_BYTES) is measured on what the viewer's socket
// still holds. Node counts a write there in full until its last byte has left
// the process. On Linux and macOS libuv holds whatever the kernel's send buffer
// could not take, so the bootstrap stays counted for as long as the link needs
// to carry it. Windows takes even a 24 MB write on loopback at once, so these
// tests stall the viewer's link themselves: past a small send buffer, a write
// waits whole until the test lets the reader go on.

function stallLink(netSocket, sendBufferBytes = 64 * 1024) {
    const write = netSocket._write;
    const writev = netSocket._writev;
    let stalled = false;
    let taken = 0;
    let held = null;
    const pass = (bytes, run) => {
        if (stalled && taken + bytes > sendBufferBytes) {
            held = run;
            return;
        }
        taken += bytes;
        run();
    };
    netSocket._write = function stalledWrite(chunk, encoding, callback) {
        pass(Buffer.byteLength(chunk), () => write.call(this, chunk, encoding, callback));
    };
    netSocket._writev = function stalledWritev(chunks, callback) {
        const bytes = chunks.reduce((sum, { chunk }) => sum + Buffer.byteLength(chunk), 0);
        pass(bytes, () => writev.call(this, chunks, callback));
    };
    return {
        stall() {
            stalled = true;
            taken = 0;
        },
        resume() {
            stalled = false;
            const run = held;
            held = null;
            if (run) run();
        },
    };
}

async function until(condition, what, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

// Sends live 1 MB chunks, each delivered to `watcher` before the next, until the
// server drops `viewer` from the relay audience. Returns how many it was sent.
async function liveMegabytesUntilDropped(relay, watcher, viewer, limit = 64) {
    for (let sent = 0; sent < limit; sent += 1) {
        const delivered = nextEvent(watcher, 'media-chunk', () => true);
        relay.fromHost('media-chunk', { generation: 1, chunk: Buffer.alloc(MB, sent % 251) });
        await delivered;
        if (!relay.room.relayViewers.has(viewer.id)) return sent;
    }
    return null;
}

// A start whose answer the test may never wait for, when an assertion fails
// first: its rejection at close must not take the place of that failure.
function abandonable(promise) {
    promise.catch(() => {});
    return promise;
}

function recordTransportFailures(client) {
    const failures = [];
    client.on('transport-failed', (state) => failures.push(state));
    return failures;
}

test('a late relay viewer whose link has not taken its bootstrap yet keeps receiving the live chunks', { concurrency: false }, async () => {
    const { RELAY_QUEUE_MAX_BYTES } = await loadRelayQueue();
    const relay = await startRelayRoom({}, ['first', 'late']);
    const [firstViewer, lateViewer] = relay.viewers;
    const link = stallLink(relay.serverSocketOf(lateViewer).request.socket);
    const transportFailures = recordTransportFailures(lateViewer);
    try {
        await startWebmGeneration(relay, firstViewer);
        // A bootstrap at the ceiling, above the cap.
        const recorded = await recordWebm(relay, firstViewer, RELAY_QUEUE_MAX_BYTES, MB);
        link.stall();
        const starting = abandonable(startLateRelayViewer(lateViewer));
        await until(() => relay.room.relayViewers.has(lateViewer.id), 'the late start');

        // 2.4 s of the 14 Mbps relay tier queue behind the bootstrap.
        const slice = Buffer.alloc(525_000, 0xee);
        const slices = 8;
        assert.ok(slices * slice.length < config.RELAY_SOCKET_MAX_BUFFERED_BYTES);
        for (let index = 0; index < slices; index += 1) {
            const delivered = nextEvent(firstViewer, 'media-chunk', () => true);
            relay.fromHost('media-chunk', { generation: 1, chunk: slice });
            await delivered;
        }
        assert.equal(relay.room.relayViewers.has(lateViewer.id), true, 'still a relay viewer');

        link.resume();
        const late = await starting;
        await until(() => late.sourceBuffer.appended.length > 0, 'the first append');
        late.sourceBuffer.finishAll();
        await until(() => {
            late.sourceBuffer.finishAll();
            return late.sourceBuffer.appended.length === 1 + slices;
        }, 'every live slice');
        assert.deepEqual(transportFailures, []);
        assert.deepEqual(late.failures, []);
        assert.ok(late.sourceBuffer.appended[0].equals(Buffer.concat(recorded)));
        assert.ok(late.sourceBuffer.appended.slice(1).every((chunk) => chunk.equals(slice)));
    } finally {
        link.resume();
        await relay.close();
    }
});

// The bootstrap is left out of the cap, the live chunks behind it are not: a
// viewer whose live backlog keeps growing is dropped at the cap, as before.
// That holds for any cap, so the bootstrap ceiling and the cap no longer have to
// be kept in step: here a bootstrap at the ceiling meets the default cap and
// one a sixth of its size.
for (const capBytes of [config.RELAY_SOCKET_MAX_BUFFERED_BYTES, 4 * MB]) {
    test(`the slow-viewer cap (${capBytes / MB} MB) still drops a late relay viewer whose live backlog passes it while the bootstrap is on the way`, { concurrency: false }, async () => {
        const { RELAY_QUEUE_MAX_BYTES } = await loadRelayQueue();
        const defaultCap = config.RELAY_SOCKET_MAX_BUFFERED_BYTES;
        const relay = await startRelayRoom({}, ['first', 'late']);
        const [firstViewer, lateViewer] = relay.viewers;
        const link = stallLink(relay.serverSocketOf(lateViewer).request.socket);
        const transportFailures = recordTransportFailures(lateViewer);
        try {
            await startWebmGeneration(relay, firstViewer);
            await recordWebm(relay, firstViewer, RELAY_QUEUE_MAX_BYTES, MB);
            config.RELAY_SOCKET_MAX_BUFFERED_BYTES = capBytes;
            link.stall();
            const starting = abandonable(request(lateViewer, 'relay-consume-start'));
            await until(() => relay.room.relayViewers.has(lateViewer.id), 'the late start');

            // Each chunk carries a few bytes of framing, so the one after the
            // cap's worth finds the viewer's live backlog just over the cap.
            assert.equal(await liveMegabytesUntilDropped(relay, firstViewer, lateViewer), capBytes / MB);
            link.resume();
            assert.equal((await starting).bootstrapChunks[0].length, RELAY_QUEUE_MAX_BYTES);
            await until(() => transportFailures.length > 0, 'the drop notice');
            assert.equal(transportFailures[0].code, 'relay-backpressure');
        } finally {
            config.RELAY_SOCKET_MAX_BUFFERED_BYTES = defaultCap;
            link.resume();
            await relay.close();
        }
    });
}

// Once the bootstrap has left the process, the cap counts everything again.
test('the slow-viewer cap drops a relay viewer at the same live backlog once its bootstrap has been written', { concurrency: false }, async () => {
    const relay = await startRelayRoom({}, ['first', 'late']);
    const [firstViewer, lateViewer] = relay.viewers;
    const serverLate = relay.serverSocketOf(lateViewer);
    const link = stallLink(serverLate.request.socket);
    try {
        await startWebmGeneration(relay, firstViewer);
        await recordWebm(relay, firstViewer, 20 * MB, MB);
        const start = await request(lateViewer, 'relay-consume-start');
        assert.equal(start.bootstrapChunks[0].length, 20 * MB);
        await until(() => __testing.getSocketBufferedBytes(serverLate) === 0, 'the bootstrap to be written');

        link.stall();
        assert.equal(await liveMegabytesUntilDropped(relay, firstViewer, lateViewer), config.RELAY_SOCKET_MAX_BUFFERED_BYTES / MB);
        link.resume();
    } finally {
        link.resume();
        await relay.close();
    }
});

test('without Engine.IO send callbacks a bootstrap counts toward the slow-viewer cap, with one warning', { concurrency: false }, () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(message);
    __testing.resetEngineSendCallbackWarning();
    try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const socket = { conn: { writeBuffer: [{ type: 'message', data: Buffer.alloc(100) }] } };
            __testing.trackRelayBootstrap(socket, 100);
            assert.equal(__testing.getRelayBacklogBytes(socket), 100);
        }
    } finally {
        console.warn = originalWarn;
        __testing.resetEngineSendCallbackWarning();
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /send callbacks are unavailable/);
});

// The MP4 path applies the same cap to the init segment and the GOP in progress.
test('a late MP4 relay viewer whose link has not taken its bootstrap yet stays in the relay audience', { concurrency: false }, async () => {
    const relay = await startRelayRoom({}, ['first', 'late']);
    const [firstViewer, lateViewer] = relay.viewers;
    const link = stallLink(relay.serverSocketOf(lateViewer).request.socket);
    const transportFailures = recordTransportFailures(lateViewer);
    const send = (bytes) => {
        for (let offset = 0; offset < bytes.length; offset += MB) {
            relay.fromHost('media-chunk', { generation: 1, chunk: bytes.subarray(offset, offset + MB) });
        }
    };
    try {
        assert.equal((await request(firstViewer, 'relay-consume-start')).success, true);
        relay.host.emit('media-init', { mimeType: MP4_MIME, generation: 1 });
        await request(relay.host, 'get-media-init');
        const key = keyFragment(20 * MB);
        const keyArrived = nextEvent(firstViewer, 'media-chunk', ({ chunk }) => chunk.byteLength === key.length);
        send(init);
        send(key);
        await keyArrived;

        link.stall();
        const starting = abandonable(request(lateViewer, 'relay-consume-start'));
        await until(() => relay.room.relayViewers.has(lateViewer.id), 'the late start');
        const delta = deltaFragment(1000);
        const deltaArrived = nextEvent(firstViewer, 'media-chunk', ({ chunk }) => Buffer.from(chunk).equals(delta));
        send(delta);
        await deltaArrived;
        assert.equal(relay.room.relayViewers.has(lateViewer.id), true, 'still a relay viewer');

        link.resume();
        const start = await starting;
        assert.equal(start.bootstrapComplete, true);
        assert.ok(Buffer.from(start.bootstrapChunks[0]).equals(Buffer.concat([init, key])));
        await request(lateViewer, 'get-media-init');
        assert.deepEqual(transportFailures, []);
    } finally {
        link.resume();
        await relay.close();
    }
});

// From its start acknowledgement on, a later viewer receives every live chunk,
// and they continue the bootstrap the acknowledgement carries. The
// acknowledgement names their generation, so the viewer can take them from the
// moment it is answered instead of waiting for get-media-init.
test('a relay start acknowledgement names the generation of its bootstrap and of the live chunks after it', { concurrency: false }, async () => {
    const relay = await startRelayRoom({}, ['first', 'late']);
    const [firstViewer, lateViewer] = relay.viewers;
    try {
        const firstStart = await request(firstViewer, 'relay-consume-start');
        assert.equal(firstStart.success, true);
        assert.equal(firstStart.generation, null, 'the first relay viewer waits for a new generation');

        relay.host.emit('media-init', { mimeType: 'video/webm;codecs=vp8,opus', generation: 4 });
        for (let index = 0; index < 5; index += 1) {
            relay.host.emit('media-chunk', { generation: 4, chunk: Buffer.from([index]) });
        }
        await nextEvent(firstViewer, 'media-chunk', ({ chunk }) => Buffer.from(chunk)[0] === 4);

        const lateChunks = [];
        lateViewer.on('media-chunk', ({ generation, chunk }) => lateChunks.push([generation, Buffer.from(chunk)[0]]));
        const lateStart = await request(lateViewer, 'relay-consume-start');
        assert.equal(lateStart.success, true);
        assert.equal(lateStart.generation, 4);
        assert.deepEqual(Buffer.from(lateStart.bootstrapChunks[0]), Buffer.from([0, 1, 2, 3, 4]));

        for (let index = 5; index < 8; index += 1) {
            relay.host.emit('media-chunk', { generation: 4, chunk: Buffer.from([index]) });
        }
        await nextEvent(lateViewer, 'media-chunk', ({ chunk }) => Buffer.from(chunk)[0] === 7);
        assert.deepEqual(lateChunks, [[4, 5], [4, 6], [4, 7]], 'the live chunks after the answer, in the named generation');
    } finally {
        await relay.close();
    }
});
