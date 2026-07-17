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

class FakeSourceBuffer extends FakeEventTarget {
    constructor() {
        super();
        this.updating = false;
        this.appended = [];
        this.aborted = false;
        this.removed = [];
        this.buffered = {
            length: 1,
            start: () => 0,
            end: () => 2,
        };
    }

    appendBuffer(value) {
        this.appended.push(new Uint8Array(value));
        this.updating = true;
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
        this.readyState = 2;
        this.muted = false;
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

test('fMP4 relay player replaces generations without leaking listeners, buffers, URLs, or timers', { concurrency: false }, async (t) => {
    const originalMediaSource = global.MediaSource;
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revokedUrls = [];
    let nextUrl = 1;
    FakeMediaSource.instances = [];
    global.MediaSource = FakeMediaSource;
    URL.createObjectURL = () => `blob:relay-${nextUrl++}`;
    URL.revokeObjectURL = (url) => revokedUrls.push(url);
    t.after(() => {
        global.MediaSource = originalMediaSource;
        URL.createObjectURL = originalCreateObjectUrl;
        URL.revokeObjectURL = originalRevokeObjectUrl;
    });

    const { createFmp4RelayPlayer } = await import('../src/lib/fmp4RelayPlayer.js');
    const socket = new FakeSocket();
    const video = new FakeVideoElement();
    const states = [];
    const player = createFmp4RelayPlayer({
        videoElement: video,
        socket,
        roomCode: 'ABC123',
        onStateChange: (state) => states.push(state),
    });

    player.start();
    assert.equal(socket.listenerCount('media-init'), 1);
    assert.equal(socket.listenerCount('media-chunk'), 1);
    assert.equal(socket.requests[0].event, 'get-media-init');

    socket.serverEmit('media-init', {
        generation: 1,
        mimeType: 'video/mp4; codecs="avc1.42e01f"',
        initSegment: Uint8Array.of(1, 2),
        bootstrapFragment: Uint8Array.of(3, 4),
        bootstrapSequence: 1,
    });
    assert.equal(FakeMediaSource.instances.length, 1);
    const firstMediaSource = FakeMediaSource.instances[0];
    firstMediaSource.open();
    await flushTasks();
    const firstSourceBuffer = firstMediaSource.sourceBuffers[0];
    assert.equal(firstSourceBuffer.appended.length, 2);

    socket.serverEmit('media-chunk', {
        generation: 1,
        sequence: 2,
        chunk: Uint8Array.of(5, 6),
    });
    await flushTasks();
    assert.equal(firstSourceBuffer.appended.length, 3);
    assert.equal(player.getState().generation, 1);

    socket.serverEmit('media-init', {
        generation: 2,
        mimeType: 'video/mp4; codecs="avc1.42e01f"',
        initSegment: Uint8Array.of(7, 8),
    });
    assert.equal(FakeMediaSource.instances.length, 2);
    assert.deepEqual(revokedUrls, ['blob:relay-1']);
    assert.equal(firstSourceBuffer.listenerCount('updateend'), 0);
    assert.equal(firstSourceBuffer.listenerCount('error'), 0);
    assert.deepEqual(firstMediaSource.removedSourceBuffers, [firstSourceBuffer]);

    const secondMediaSource = FakeMediaSource.instances[1];
    secondMediaSource.open();
    await flushTasks();
    assert.equal(player.getState().generation, 2);

    player.stop();
    assert.equal(socket.listenerCount('media-init'), 0);
    assert.equal(socket.listenerCount('media-chunk'), 0);
    assert.deepEqual(revokedUrls, ['blob:relay-1', 'blob:relay-2']);
    assert.equal(video.src, '');
    assert.equal(video.loadCalls, 1);
    assert.deepEqual(player.getState(), {
        state: 'stopped',
        generation: -1,
        queueLength: 0,
        queueBytes: 0,
        mimeType: 'video/mp4; codecs="avc1.42e01f"',
    });
    assert.ok(states.includes('playing'));
    assert.equal(states.at(-1), 'stopped');
});
