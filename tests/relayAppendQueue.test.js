'use strict';

// Deterministic tests of src/lib/relayAppendQueue.mjs, the append queue of
// WatchView's relay player, against a fake SourceBuffer and MediaSource whose
// appends, removals and events the test finishes by hand. Like a real
// SourceBuffer, the fake throws from appendBuffer() while it is updating, and a
// failed append fires 'error' and then 'updateend'.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const loadQueue = () => import('../src/lib/relayAppendQueue.mjs');

class FakeSourceBuffer extends EventTarget {
    constructor() {
        super();
        this.updating = false;
        this.appended = [];
        this.removed = [];
        // Errors the next appendBuffer() calls throw, in order.
        this.refuse = [];
    }

    appendBuffer(data) {
        if (this.updating) throw new DOMException('An append is already running.', 'InvalidStateError');
        const refusal = this.refuse.shift();
        if (refusal) throw refusal;
        this.updating = true;
        this.appended.push(data);
    }

    remove(start, end) {
        if (this.updating) throw new DOMException('An append is already running.', 'InvalidStateError');
        this.updating = true;
        this.removed.push([start, end]);
    }

    // The running append or removal ends well.
    finish() {
        assert.equal(this.updating, true, 'nothing is running');
        this.updating = false;
        this.dispatchEvent(new Event('updateend'));
    }

    // The running append fails while the browser parses it.
    failAppend() {
        this.updating = false;
        this.dispatchEvent(new Event('error'));
        this.dispatchEvent(new Event('updateend'));
    }

    // abort() during an append, as prepareSourceBufferForGeneration does for a
    // new recorder generation: updating ends at once, the events follow.
    abort() {
        if (!this.updating) return () => { };
        this.updating = false;
        return () => {
            this.dispatchEvent(new Event('abort'));
            this.dispatchEvent(new Event('updateend'));
        };
    }
}

class FakeMediaSource extends EventTarget {
    constructor() {
        super();
        this.readyState = 'open';
    }

    end(type) {
        this.readyState = type === 'sourceclose' ? 'closed' : 'ended';
        this.dispatchEvent(new Event(type));
    }
}

const chunk = (size, fill = 1) => new Uint8Array(size).fill(fill);
const quotaError = () => new DOMException('The SourceBuffer is full.', 'QuotaExceededError');

async function setup(options = {}) {
    const module = await loadQueue();
    const sourceBuffer = new FakeSourceBuffer();
    const mediaSource = new FakeMediaSource();
    const failures = [];
    const state = { currentTime: 25, active: true, updateEnds: 0 };
    const queue = module.createRelayAppendQueue({
        maxChunks: 240,
        maxBytes: 24 * 1024 * 1024,
        isActive: () => state.active,
        getCurrentTime: () => state.currentTime,
        onUpdateEnd: () => { state.updateEnds += 1; },
        onFailure: (failure) => failures.push(failure),
        ...options,
    });
    queue.attach(sourceBuffer, mediaSource);
    return { module, queue, sourceBuffer, mediaSource, failures, state };
}

test('a chunk leaves the queue, and its bytes the count, only once its append has finished', async () => {
    const { queue, sourceBuffer, failures, state } = await setup();
    const first = chunk(100);
    const second = chunk(50);

    assert.equal(queue.enqueue(first), true);
    assert.equal(queue.enqueue(second), true);
    assert.deepEqual(sourceBuffer.appended, [first], 'one append at a time');
    assert.equal(queue.length, 2, 'the chunk being appended is still queued');
    assert.equal(queue.bytes, 150, 'and still counted');

    sourceBuffer.finish();
    assert.equal(queue.length, 1);
    assert.equal(queue.bytes, 50);
    assert.equal(state.updateEnds, 1);
    assert.deepEqual(sourceBuffer.appended, [first, second], 'the next append starts after updateend');

    sourceBuffer.finish();
    assert.equal(queue.length, 0);
    assert.equal(queue.bytes, 0);
    assert.deepEqual(failures, []);
});

test('a full SourceBuffer frees what is more than 10 s behind the playhead and appends the same chunk again', async () => {
    const { queue, sourceBuffer, failures, state } = await setup();
    const first = chunk(100);
    const second = chunk(60);
    state.currentTime = 42.5;
    sourceBuffer.refuse.push(quotaError());

    queue.enqueue(first);
    queue.enqueue(second);
    assert.deepEqual(sourceBuffer.appended, [], 'the refused append took nothing');
    assert.deepEqual(sourceBuffer.removed, [[0, 32.5]], 'evicts from the start to 10 s before currentTime');
    assert.equal(queue.length, 2, 'the refused chunk is kept');
    assert.equal(queue.bytes, 160, 'and so are its bytes');

    sourceBuffer.finish(); // the eviction
    assert.deepEqual(sourceBuffer.appended, [first], 'the refused chunk is appended again, first');
    sourceBuffer.finish();
    assert.deepEqual(sourceBuffer.appended, [first, second]);
    sourceBuffer.finish();
    assert.equal(queue.length, 0);
    assert.equal(queue.bytes, 0);
    assert.deepEqual(failures, []);

    // Every chunk gets its own eviction: a later QuotaExceededError is handled the same way.
    const third = chunk(10);
    sourceBuffer.refuse.push(quotaError());
    queue.enqueue(third);
    assert.equal(sourceBuffer.removed.length, 2);
    sourceBuffer.finish();
    sourceBuffer.finish();
    assert.deepEqual(sourceBuffer.appended, [first, second, third]);
    assert.deepEqual(failures, []);
});

test('a SourceBuffer still full after its eviction ends relay playback with the buffer message', async () => {
    const { module, queue, sourceBuffer, failures } = await setup();
    sourceBuffer.refuse.push(quotaError(), quotaError());

    queue.enqueue(chunk(100));
    sourceBuffer.finish(); // the eviction; the retry is refused again
    assert.equal(failures.length, 1);
    assert.equal(failures[0].message, module.RELAY_BUFFER_FULL_MESSAGE);
    assert.equal(failures[0].cause?.name, 'QuotaExceededError');
    assert.equal(sourceBuffer.removed.length, 1, 'one eviction per chunk, then it gives up');

    assert.equal(queue.enqueue(chunk(10)), false, 'a failed queue takes nothing more');
    assert.deepEqual(sourceBuffer.appended, []);
    assert.equal(failures.length, 1, 'reported once');
});

test('a full SourceBuffer with nothing 10 s behind the playhead ends relay playback at once', async () => {
    const { module, queue, sourceBuffer, failures, state } = await setup();
    state.currentTime = 6;
    sourceBuffer.refuse.push(quotaError());

    queue.enqueue(chunk(100));
    assert.deepEqual(sourceBuffer.removed, [], 'nothing to evict');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].message, module.RELAY_BUFFER_FULL_MESSAGE);
});

test('an append the SourceBuffer refuses for another reason ends relay playback with that reason', async () => {
    const { module, queue, sourceBuffer, failures } = await setup();
    sourceBuffer.refuse.push(new DOMException('This SourceBuffer has been removed from the parent media source.', 'InvalidStateError'));

    queue.enqueue(chunk(100));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].message, module.relayAppendRefusedMessage(failures[0].cause));
    assert.match(failures[0].message, /InvalidStateError/);
    assert.deepEqual(sourceBuffer.removed, [], 'only a QuotaExceededError evicts');

    // Nothing after the refused chunk is appended: its bytes are not skipped over.
    assert.equal(queue.enqueue(chunk(10)), false);
    queue.pump();
    assert.deepEqual(sourceBuffer.appended, []);
    assert.equal(failures.length, 1);
});

test('an append that fails while the browser parses it ends relay playback, and its updateend is not taken as success', async () => {
    const { module, queue, sourceBuffer, failures, state } = await setup();
    const first = chunk(100);
    queue.enqueue(first);
    queue.enqueue(chunk(20));

    sourceBuffer.failAppend();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].message, module.RELAY_UNREADABLE_MESSAGE);
    assert.equal(state.updateEnds, 0, 'the updateend after the error does not count as an append');
    assert.deepEqual(sourceBuffer.appended, [first], 'nothing more is appended');
});

test('the MediaSource ending or closing under the player ends relay playback', async () => {
    for (const type of ['sourceended', 'sourceclose']) {
        const { module, queue, mediaSource, failures } = await setup();
        queue.enqueue(chunk(10));
        mediaSource.end(type);
        assert.equal(failures.length, 1, type);
        assert.equal(failures[0].message, module.RELAY_SOURCE_CLOSED_MESSAGE, type);
    }
});

test('an append that is due while the MediaSource is not open ends relay playback instead of waiting', async () => {
    const { module, queue, sourceBuffer, mediaSource, failures } = await setup();
    queue.enqueue(chunk(10));
    // Chromium closes the MediaSource on detach and fires updateend for the
    // append it cut short before sourceclose.
    mediaSource.readyState = 'closed';
    sourceBuffer.finish();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].message, module.RELAY_SOURCE_CLOSED_MESSAGE);

    const ended = await setup();
    ended.mediaSource.readyState = 'ended';
    ended.queue.enqueue(chunk(10));
    assert.deepEqual(ended.sourceBuffer.appended, []);
    assert.equal(ended.failures.length, 1);
    assert.equal(ended.failures[0].message, ended.module.RELAY_SOURCE_CLOSED_MESSAGE);
});

test('more chunks or bytes than the limits allow end relay playback with the fell-behind message', async () => {
    const byCount = await setup({ maxChunks: 3 });
    for (let i = 0; i < 3; i += 1) assert.equal(byCount.queue.enqueue(chunk(10)), true);
    assert.equal(byCount.failures.length, 0, 'at the limit is still fine');
    assert.equal(byCount.queue.enqueue(chunk(10)), false);
    assert.equal(byCount.failures.length, 1);
    assert.equal(byCount.failures[0].message, 'Relay playback fell behind and must be restarted.');
    assert.equal(byCount.failures[0].message, byCount.module.RELAY_FELL_BEHIND_MESSAGE);
    assert.equal(byCount.queue.length, 0, 'a failed queue lets its chunks go');

    const byBytes = await setup({ maxBytes: 250 });
    byBytes.queue.enqueue(chunk(200));
    assert.equal(byBytes.queue.enqueue(chunk(51)), false);
    assert.equal(byBytes.failures.length, 1);
    assert.equal(byBytes.failures[0].message, byBytes.module.RELAY_FELL_BEHIND_MESSAGE);
});

test('a flush for a new generation drops the chunk being appended without taking its aborted updateend for the next one', async () => {
    const { queue, sourceBuffer, failures } = await setup();
    const old = chunk(100, 1);
    queue.enqueue(old);
    queue.enqueue(chunk(100, 2));

    // onMediaInit: flush, then abort() the parser (prepareSourceBufferForGeneration).
    queue.clear();
    assert.equal(queue.length, 0);
    assert.equal(queue.bytes, 0);
    const deliverAbortEvents = sourceBuffer.abort();
    const init = chunk(30, 3);
    queue.enqueue(init);
    assert.deepEqual(sourceBuffer.appended, [old], "the new init waits for the aborted append's updateend");

    deliverAbortEvents();
    assert.deepEqual(sourceBuffer.appended, [old, init]);
    assert.equal(queue.length, 1, 'the init is still queued until its own append ends');
    sourceBuffer.finish();
    assert.equal(queue.length, 0);
    assert.deepEqual(failures, []);
});

test('bootstrap chunks put in front are appended before the live ones, in order', async () => {
    const module = await loadQueue();
    const sourceBuffer = new FakeSourceBuffer();
    const queue = module.createRelayAppendQueue({
        maxChunks: 240,
        maxBytes: 1024,
        onFailure: () => assert.fail('no failure'),
    });
    const live = chunk(10, 9);
    queue.enqueue(live); // arrived before the SourceBuffer existed
    const bootstrap = [chunk(10, 1), chunk(10, 2)];
    queue.prepend(bootstrap);
    assert.equal(queue.bytes, 30);
    queue.attach(sourceBuffer, new FakeMediaSource());
    queue.pump();
    sourceBuffer.finish();
    sourceBuffer.finish();
    sourceBuffer.finish();
    assert.deepEqual(sourceBuffer.appended, [...bootstrap, live]);
    assert.equal(queue.length, 0);
});

// A later viewer's bootstrap is the server's snapshot of the generation so far,
// up to the byte ceiling itself. What can fall behind is the live media that
// arrives while the snapshot is appended, so that keeps the whole allowance.
test('a bootstrap in front is counted apart from the live limits, which still apply in full while it is appended', async () => {
    const { module, queue, sourceBuffer, failures } = await setup({ maxChunks: 3, maxBytes: 100 });
    queue.prepend([chunk(100, 1)]);
    queue.pump();
    for (let i = 0; i < 3; i += 1) queue.enqueue(chunk(33, 2));
    assert.deepEqual(failures, [], 'a bootstrap at the ceiling leaves the live chunks their limits');
    assert.equal(queue.length, 4);
    assert.equal(queue.bytes, 199);
    assert.equal(sourceBuffer.appended.length, 1, 'the bootstrap is being appended');

    assert.equal(queue.enqueue(chunk(1, 3)), false, 'a fourth live chunk is past the chunk limit');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].message, module.RELAY_FELL_BEHIND_MESSAGE);
});

test('once its bootstrap is appended, a queue has the same live limits as any other', async () => {
    const { queue, sourceBuffer, failures } = await setup({ maxChunks: 3, maxBytes: 100 });
    queue.prepend([chunk(100, 1)]);
    queue.pump();
    queue.enqueue(chunk(50, 2));
    sourceBuffer.finish();
    assert.equal(queue.length, 1, 'the live chunk, now being appended');
    assert.equal(queue.bytes, 50);
    assert.equal(queue.enqueue(chunk(50, 3)), true, 'at the byte limit is still fine');
    assert.equal(queue.enqueue(chunk(1, 4)), false);
    assert.equal(failures.length, 1);
});

// lib/socket.js never sends a bootstrap above the ceiling; one that is would
// otherwise sit outside every limit.
test('a bootstrap larger than the byte ceiling ends relay playback at once', async () => {
    const { module, queue, sourceBuffer, failures } = await setup({ maxBytes: 100 });
    assert.equal(queue.prepend([chunk(60, 1), chunk(41, 2)]), false);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].message, module.RELAY_FELL_BEHIND_MESSAGE);
    queue.pump();
    assert.deepEqual(sourceBuffer.appended, []);
    assert.equal(queue.length, 0);
});

// tests/socketRelayBootstrap.test.js holds the server's bootstrap ceiling to
// RELAY_QUEUE_MAX_BYTES, so WatchView must size its queue with these limits.
test('WatchView sizes its relay queue with the limits exported next to the queue', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'WatchView.jsx'), 'utf8');
    const queueImport = /import \{([^}]*)\} from '\.\/lib\/relayAppendQueue\.mjs';/.exec(source);
    assert.ok(queueImport, 'WatchView imports relayAppendQueue.mjs');
    assert.match(queueImport[1], /\bRELAY_QUEUE_MAX_CHUNKS as MAX_QUEUE_CHUNKS\b/);
    assert.match(queueImport[1], /\bRELAY_QUEUE_MAX_BYTES as MAX_QUEUE_BYTES\b/);
    assert.doesNotMatch(source, /const MAX_QUEUE_(CHUNKS|BYTES)\b/, 'no limits of its own');
    assert.match(source, /createRelayAppendQueue\(\{\s*maxChunks: MAX_QUEUE_CHUNKS,\s*maxBytes: MAX_QUEUE_BYTES,/);
});

test('a closed queue, or one whose attempt is no longer current, ignores late events and reports nothing', async () => {
    const closed = await setup();
    closed.queue.enqueue(chunk(10));
    closed.queue.close();
    closed.sourceBuffer.failAppend();
    closed.mediaSource.end('sourceclose');
    assert.equal(closed.queue.enqueue(chunk(10)), false);
    assert.deepEqual(closed.failures, []);
    assert.equal(closed.state.updateEnds, 0);

    const stale = await setup();
    stale.queue.enqueue(chunk(10));
    stale.state.active = false;
    stale.sourceBuffer.failAppend();
    stale.mediaSource.end('sourceended');
    assert.equal(stale.queue.enqueue(chunk(10)), false);
    assert.deepEqual(stale.failures, []);
    assert.equal(stale.state.updateEnds, 0);
});

test('WatchView appends relay media only through the queue and ends failed relay playback visibly', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'WatchView.jsx'), 'utf8');
    assert.doesNotMatch(source, /\.appendBuffer\(/, 'every relay append goes through relayAppendQueue');
    assert.match(source, /createRelayAppendQueue\(\{/);
    assert.match(source, /appendQueue\.attach\(sourceBuffer, mediaSource\)/);

    const start = source.indexOf('failRelayGeneration = (failure) => {');
    assert.ok(start > 0, 'failRelayGeneration is defined');
    const body = source.slice(start, source.indexOf('\n        };', start));
    assert.doesNotMatch(body, /setFallbackState/, 'fallbackState belongs to the fMP4 fallback player');
    const order = ['settleFirstBuffered(failure)', 'cleanupRelayAttempt(failure)', 'cleanupPlayback()',
        'setWatching(false)', "setPlaybackMode('')", 'setError(failure.message)'];
    let at = -1;
    for (const step of order) {
        const next = body.indexOf(step);
        assert.ok(next > at, `${step} comes after the step before it`);
        at = next;
    }
});
