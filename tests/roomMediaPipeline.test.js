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
        assert.equal(room._mediaPipeline, null, failAt);
        assert.equal(room.fallbackWorker, null, failAt);
        assert.equal(room.fallbackStarting, false, failAt);
        assert.match(room.fallbackLastError, new RegExp(failAt), failAt);
        assert.equal(getSocketRuntimeMetrics().counters.activeFallbackPipelines, 0, failAt);
    }
});
