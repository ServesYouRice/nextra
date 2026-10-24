const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

class FakeEventTarget {
    constructor() {
        this.listeners = new Map();
    }

    addEventListener(event, listener) {
        const listeners = this.listeners.get(event) || new Set();
        listeners.add(listener);
        this.listeners.set(event, listeners);
    }

    removeEventListener(event, listener) {
        this.listeners.get(event)?.delete(listener);
    }

    dispatch(event) {
        for (const listener of this.listeners.get(event) || []) listener();
    }

    listenerCount(event) {
        return this.listeners.get(event)?.size || 0;
    }
}

function timeRanges(list) {
    return {
        length: list.length,
        start: (index) => list[index][0],
        end: (index) => list[index][1],
    };
}

class FakeSourceBuffer extends FakeEventTarget {
    static holdUpdates = false;
    static supportsChangeType = true;

    constructor() {
        super();
        this.updating = false;
        this.appended = [];
        this.aborted = false;
        this.removed = [];
        this.mode = 'segments';
        this.changedTypes = [];
        this.buffered = timeRanges([[0, 2]]);
        if (FakeSourceBuffer.supportsChangeType) {
            this.changeType = (mimeType) => { this.changedTypes.push(mimeType); };
        }
    }

    appendBuffer(value) {
        this.appended.push(new Uint8Array(value));
        this.updating = true;
        if (FakeSourceBuffer.holdUpdates) return;
        queueMicrotask(() => {
            this.updating = false;
            this.dispatch('updateend');
        });
    }

    abort() {
        this.aborted = true;
        this.updating = false;
    }

    remove(start, end) {
        this.removed.push({ start, end });
    }
}

class FakeMediaSource extends FakeEventTarget {
    static instances = [];

    static isTypeSupported(mimeType) {
        return mimeType.includes('avc1');
    }

    constructor() {
        super();
        this.readyState = 'closed';
        this.sourceBuffers = [];
        this.removedSourceBuffers = [];
        FakeMediaSource.instances.push(this);
    }

    open() {
        this.readyState = 'open';
        this.dispatch('sourceopen');
    }

    addSourceBuffer() {
        const sourceBuffer = new FakeSourceBuffer();
        this.sourceBuffers.push(sourceBuffer);
        return sourceBuffer;
    }

    removeSourceBuffer(sourceBuffer) {
        this.removedSourceBuffers.push(sourceBuffer);
    }

    endOfStream() {
        this.readyState = 'ended';
    }
}

class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.requests = [];
    }

    emit(event, ...args) {
        if (event === 'get-media-init' || event === 'fallback-consume-start') {
            this.requests.push({ event, payload: args[0] });
            args[1]?.({ success: false });
            return true;
        }
        return super.emit(event, ...args);
    }

    serverEmit(event, payload) {
        return super.emit(event, payload);
    }
}

class FakeVideoElement extends FakeEventTarget {
    constructor() {
        super();
        this.src = '';
        this.currentTime = 0;
        this.paused = true;
        this.readyState = 4;
        this.muted = false;
        this.playbackRate = 1;
        this.loadCalls = 0;
    }

    async play() {
        this.paused = false;
        this.dispatch('playing');
    }

    load() {
        this.loadCalls += 1;
    }
}

function flushTasks() {
    return new Promise((resolve) => setImmediate(resolve));
}

const MIME = 'video/mp4; codecs="avc1.640032, mp4a.40.2"';

function installMediaSource(t, { url = () => 'blob:relay' } = {}) {
    const originalMediaSource = global.MediaSource;
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revokedUrls = [];
    FakeMediaSource.instances = [];
    FakeSourceBuffer.holdUpdates = false;
    FakeSourceBuffer.supportsChangeType = true;
    global.MediaSource = FakeMediaSource;
    URL.createObjectURL = url;
    URL.revokeObjectURL = (value) => revokedUrls.push(value);
    t.after(() => {
        FakeSourceBuffer.holdUpdates = false;
        FakeSourceBuffer.supportsChangeType = true;
        global.MediaSource = originalMediaSource;
        URL.createObjectURL = originalCreateObjectUrl;
        URL.revokeObjectURL = originalRevokeObjectUrl;
    });
    return revokedUrls;
}

async function startPlayer(t, { onStateChange } = {}) {
    const { createFmp4RelayPlayer } = await import('../src/lib/fmp4RelayPlayer.js');
    const socket = new FakeSocket();
    const video = new FakeVideoElement();
    const player = createFmp4RelayPlayer({ videoElement: video, socket, roomCode: 'ABC123', onStateChange });
    t.after(() => player.stop());
    player.start();
    return { player, socket, video };
}

// Brings a player up to the point where the first fragment has been appended.
async function startPlaying(t, options) {
    const context = await startPlayer(t, options);
    context.socket.serverEmit('media-init', { generation: 1, mimeType: MIME, initSegment: Uint8Array.of(1, 2) });
    const mediaSource = FakeMediaSource.instances[0];
    mediaSource.open();
    await flushTasks();
    context.socket.serverEmit('media-chunk', { generation: 1, sequence: 1, keyframeStart: true, chunk: Uint8Array.of(3, 4) });
    await flushTasks();
    return { ...context, mediaSource, sourceBuffer: mediaSource.sourceBuffers[0] };
}

test('fMP4 relay player lays fragments end to end and starts a cushion behind live', { concurrency: false }, async (t) => {
    installMediaSource(t);
    const states = [];
    const { video, sourceBuffer, socket } = await startPlaying(t, { onStateChange: (state) => states.push(state) });

    assert.equal(socket.listenerCount('media-init'), 1);
    assert.equal(socket.listenerCount('media-chunk'), 1);
    assert.equal(socket.requests[0].event, 'get-media-init');
    // Skipped fragments and encoder restarts must not leave holes in the timeline.
    assert.equal(sourceBuffer.mode, 'sequence');
    assert.equal(sourceBuffer.appended.length, 2);
    // Two seconds buffered: playback starts half a second behind the end of it.
    assert.equal(video.paused, false);
    assert.equal(video.currentTime, 1.5);
    assert.ok(states.includes('playing'));
});

test('fMP4 relay player waits for enough media before it starts', { concurrency: false }, async (t) => {
    installMediaSource(t);
    const { socket, video } = await startPlayer(t);
    socket.serverEmit('media-init', { generation: 1, mimeType: MIME, initSegment: Uint8Array.of(1, 2) });
    const mediaSource = FakeMediaSource.instances[0];
    mediaSource.open();
    mediaSource.sourceBuffers[0].buffered = timeRanges([]);
    await flushTasks();
    assert.equal(video.paused, true);

    mediaSource.sourceBuffers[0].buffered = timeRanges([[10, 10.1]]);
    socket.serverEmit('media-chunk', { generation: 1, sequence: 1, keyframeStart: true, chunk: Uint8Array.of(3) });
    await flushTasks();
    assert.equal(video.paused, true, 'a tenth of a second is not enough to start on');

    mediaSource.sourceBuffers[0].buffered = timeRanges([[10, 10.4]]);
    socket.serverEmit('media-chunk', { generation: 1, sequence: 2, chunk: Uint8Array.of(4) });
    await flushTasks();
    assert.equal(video.paused, false);
    assert.equal(video.currentTime, 10);
});

test('fMP4 relay player carries on in the same buffer when the encoder restarts', { concurrency: false }, async (t) => {
    const revokedUrls = installMediaSource(t);
    const { player, socket, video, mediaSource, sourceBuffer } = await startPlaying(t);

    // A bitrate change: a new generation, same kind of stream.
    socket.serverEmit('media-init', { generation: 2, mimeType: MIME, initSegment: Uint8Array.of(7, 8) });
    await flushTasks();
    assert.equal(FakeMediaSource.instances.length, 1, 'the player must not be rebuilt');
    assert.deepEqual([...sourceBuffer.appended.at(-1)], [7, 8]);
    assert.equal(player.getState().generation, 2);

    // Fragments of the old generation that are still on their way are ignored.
    socket.serverEmit('media-chunk', { generation: 1, sequence: 2, chunk: Uint8Array.of(9) });
    socket.serverEmit('media-chunk', { generation: 2, sequence: 1, keyframeStart: true, chunk: Uint8Array.of(5, 6) });
    await flushTasks();
    assert.deepEqual([...sourceBuffer.appended.at(-1)], [5, 6]);
    assert.equal(sourceBuffer.appended.length, 4);

    // A different profile is switched into the same buffer too.
    const otherMime = 'video/mp4; codecs="avc1.640028, mp4a.40.2"';
    socket.serverEmit('media-init', { generation: 3, mimeType: otherMime, initSegment: Uint8Array.of(1) });
    await flushTasks();
    assert.equal(FakeMediaSource.instances.length, 1);
    assert.deepEqual(sourceBuffer.changedTypes, [otherMime]);

    player.stop();
    assert.equal(socket.listenerCount('media-init'), 0);
    assert.equal(socket.listenerCount('media-chunk'), 0);
    assert.deepEqual(revokedUrls, ['blob:relay']);
    assert.equal(sourceBuffer.listenerCount('updateend'), 0);
    assert.equal(sourceBuffer.listenerCount('error'), 0);
    assert.equal(video.listenerCount('waiting'), 0);
    assert.equal(video.listenerCount('playing'), 0);
    assert.deepEqual(mediaSource.removedSourceBuffers, [sourceBuffer]);
    assert.equal(video.src, '');
    assert.equal(video.loadCalls, 1);
    assert.equal(video.playbackRate, 1);
    assert.deepEqual(player.getState(), {
        state: 'stopped',
        generation: -1,
        queueLength: 0,
        queueBytes: 0,
        mimeType: otherMime,
    });
});

test('fMP4 relay player rebuilds when the browser cannot switch codecs in place', { concurrency: false }, async (t) => {
    let nextUrl = 1;
    const revokedUrls = installMediaSource(t, { url: () => `blob:relay-${nextUrl++}` });
    FakeSourceBuffer.supportsChangeType = false;
    const { socket, mediaSource, sourceBuffer } = await startPlaying(t);

    socket.serverEmit('media-init', {
        generation: 2,
        mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
        initSegment: Uint8Array.of(7, 8),
    });
    assert.equal(FakeMediaSource.instances.length, 2);
    assert.deepEqual(revokedUrls, ['blob:relay-1']);
    assert.equal(sourceBuffer.listenerCount('updateend'), 0);
    assert.deepEqual(mediaSource.removedSourceBuffers, [sourceBuffer]);
});

test('fMP4 relay player keeps its cushion by nudging the playback rate', { concurrency: false }, async (t) => {
    installMediaSource(t);
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
    const { video, sourceBuffer } = await startPlaying(t);
    assert.equal(video.currentTime, 1.5);

    // On target: left alone.
    t.mock.timers.tick(250);
    assert.equal(video.playbackRate, 1);

    // A little too far behind live: play slightly faster, do not jump.
    sourceBuffer.buffered = timeRanges([[0, 2.5]]);
    t.mock.timers.tick(250);
    assert.ok(video.playbackRate > 1 && video.playbackRate <= 1.2, `rate ${video.playbackRate}`);
    assert.equal(video.currentTime, 1.5);

    // Running low: ease off instead of running dry.
    sourceBuffer.buffered = timeRanges([[0, 1.6]]);
    t.mock.timers.tick(250);
    assert.ok(video.playbackRate < 1 && video.playbackRate >= 0.92, `rate ${video.playbackRate}`);

    // Seconds behind (a tab that was in the background): jump to the cushion.
    sourceBuffer.buffered = timeRanges([[0, 6]]);
    t.mock.timers.tick(250);
    assert.equal(video.currentTime, 5.5);
    assert.equal(video.playbackRate, 1);
});

test('fMP4 relay player grows its cushion when playback runs dry', { concurrency: false }, async (t) => {
    installMediaSource(t);
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
    const { video, sourceBuffer } = await startPlaying(t);

    // 0.85 s ahead is more than the half-second cushion: the player speeds up.
    sourceBuffer.buffered = timeRanges([[0, 2.35]]);
    t.mock.timers.tick(250);
    assert.ok(video.playbackRate > 1);

    // After a stall the same 0.85 s is exactly the cushion it wants.
    video.dispatch('waiting');
    t.mock.timers.tick(250);
    assert.equal(video.playbackRate, 1);
});

test('fMP4 relay player does not blame the connection for a stall while the encoder restarts', { concurrency: false }, async (t) => {
    installMediaSource(t);
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
    const { socket, video, sourceBuffer } = await startPlaying(t);
    t.mock.timers.tick(10_000);

    // The server changes bitrate: a new generation continues in the same buffer.
    socket.serverEmit('media-init', { generation: 2, mimeType: MIME, initSegment: Uint8Array.of(1) });
    await flushTasks();
    // Nothing arrives while the encoder restarts, and playback runs dry.
    video.dispatch('waiting');

    // 0.85 s ahead is still more than the cushion, which did not grow.
    video.currentTime = 1.5;
    sourceBuffer.buffered = timeRanges([[0, 2.35]]);
    t.mock.timers.tick(250);
    assert.ok(video.playbackRate > 1, `rate ${video.playbackRate}`);

    // A stall later on is the connection's doing again.
    t.mock.timers.tick(3000);
    video.currentTime = 1.5;
    video.dispatch('waiting');
    t.mock.timers.tick(250);
    assert.equal(video.playbackRate, 1);
});

test('fMP4 relay player returns to the live range when the playhead is left in a played-out one', { concurrency: false }, async (t) => {
    installMediaSource(t);
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
    const { video, sourceBuffer } = await startPlaying(t);

    // Still inside an earlier range with media left to play: leave it.
    sourceBuffer.buffered = timeRanges([[0, 2], [2.3, 3.3]]);
    video.currentTime = 1.5;
    t.mock.timers.tick(250);
    assert.equal(video.currentTime, 1.5);

    // Played to the end of it: hop to the live range.
    video.currentTime = 1.98;
    t.mock.timers.tick(250);
    assert.equal(video.currentTime, 2.8);
});

test('fMP4 relay player holds more in reserve while the server tests the link', { concurrency: false }, async (t) => {
    installMediaSource(t);
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
    const { socket, video, sourceBuffer } = await startPlaying(t);
    t.mock.timers.tick(10_000);

    // Half a second ahead is on target.
    video.currentTime = 1.5;
    sourceBuffer.buffered = timeRanges([[0, 2]]);
    t.mock.timers.tick(250);
    assert.equal(video.playbackRate, 1);

    // Filler arrives with every fragment for the length of a test. The cushion
    // goes up once, not once per piece: half a second is now too little, and
    // the player eases off to build more.
    for (let i = 0; i < 20; i++) {
        socket.serverEmit('relay-filler', Uint8Array.of(1, 2, 3));
        t.mock.timers.tick(50);
    }
    video.currentTime = 1.5;
    sourceBuffer.buffered = timeRanges([[0, 2]]);
    t.mock.timers.tick(250);
    assert.ok(video.playbackRate < 1, `rate ${video.playbackRate}`);
    video.currentTime = 1.5;
    sourceBuffer.buffered = timeRanges([[0, 2.3]]);
    t.mock.timers.tick(250);
    assert.equal(video.playbackRate, 1);

    // The switch itself puts the cushion back where it started.
    socket.serverEmit('media-init', { generation: 2, mimeType: MIME, initSegment: Uint8Array.of(1) });
    await flushTasks();
    video.currentTime = 1.5;
    sourceBuffer.buffered = timeRanges([[0, 2.3]]);
    t.mock.timers.tick(250);
    assert.ok(video.playbackRate > 1, `rate ${video.playbackRate}`);
});

test('fMP4 relay player gives the reserve back when the test ends without a switch', { concurrency: false }, async (t) => {
    installMediaSource(t);
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
    const { socket, video, sourceBuffer } = await startPlaying(t);
    t.mock.timers.tick(10_000);

    for (let i = 0; i < 20; i++) {
        socket.serverEmit('relay-filler', Uint8Array.of(1, 2, 3));
        t.mock.timers.tick(50);
    }
    // 0.8 s ahead is what the player wants while a switch may be coming.
    video.currentTime = 1.5;
    sourceBuffer.buffered = timeRanges([[0, 2.3]]);
    t.mock.timers.tick(250);
    assert.equal(video.playbackRate, 1);

    // The filler stopped and no switch followed: the link had no room. The
    // extra delay is not kept; the player catches up to its usual cushion.
    t.mock.timers.tick(2500);
    video.currentTime = 1.5;
    sourceBuffer.buffered = timeRanges([[0, 2.3]]);
    t.mock.timers.tick(250);
    assert.ok(video.playbackRate > 1, `rate ${video.playbackRate}`);

    // The next test raises it again, by the same amount and no more.
    for (let i = 0; i < 20; i++) {
        socket.serverEmit('relay-filler', Uint8Array.of(1, 2, 3));
        t.mock.timers.tick(50);
    }
    video.currentTime = 1.5;
    sourceBuffer.buffered = timeRanges([[0, 2.3]]);
    t.mock.timers.tick(250);
    assert.equal(video.playbackRate, 1);
});

test('fMP4 relay player steps over the hole an encoder restart leaves, at once', { concurrency: false }, async (t) => {
    installMediaSource(t);
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
    const { video, sourceBuffer } = await startPlaying(t);
    t.mock.timers.tick(10_000);

    // The old stream ends at 2.000 and the new one begins 28 ms later: less than
    // a frame, and enough for the browser to stop and wait.
    sourceBuffer.buffered = timeRanges([[0, 2], [2.028, 2.6]]);
    video.currentTime = 1.99;
    video.dispatch('waiting');
    assert.equal(video.currentTime, 2.1);

    // That was not the connection running dry: the cushion is what it was, so
    // half a second ahead is on target and the player leaves the rate alone.
    sourceBuffer.buffered = timeRanges([[0, 2], [2.028, 2.6]]);
    t.mock.timers.tick(250);
    assert.equal(video.playbackRate, 1);
    assert.equal(video.currentTime, 2.1);
});

test('fMP4 relay player bounds an overflowing queue and requests a fresh generation', { concurrency: false }, async (t) => {
    installMediaSource(t);
    FakeSourceBuffer.holdUpdates = true;
    const states = [];
    const { player, socket } = await startPlayer(t, { onStateChange: (state) => states.push(state) });
    socket.serverEmit('media-init', { generation: 7, mimeType: MIME, initSegment: Uint8Array.of(1) });
    FakeMediaSource.instances[0].open();
    await flushTasks();

    for (let sequence = 1; sequence <= 700; sequence += 1) {
        socket.serverEmit('media-chunk', {
            generation: 7,
            sequence,
            chunk: Uint8Array.of(sequence % 255),
        });
    }
    await flushTasks();

    assert.ok(socket.requests.filter(({ event }) => event === 'get-media-init').length >= 2);
    assert.equal(player.getState().queueLength, 0);
    assert.equal(player.getState().queueBytes, 0);
    assert.ok(states.includes('buffering'));
    // FakeSocket answers the fresh-init request with "unavailable". That is
    // retried (see the VAL-093 tests), not a terminal error.
    assert.equal(states.at(-1), 'buffering');
});

test('fMP4 relay player reports an unsupported browser when MediaSource is missing', { concurrency: false }, async (t) => {
    const originalMediaSource = global.MediaSource;
    delete global.MediaSource;
    t.after(() => {
        global.MediaSource = originalMediaSource;
    });

    const { createFmp4RelayPlayer } = await import('../src/lib/fmp4RelayPlayer.js');
    const { RELAY_PLAYBACK_UNSUPPORTED_MESSAGE } = await import('../src/lib/watchPlaybackMode.mjs');
    const socket = new FakeSocket();
    const states = [];
    const errors = [];
    const player = createFmp4RelayPlayer({
        videoElement: new FakeVideoElement(),
        socket,
        roomCode: 'ABC123',
        onStateChange: (state) => states.push(state),
        onError: (message) => errors.push(message),
    });

    player.start();
    socket.serverEmit('media-init', {
        generation: 1,
        mimeType: 'video/mp4; codecs="avc1.42e01f"',
        initSegment: Uint8Array.of(1, 2),
    });

    assert.deepEqual(errors, [RELAY_PLAYBACK_UNSUPPORTED_MESSAGE]);
    assert.equal(states.at(-1), 'error');
    player.stop();
});

test('fMP4 relay player uses ManagedMediaSource and disables remote playback when MediaSource is missing', { concurrency: false }, async (t) => {
    const originalMediaSource = global.MediaSource;
    const originalManagedMediaSource = global.ManagedMediaSource;
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    delete global.MediaSource;
    FakeMediaSource.instances = [];
    global.ManagedMediaSource = FakeMediaSource;
    URL.createObjectURL = () => 'blob:managed-1';
    URL.revokeObjectURL = () => {};
    t.after(() => {
        global.MediaSource = originalMediaSource;
        global.ManagedMediaSource = originalManagedMediaSource;
        URL.createObjectURL = originalCreateObjectUrl;
        URL.revokeObjectURL = originalRevokeObjectUrl;
    });

    const { createFmp4RelayPlayer } = await import('../src/lib/fmp4RelayPlayer.js');
    const socket = new FakeSocket();
    const video = new FakeVideoElement();
    const player = createFmp4RelayPlayer({ videoElement: video, socket, roomCode: 'ABC123' });

    player.start();
    socket.serverEmit('media-init', {
        generation: 1,
        mimeType: 'video/mp4; codecs="avc1.42e01f"',
        initSegment: Uint8Array.of(1, 2),
    });

    assert.equal(FakeMediaSource.instances.length, 1);
    assert.equal(video.disableRemotePlayback, true);
    assert.equal(video.src, 'blob:managed-1');
    player.stop();
});

// A socket that keeps every acknowledgement until the test answers it, so a test
// decides when a get-media-init (or fallback-consume-start) reply arrives.
class HeldAckSocket extends EventEmitter {
    constructor() {
        super();
        this.requests = [];
    }

    emit(event, ...args) {
        if (event === 'get-media-init' || event === 'fallback-consume-start') {
            this.requests.push({ event, payload: args[0], ack: args[1] });
            return true;
        }
        return super.emit(event, ...args);
    }

    serverEmit(event, payload) {
        return super.emit(event, payload);
    }

    pending(event) {
        return this.requests.filter((request) => request.event === event);
    }
}

function initAnswer(generation) {
    return {
        success: true,
        initSegment: Uint8Array.of(1, 2),
        init: { generation, mimeType: MIME },
    };
}

async function startHeldPlayer(t) {
    const { createFmp4RelayPlayer } = await import('../src/lib/fmp4RelayPlayer.js');
    const socket = new HeldAckSocket();
    const video = new FakeVideoElement();
    const states = [];
    const errors = [];
    const player = createFmp4RelayPlayer({
        videoElement: video,
        socket,
        roomCode: 'ABC123',
        onStateChange: (state) => states.push(state),
        onError: (message) => errors.push(message),
    });
    t.after(() => player.stop());
    player.start();
    return { player, socket, video, states, errors };
}

// Plays generation 1 (pushed by the server), leaving the first get-media-init unanswered.
async function startHeldPlaying(t) {
    const context = await startHeldPlayer(t);
    context.socket.serverEmit('media-init', { generation: 1, mimeType: MIME, initSegment: Uint8Array.of(1, 2) });
    const mediaSource = FakeMediaSource.instances.at(-1);
    mediaSource.open();
    await flushTasks();
    context.socket.serverEmit('media-chunk', { generation: 1, sequence: 1, keyframeStart: true, chunk: Uint8Array.of(3, 4) });
    await flushTasks();
    return { ...context, mediaSource, sourceBuffer: mediaSource.sourceBuffers[0] };
}

function assertPlayerStayedStopped({ player, video, states, errors }, before) {
    assert.equal(FakeMediaSource.instances.length, before.mediaSources, 'no MediaSource is built after stop()');
    assert.equal(video.src, '', 'the video element is left empty');
    assert.equal(player.getState().state, 'stopped');
    assert.equal(player.getState().generation, -1);
    assert.deepEqual(states.slice(before.states), [], 'no state change after stop()');
    assert.deepEqual(errors, [], 'no error after stop()');
}

test('VAL-092: an init answer that arrives after stop() leaves a stopped player alone', { concurrency: false }, async (t) => {
    installMediaSource(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const context = await startHeldPlayer(t);
    const { player, socket } = context;
    const [request] = socket.pending('get-media-init');
    player.stop();
    const before = { mediaSources: FakeMediaSource.instances.length, states: context.states.length };

    request.ack(initAnswer(3));
    assertPlayerStayedStopped(context, before);

    request.ack({ success: false });
    assertPlayerStayedStopped(context, before);
    t.mock.timers.tick(120_000);
    assert.equal(socket.pending('get-media-init').length, 1, 'a stopped player asks for nothing more');
    assertPlayerStayedStopped(context, before);
});

test('VAL-092: a reset recovery answer that arrives after stop() leaves a stopped player alone', { concurrency: false }, async (t) => {
    installMediaSource(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const context = await startHeldPlaying(t);
    const { player, socket, sourceBuffer } = context;

    sourceBuffer.dispatch('error');
    const requests = socket.pending('get-media-init');
    assert.equal(requests.length, 2, 'the SourceBuffer error asked for a fresh init');
    player.stop();
    const before = { mediaSources: FakeMediaSource.instances.length, states: context.states.length };

    requests[1].ack(initAnswer(2));
    assertPlayerStayedStopped(context, before);

    requests[1].ack({ success: false });
    assertPlayerStayedStopped(context, before);
    t.mock.timers.tick(120_000);
    assert.equal(socket.pending('get-media-init').length, 2);
    assertPlayerStayedStopped(context, before);
});

test('VAL-092: an init answer from before stop() is ignored by the same player started again', { concurrency: false }, async (t) => {
    installMediaSource(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { player, socket } = await startHeldPlayer(t);
    const [before] = socket.pending('get-media-init');
    player.stop();
    player.start();
    const [, after] = socket.pending('get-media-init');
    assert.ok(after, 'start() asked again');

    before.ack(initAnswer(5));
    assert.equal(FakeMediaSource.instances.length, 0, 'the answer of the earlier run builds nothing');
    assert.equal(player.getState().generation, -1);

    after.ack(initAnswer(5));
    assert.equal(FakeMediaSource.instances.length, 1);
    assert.equal(player.getState().generation, 5);
});

test('VAL-092: an init answer that a newer request has replaced is ignored', { concurrency: false }, async (t) => {
    installMediaSource(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { player, socket } = await startHeldPlayer(t);
    const [older] = socket.pending('get-media-init');

    // Nothing came back in time: the player asks again.
    t.mock.timers.tick(15_000);
    const [consume] = socket.pending('fallback-consume-start');
    consume.ack({});
    const [, newer] = socket.pending('get-media-init');
    assert.ok(newer, 'the timeout sent a newer request');

    older.ack(initAnswer(4));
    assert.equal(FakeMediaSource.instances.length, 0, 'the older answer builds nothing');
    assert.equal(player.getState().generation, -1);

    newer.ack(initAnswer(4));
    assert.equal(FakeMediaSource.instances.length, 1);
    assert.equal(player.getState().generation, 4);
});

test('VAL-093: reset recovery retries an init segment that is not available yet', { concurrency: false }, async (t) => {
    installMediaSource(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { player, socket, sourceBuffer, states, errors } = await startHeldPlaying(t);

    sourceBuffer.dispatch('error');
    assert.equal(socket.pending('get-media-init').length, 2);
    socket.pending('get-media-init')[1].ack({ success: false });
    assert.deepEqual(errors, [], 'one unavailable answer is not the end');
    assert.equal(player.getState().state, 'buffering');

    t.mock.timers.tick(2000);
    assert.equal(socket.pending('get-media-init').length, 3, 'the bounded retry asks again');
    socket.pending('get-media-init')[2].ack(initAnswer(2));
    assert.equal(FakeMediaSource.instances.length, 2, 'the recovery rebuilds the player');
    assert.equal(player.getState().generation, 2);

    FakeMediaSource.instances[1].open();
    await flushTasks();
    // The recovery succeeded: neither the retry nor the timeout is left to fire.
    t.mock.timers.tick(120_000);
    assert.deepEqual(errors, []);
    assert.equal(socket.pending('get-media-init').length, 3);
    assert.equal(socket.pending('fallback-consume-start').length, 0);
    assert.notEqual(states.at(-1), 'error');
});

test('VAL-093: reset recovery whose answer never arrives retries, then reports one error', { concurrency: false }, async (t) => {
    installMediaSource(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { player, socket, sourceBuffer, errors } = await startHeldPlaying(t);

    sourceBuffer.dispatch('error');
    assert.equal(socket.pending('get-media-init').length, 2);

    // Three retries, as the normal bootstrap makes, each one answered with nothing.
    for (let retry = 1; retry <= 3; retry += 1) {
        t.mock.timers.tick(15_000);
        assert.deepEqual(errors, [], `retry ${retry} is not an error`);
        assert.equal(player.getState().state, 'buffering');
        assert.equal(socket.pending('fallback-consume-start').length, retry, 'the timeout asks the server to start again');
        socket.pending('fallback-consume-start')[retry - 1].ack({});
        assert.equal(socket.pending('get-media-init').length, 2 + retry);
    }

    t.mock.timers.tick(15_000);
    assert.deepEqual(errors, ['Relay init segment did not arrive in time']);
    assert.equal(player.getState().state, 'error');

    // The error is reported once, and nothing retries after it, not even when
    // the last request is answered late with "unavailable".
    socket.pending('get-media-init')[4].ack({ success: false });
    t.mock.timers.tick(120_000);
    assert.equal(errors.length, 1);
    assert.equal(socket.pending('get-media-init').length, 5);
});

test('VAL-093: stop() during reset recovery clears the retry and timeout timers', { concurrency: false }, async (t) => {
    installMediaSource(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });

    // An unavailable answer leaves a retry timer, and the init timeout runs too.
    const unavailable = await startHeldPlaying(t);
    unavailable.sourceBuffer.dispatch('error');
    unavailable.socket.pending('get-media-init')[1].ack({ success: false });
    unavailable.player.stop();
    t.mock.timers.tick(120_000);
    assert.equal(unavailable.socket.pending('get-media-init').length, 2, 'the retry timer is gone');
    assert.equal(unavailable.socket.pending('fallback-consume-start').length, 0, 'the timeout is gone');
    assert.deepEqual(unavailable.errors, []);
    assert.equal(unavailable.player.getState().state, 'stopped');

    // No answer at all leaves only the init timeout.
    const silent = await startHeldPlaying(t);
    silent.sourceBuffer.dispatch('error');
    silent.player.stop();
    t.mock.timers.tick(120_000);
    assert.equal(silent.socket.pending('fallback-consume-start').length, 0);
    assert.equal(silent.socket.pending('get-media-init').length, 2);
    assert.deepEqual(silent.errors, []);
    assert.equal(silent.player.getState().state, 'stopped');
});
