const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { startFallbackRelay, stopFallbackRelay, getSocketRuntimeMetrics } = require('../lib/socket');
const { RoomMediaPipeline } = require('../lib/roomMediaPipeline');

const relayRuntime = { now: () => 1_000_000, measureBacklogBytes: () => 0 };

function activeFallbackPipelines() {
    return getSocketRuntimeMetrics().counters.activeFallbackPipelines;
}

function createRoom({ withAudio = false, frameRate = 30 } = {}) {
    return {
        code: 'STALE1',
        fallbackStarting: false,
        fallbackWorker: null,
        fallbackAvailable: false,
        fallbackGeneration: 0,
        fallbackViewers: new Set(),
        frameRate,
        relayVideoKbps: 14000,
        obsVideoCodec: 'h264',
        whipProducer: { id: 'video-producer' },
        whipAudioProducer: withAudio ? { id: 'audio-producer' } : null,
    };
}

// One start's media: a router whose transports and consumers are labelled with
// the start they belong to, and a relay class whose instances are recorded.
// `hold` names the one await point that stays pending until `resume()`.
function createStartMedia(label, closed, hold = null) {
    const created = [];
    const relays = [];
    const consumers = [];
    const media = { label, created, relays, consumers, resume: null };

    const settle = (point, value) => {
        if (point !== hold) return Promise.resolve(value);
        return new Promise((resolve) => {
            media.resume = () => resolve(value);
        });
    };

    const createConsumer = (kind) => {
        const name = `${label}-${kind}-consumer`;
        created.push(name);
        const consumer = new EventEmitter();
        consumer.kind = kind;
        consumer.close = () => closed.push(name);
        consumer.requestKeyFrame = async () => {};
        consumer.pause = async () => {};
        consumer.resume = async () => {};
        consumers.push(consumer);
        return consumer;
    };

    let transports = 0;
    media.router = {
        rtpCapabilities: {},
        createDirectTransport() {
            transports += 1;
            const kind = transports === 1 ? 'video' : 'audio';
            const name = `${label}-${kind}-transport`;
            created.push(name);
            return settle(`${kind}-transport`, {
                close: () => closed.push(name),
                consume: () => settle(`${kind}-consumer`, createConsumer(kind)),
            });
        },
    };

    media.FFmpegRelay = class FakeRelay extends EventEmitter {
        constructor(opts) {
            super();
            this.opts = opts;
            this.label = label;
            this.stopCalls = 0;
            relays.push(this);
        }

        start() {
            return settle('relay-start', undefined);
        }

        stop() {
            this.stopCalls += 1;
        }

        beginBurst() {}

        writeVideoFrame() { return true; }

        writeAudioRtp() {}

        get restartCount() { return 0; }
    };

    return media;
}

async function flush() {
    await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, what) {
    for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await flush();
    }
    assert.fail(`timed out waiting for ${what}`);
}

function snapshotRoom(room) {
    return {
        fallbackWorker: room.fallbackWorker,
        fallbackBitrate: room.fallbackBitrate,
        fallbackSource: room.fallbackSource,
        fallbackInitSegment: room.fallbackInitSegment,
        fallbackDelivery: room.fallbackDelivery,
        fallbackCongestion: room.fallbackCongestion,
        fallbackGeneration: room.fallbackGeneration,
        fallbackAvailable: room.fallbackAvailable,
        fallbackStartedAt: room.fallbackStartedAt,
        fallbackStarting: room.fallbackStarting,
        fallbackLastError: room.fallbackLastError,
    };
}

function assertRoomUnchanged(room, before, point) {
    const after = snapshotRoom(room);
    for (const field of Object.keys(before)) {
        assert.equal(after[field], before[field], `${point}: room.${field} changed`);
    }
}

// Starts A, which stops at `point`; the fallback is then torn down (as an OBS
// reconnect does) and start B takes the same pipeline over and runs. Then A
// resumes.
async function supersedeAt(point, { withAudio = false } = {}) {
    const closed = [];
    const room = createRoom({ withAudio, frameRate: point === 'frame-rate' ? 0 : 30 });
    const activeBefore = activeFallbackPipelines();
    const a = createStartMedia('A', closed, point);
    const startingA = startFallbackRelay(room, a.router, null, { FFmpegRelay: a.FFmpegRelay, relayRuntime });
    const pipeline = room._mediaPipeline;
    try {
        if (point === 'frame-rate') {
            // A has consumed the video and is sampling its frame rate.
            await waitFor(() => a.created.includes('A-video-consumer'), `${point}: A's video consumer`);
            await flush();
        } else {
            await waitFor(() => a.resume !== null, `${point}: A to reach ${point}`);
        }
        assert.equal(pipeline.state, 'starting', point);
        assert.equal(activeFallbackPipelines(), activeBefore + 1, `${point}: A holds one pipeline slot`);

        const cancelledAt = Date.now();
        stopFallbackRelay(room);
        assert.equal(activeFallbackPipelines(), activeBefore, `${point}: the cancel releases A's slot`);

        room.frameRate = 30;
        const b = createStartMedia('B', closed);
        await startFallbackRelay(room, b.router, null, { FFmpegRelay: b.FFmpegRelay, relayRuntime });
        const relayB = room.fallbackWorker;
        assert.ok(relayB, `${point}: B is running`);
        assert.equal(relayB.label, 'B', point);
        assert.equal(room._mediaPipeline, pipeline, `${point}: B reuses the pipeline`);
        assert.equal(pipeline.state, 'running', point);
        relayB.emit('init', { initSegment: Buffer.from('ftypmoovavc1-from-B') });
        assert.equal(room.fallbackAvailable, true, point);

        const before = snapshotRoom(room);
        a.resume?.();
        await startingA;
        const settledAfterMs = Date.now() - cancelledAt;

        assertRoomUnchanged(room, before, point);
        assert.equal(relayB.stopCalls, 0, `${point}: B's relay is not stopped`);
        assert.deepEqual(closed.filter((name) => name.startsWith('B-')), [], `${point}: none of B's resources is closed`);
        assert.equal(pipeline.state, 'running', `${point}: B's pipeline keeps running`);
        assert.equal(activeFallbackPipelines(), activeBefore + 1, `${point}: only B holds a pipeline slot`);

        // Everything A created is closed, once.
        for (const name of a.created) {
            assert.equal(closed.filter((entry) => entry === name).length, 1, `${point}: ${name} closed once`);
        }
        for (const relay of a.relays) {
            assert.equal(relay.stopCalls, 1, `${point}: A's relay stopped once`);
        }

        // B stops normally afterwards and gives its slot back.
        stopFallbackRelay(room);
        assert.equal(activeFallbackPipelines(), activeBefore, `${point}: the counter is back where it started`);
        for (const name of b.created) {
            assert.equal(closed.filter((entry) => entry === name).length, 1, `${point}: ${name} closed once on stop`);
        }
        assert.equal(relayB.stopCalls, 1, `${point}: B's relay stopped on stop`);
        return { a, settledAfterMs };
    } finally {
        // Stops whatever a failed assertion left running.
        pipeline.close();
    }
}

for (const { point, withAudio } of [
    { point: 'video-transport', withAudio: false },
    { point: 'video-consumer', withAudio: false },
    { point: 'audio-transport', withAudio: true },
    { point: 'audio-consumer', withAudio: true },
    { point: 'relay-start', withAudio: true },
]) {
    test(`a start superseded while awaiting ${point} leaves the newer relay alone and closes its own resources`, { concurrency: false }, async () => {
        const { a } = await supersedeAt(point, { withAudio });
        assert.ok(a.created.length > 0, point);
        if (point === 'relay-start') assert.equal(a.relays.length, 1);
        else assert.equal(a.relays.length, 0, `${point}: A never builds a relay`);
    });
}

test('a start superseded while sampling the frame rate stops sampling at once and leaves the newer relay alone', { concurrency: false }, async () => {
    const { a, settledAfterMs } = await supersedeAt('frame-rate');
    assert.equal(a.relays.length, 0, 'A never builds a relay');
    assert.ok(settledAfterMs < 1000, `the cancelled sample ended ${settledAfterMs} ms after the cancel`);
});

test('events from the relay of a stopped start do not reach the room once a newer start runs', { concurrency: false }, async () => {
    const closed = [];
    const room = createRoom();
    const a = createStartMedia('A', closed);
    await startFallbackRelay(room, a.router, null, { FFmpegRelay: a.FFmpegRelay, relayRuntime });
    const pipeline = room._mediaPipeline;
    try {
        const relayA = room.fallbackWorker;
        assert.equal(relayA.label, 'A');
        stopFallbackRelay(room);

        const b = createStartMedia('B', closed);
        await startFallbackRelay(room, b.router, null, { FFmpegRelay: b.FFmpegRelay, relayRuntime });
        const relayB = room.fallbackWorker;
        assert.equal(relayB.label, 'B');
        relayB.emit('init', { initSegment: Buffer.from('ftypmoovavc1-from-B') });
        const before = snapshotRoom(room);
        const restartCount = room.fallbackRestartCount;

        // A stopped FFmpeg can still flush output or report on its way out.
        relayA.emit('init', { initSegment: Buffer.from('ftypmoovavc1-from-A') });
        relayA.emit('error', new Error('A failed on its way out'));
        relayA.emit('exit', { code: 0, signal: null });
        relayA.emit('spawn');

        assertRoomUnchanged(room, before, 'stale relay events');
        assert.equal(room.fallbackRestartCount, restartCount);
        assert.equal(relayB.stopCalls, 0);
    } finally {
        pipeline.close();
    }
});

const SPS = Buffer.from([0x67, 0x64, 0x00, 0x1f, 0xac]);
const PPS = Buffer.from([0x68, 0xee, 0x3c, 0x80]);
const IDR = Buffer.from([0x65, 0x88, 0x84, 0x00, 0x33, 0xff]);
const SLICE = Buffer.from([0x41, 0x9a, 0x24, 0x6c, 0x41]);

function rtp(payload, { marker = false, sequence, timestamp }) {
    const head = Buffer.alloc(12);
    head[0] = 0x80;
    head[1] = (marker ? 0x80 : 0) | 96;
    head.writeUInt16BE(sequence & 0xffff, 2);
    head.writeUInt32BE(timestamp >>> 0, 4);
    head.writeUInt32BE(1, 8);
    return Buffer.concat([head, payload]);
}

test('a start without a configured frame rate still measures it from the source and starts', { concurrency: false }, async () => {
    const room = createRoom({ frameRate: 0 });
    const activeBefore = activeFallbackPipelines();
    const media = createStartMedia('A', []);
    const starting = startFallbackRelay(room, media.router, null, { FFmpegRelay: media.FFmpegRelay, relayRuntime });
    const pipeline = room._mediaPipeline;
    try {
        await waitFor(() => media.consumers.length === 1, 'the video consumer');
        await flush();

        // 60 fps: frames 1500 ticks of the 90 kHz clock apart.
        const video = media.consumers[0];
        let sequence = 0;
        for (let frame = 0; frame < 24; frame++) {
            const timestamp = frame * 1500;
            if (frame === 0) {
                video.emit('rtp', rtp(SPS, { sequence: sequence++, timestamp }));
                video.emit('rtp', rtp(PPS, { sequence: sequence++, timestamp }));
                video.emit('rtp', rtp(IDR, { sequence: sequence++, timestamp, marker: true }));
            } else {
                video.emit('rtp', rtp(SLICE, { sequence: sequence++, timestamp, marker: true }));
            }
        }
        const sampledAt = Date.now();
        await starting;

        assert.ok(Date.now() - sampledAt < 1000, 'the sample ends once enough frames arrived');
        assert.equal(room.fallbackWorker, media.relays[0]);
        assert.equal(media.relays[0].opts.videoFrameRate, 60);
        assert.equal(pipeline.state, 'running');
        assert.equal(activeFallbackPipelines(), activeBefore + 1);
        stopFallbackRelay(room);
        assert.equal(activeFallbackPipelines(), activeBefore);
    } finally {
        pipeline.close();
    }
});

test('a start that the pipeline refuses gives its capacity slot back', { concurrency: false }, async () => {
    const activeBefore = activeFallbackPipelines();

    // Neither case can follow the idle check before beginStart today; both
    // pipelines are forced into it so the slot accounting is checked anyway.
    // A pipeline that throws from beginStart (closed).
    const closedRoom = createRoom();
    const closedPipeline = new RoomMediaPipeline(closedRoom);
    closedPipeline.close();
    closedPipeline.state = 'idle';
    closedRoom._mediaPipeline = closedPipeline;
    const media = createStartMedia('A', []);
    await startFallbackRelay(closedRoom, media.router, null, { FFmpegRelay: media.FFmpegRelay, relayRuntime }).catch(() => {});
    assert.equal(activeFallbackPipelines(), activeBefore, 'a throwing beginStart releases the slot');
    assert.deepEqual(media.created, [], 'nothing is created for a refused start');

    // A pipeline whose beginStart returns null (another start holds it).
    const busyRoom = createRoom();
    const busyPipeline = new RoomMediaPipeline(busyRoom);
    busyPipeline.beginStart = () => null;
    busyRoom._mediaPipeline = busyPipeline;
    const busyMedia = createStartMedia('B', []);
    await startFallbackRelay(busyRoom, busyMedia.router, null, { FFmpegRelay: busyMedia.FFmpegRelay, relayRuntime }).catch(() => {});
    assert.equal(activeFallbackPipelines(), activeBefore, 'a null beginStart releases the slot');
    assert.deepEqual(busyMedia.created, [], 'nothing is created for a refused start');
    busyPipeline.close();
});
