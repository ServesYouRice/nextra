const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { RoomMediaPipeline } = require('../lib/roomMediaPipeline');
const { startFallbackRelay, getSocketRuntimeMetrics } = require('../lib/socket');

test('RoomMediaPipeline closes owned resources in reverse order exactly once', () => {
    const room = { fallbackStarting: false };
    const closed = [];
    let closeNotifications = 0;
    const pipeline = new RoomMediaPipeline(room, {
        onClose: () => { closeNotifications += 1; },
    });

    const generation = pipeline.beginStart();
    pipeline.own('transport', {}, () => closed.push('transport'));
    pipeline.own('consumer', {}, () => closed.push('consumer'));
    pipeline.own('relay', {}, () => closed.push('relay'));
    pipeline.markRunning(generation);

    assert.equal(pipeline.close(), true);
    assert.equal(pipeline.close(), false);
    assert.deepEqual(closed, ['relay', 'consumer', 'transport']);
    assert.equal(closeNotifications, 1);
    assert.equal(room.fallbackStarting, false);
    assert.equal(pipeline.state, 'closed');
});

test('RoomMediaPipeline invalidates an in-flight startup when closed', () => {
    const room = { fallbackStarting: false };
    const pipeline = new RoomMediaPipeline(room);
    const generation = pipeline.beginStart();

    assert.equal(room.fallbackStarting, true);
    pipeline.close();
    assert.throws(() => pipeline.assertCurrent(generation), /cancelled/);
    assert.throws(() => pipeline.markRunning(generation), /cancelled/);
});

test('RoomMediaPipeline replaces an owned timer without leaking the previous one', () => {
    const room = { fallbackStarting: false };
    const cleared = [];
    const pipeline = new RoomMediaPipeline(room);
    pipeline.beginStart();

    pipeline.setTimer('startup', 1, (timer) => cleared.push(timer));
    pipeline.setTimer('startup', 2, (timer) => cleared.push(timer));
    pipeline.close();

    assert.deepEqual(cleared, [1, 2]);
});

test('RoomMediaPipeline can recycle fallback resources without closing WHIP ownership', () => {
    const room = { fallbackStarting: false };
    const closed = [];
    const pipeline = new RoomMediaPipeline(room);
    pipeline.ownWhip('transport', {}, () => closed.push('whip-transport'));
    pipeline.beginStart();
    pipeline.own('relay', {}, () => closed.push('relay'));

    assert.equal(pipeline.closeFallback(), true);
    assert.equal(pipeline.state, 'idle');
    assert.deepEqual(closed, ['relay']);
    pipeline.beginStart();
    pipeline.close();
    assert.deepEqual(closed, ['relay', 'whip-transport']);
});

function createConsumer(kind, closed) {
    const consumer = new EventEmitter();
    consumer.kind = kind;
    consumer.close = () => closed.push(`${kind}-consumer`);
    consumer.requestKeyFrame = async () => {};
    consumer.pause = async () => {};
    consumer.resume = async () => {};
    return consumer;
}

function createFallbackRoom({ withAudio = false } = {}) {
    return {
        code: 'ABC123',
        fallbackStarting: false,
        fallbackWorker: null,
        fallbackAvailable: false,
        fallbackGeneration: 0,
        fallbackViewers: new Set(),
        frameRate: 30,
        obsVideoCodec: 'h264',
        whipProducer: { id: 'video-producer' },
        whipAudioProducer: withAudio ? { id: 'audio-producer' } : null,
    };
}

function createRouterFailureFixture(failAt, closed) {
    let transportCount = 0;
    return {
        rtpCapabilities: {},
        async createDirectTransport() {
            transportCount += 1;
            const label = transportCount === 1 ? 'video' : 'audio';
            if (failAt === `${label}-transport`) throw new Error(`${failAt} failed`);
            return {
                close: () => closed.push(`${label}-transport`),
                async consume() {
                    if (failAt === `${label}-consumer`) throw new Error(`${failAt} failed`);
                    return createConsumer(label, closed);
                },
            };
        },
    };
}

test('fallback startup releases every allocation when successive stages fail', { concurrency: false }, async () => {
    const cases = [
        { failAt: 'video-transport', withAudio: false, expectedClosed: [] },
        { failAt: 'video-consumer', withAudio: false, expectedClosed: ['video-transport'] },
        { failAt: 'audio-transport', withAudio: true, expectedClosed: ['video-consumer', 'video-transport'] },
        { failAt: 'audio-consumer', withAudio: true, expectedClosed: ['audio-transport', 'video-consumer', 'video-transport'] },
        { failAt: 'relay-start', withAudio: true, expectedClosed: ['relay', 'audio-consumer', 'audio-transport', 'video-consumer', 'video-transport'] },
    ];

    for (const { failAt, withAudio, expectedClosed } of cases) {
        const closed = [];
        const room = createFallbackRoom({ withAudio });
        const router = createRouterFailureFixture(failAt, closed);

        class FailingRelay extends EventEmitter {
            stop() {
                closed.push('relay');
            }

            async start() {
                if (failAt === 'relay-start') throw new Error('relay-start failed');
            }
        }

        await startFallbackRelay(room, router, null, { FFmpegRelay: FailingRelay });

        assert.deepEqual(closed, expectedClosed, failAt);
        assert.equal(room._mediaPipeline.state, 'idle', failAt);
        assert.equal(room.fallbackWorker, null, failAt);
        assert.equal(room.fallbackStarting, false, failAt);
        assert.match(room.fallbackLastError, new RegExp(failAt), failAt);
        assert.equal(getSocketRuntimeMetrics().counters.activeFallbackPipelines, 0, failAt);
    }
});

test('the relay publishes its init segment when no Socket.IO server is attached', { concurrency: false }, async () => {
    const closed = [];
    const room = createFallbackRoom();
    const router = createRouterFailureFixture('none', closed);

    class StartingRelay extends EventEmitter {
        stop() { closed.push('relay'); }
        async start() {}
    }

    // The WHIP prewarm path starts the relay without a Socket.IO handle. An
    // unguarded emit here throws inside the FFmpeg stdout parser callback, which
    // the relay reports as a pipeline error and leaves viewers buffering forever.
    await startFallbackRelay(room, router, null, { FFmpegRelay: StartingRelay });

    const relay = room.fallbackWorker;
    assert.ok(relay, 'relay should be running');

    const errors = [];
    relay.on('error', (err) => errors.push(err.message));
    relay.emit('init', { initSegment: Buffer.from('ftypmoovavc1payload') });

    assert.deepEqual(errors, []);
    assert.equal(room.fallbackAvailable, true);
    assert.equal(room.fallbackGeneration, 1);

    room._mediaPipeline.close();
});

test('RoomMediaPipeline.close() closes a resource and a timer owned while the pipeline was idle', () => {
    const room = { fallbackStarting: false };
    const closed = [];
    let closeNotifications = 0;
    const pipeline = new RoomMediaPipeline(room, {
        onClose: () => { closeNotifications += 1; },
    });

    assert.equal(pipeline.state, 'idle');
    pipeline.own('worker', {}, () => closed.push('worker'));
    pipeline.setTimer('restart', 7, (timer) => closed.push(`timer:${timer}`));

    assert.equal(pipeline.close(), true);
    assert.deepEqual(closed, ['timer:7', 'worker']);
    assert.equal(closeNotifications, 0, 'no fallback was started, so none is reported closed');
    assert.equal(pipeline.state, 'closed');
});

test('RoomMediaPipeline.closeFallback() drains a resource owned after a cancelling closeFallback()', () => {
    const room = { fallbackStarting: false };
    const closed = [];
    let closeNotifications = 0;
    const pipeline = new RoomMediaPipeline(room);

    pipeline.beginStart({ onClose: () => { closeNotifications += 1; } });
    pipeline.own('transport', {}, () => closed.push('transport'));
    assert.equal(pipeline.closeFallback(), true);
    assert.deepEqual(closed, ['transport']);
    assert.equal(closeNotifications, 1);

    // The cancelled startup continuation registers its allocation after the cancel.
    const generationAfterCancel = pipeline.generation;
    pipeline.own('worker', {}, () => closed.push('worker'));
    pipeline.setTimer('restart', 9, (timer) => closed.push(`timer:${timer}`));
    assert.equal(pipeline.state, 'idle');

    assert.equal(pipeline.closeFallback(), false, 'no started fallback was closed');
    assert.deepEqual(closed, ['transport', 'timer:9', 'worker']);
    assert.equal(closeNotifications, 1, 'onClose stays at one per started fallback');
    assert.equal(pipeline.generation, generationAfterCancel, 'an idle drain does not advance the generation');
    assert.equal(pipeline.state, 'idle');
    assert.equal(pipeline.closed, false);

    // Nothing is closed twice by the later teardown.
    assert.equal(pipeline.close(), true);
    assert.deepEqual(closed, ['transport', 'timer:9', 'worker']);
    assert.equal(closeNotifications, 1);
});

test('RoomMediaPipeline.close() closes a resource owned after a cancelling closeFallback() exactly once', () => {
    const room = { fallbackStarting: false };
    let workerCloses = 0;
    let closeNotifications = 0;
    const pipeline = new RoomMediaPipeline(room);

    pipeline.beginStart({ onClose: () => { closeNotifications += 1; } });
    assert.equal(pipeline.closeFallback(), true);
    pipeline.own('worker', {}, () => { workerCloses += 1; });

    assert.equal(pipeline.close(), true);
    assert.equal(workerCloses, 1);
    assert.equal(closeNotifications, 1);
    assert.equal(pipeline.close(), false);
    assert.equal(workerCloses, 1);
});

test('RoomMediaPipeline idle drains keep WHIP ownership and reverse registration order', () => {
    const room = { fallbackStarting: false };
    const closed = [];
    const pipeline = new RoomMediaPipeline(room);

    pipeline.ownWhip('transport', {}, () => closed.push('whip-transport'));
    pipeline.own('first', {}, () => closed.push('first'));
    pipeline.own('second', {}, () => closed.push('second'));
    pipeline.own('third', {}, () => closed.push('third'));

    assert.equal(pipeline.closeFallback(), false);
    assert.deepEqual(closed, ['third', 'second', 'first'], 'fallback resources close newest first and WHIP stays open');

    pipeline.own('late', {}, () => closed.push('late'));
    assert.equal(pipeline.close(), true);
    assert.deepEqual(closed, ['third', 'second', 'first', 'late', 'whip-transport']);
});

test('RoomMediaPipeline reports a fallback closed once per beginStart across restarts', () => {
    const room = { fallbackStarting: false };
    let closeNotifications = 0;
    const pipeline = new RoomMediaPipeline(room);
    const onClose = () => { closeNotifications += 1; };

    pipeline.beginStart({ onClose });
    assert.equal(pipeline.closeFallback(), true);
    pipeline.own('worker', {}, () => {});
    assert.equal(pipeline.closeFallback(), false);
    assert.equal(pipeline.closeFallback(), false);
    assert.equal(closeNotifications, 1);

    pipeline.beginStart({ onClose });
    assert.equal(pipeline.closeFallback(), true);
    assert.equal(closeNotifications, 2);
    assert.equal(pipeline.close(), true);
    assert.equal(closeNotifications, 2);
});

test('a startup cancelled by closeFallback() still closes the transport its continuation owns after the cancel', { concurrency: false }, async () => {
    const closed = [];
    const room = createFallbackRoom();
    const activeBefore = getSocketRuntimeMetrics().counters.activeFallbackPipelines;
    let resolveTransport;
    const router = {
        rtpCapabilities: {},
        createDirectTransport() {
            return new Promise((resolve) => { resolveTransport = resolve; });
        },
    };

    const starting = startFallbackRelay(room, router, null, { FFmpegRelay: EventEmitter });
    const pipeline = room._mediaPipeline;
    assert.equal(pipeline.state, 'starting');
    assert.equal(getSocketRuntimeMetrics().counters.activeFallbackPipelines, activeBefore + 1);

    // The fallback is torn down while the router is still creating the transport.
    assert.equal(pipeline.closeFallback(), true);
    assert.equal(pipeline.state, 'idle');
    assert.equal(getSocketRuntimeMetrics().counters.activeFallbackPipelines, activeBefore);

    resolveTransport({ close: () => closed.push('video-transport') });
    await starting;

    assert.deepEqual(closed, ['video-transport'], 'the transport created after the cancel is closed once');
    assert.equal(pipeline.state, 'idle');
    assert.equal(getSocketRuntimeMetrics().counters.activeFallbackPipelines, activeBefore);
    pipeline.close();
    assert.deepEqual(closed, ['video-transport']);
});
