const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { startFallbackRelay, stopFallbackRelay } = require('../lib/socket');
const { RoomMediaPipeline } = require('../lib/roomMediaPipeline');

// The flush timer is a real setInterval; the tests drive it with mock timers and
// move the relay's injected clock themselves, so nothing here sleeps.
const FLUSH_TIMER = 'timer:reorder-flush';

class FakeRelay extends EventEmitter {
    constructor(opts) {
        super();
        this.opts = opts;
        this.frames = [];
    }

    async start() {
        this.emit('spawn');
    }

    stop() {}

    beginBurst() {}

    writeVideoFrame(data, timestamp) {
        this.frames.push({ timestamp, keyframe: data.includes(IDR) });
        return true;
    }

    writeAudioRtp() {}

    get restartCount() { return 0; }
}

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

function createRoom() {
    return {
        code: 'REORD1',
        fallbackStarting: false,
        fallbackWorker: null,
        fallbackAvailable: false,
        fallbackGeneration: 0,
        fallbackViewers: new Set(),
        frameRate: 30,
        relayVideoKbps: 14000,
        obsVideoCodec: 'h264',
        whipProducer: { id: 'video-producer' },
        whipAudioProducer: null,
    };
}

// Starts a relay on `room` and returns the sender side of its video consumer.
async function startRelay(room, clock, recordedTimers) {
    const consumers = [];
    const router = {
        rtpCapabilities: {},
        async createDirectTransport() {
            return {
                close() {},
                async consume() {
                    const consumer = new EventEmitter();
                    consumer.close = () => {};
                    consumer.requestKeyFrame = async () => {};
                    consumer.pause = async () => {};
                    consumer.resume = async () => {};
                    consumers.push(consumer);
                    return consumer;
                },
            };
        },
    };
    const pipeline = room._mediaPipeline || new RoomMediaPipeline(room);
    room._mediaPipeline = pipeline;
    if (recordedTimers && !pipeline.recordsTimers) {
        const setTimer = pipeline.setTimer.bind(pipeline);
        pipeline.recordsTimers = true;
        pipeline.setTimer = (name, timer, clear) => {
            recordedTimers.push({ name: `timer:${name}`, timer, clear });
            return setTimer(name, timer, clear);
        };
    }
    const io = { sockets: { sockets: new Map() }, to: () => ({ emit() {} }) };
    await startFallbackRelay(room, router, io, {
        FFmpegRelay: FakeRelay,
        relayRuntime: { now: () => clock.now, measureBacklogBytes: () => 0 },
    });
    assert.equal(pipeline.state, 'running');

    const video = consumers[0];
    let sequence = 0;
    let frames = 0;
    const send = (payload, options = {}) => {
        const timestamp = frames * 3000;
        video.emit('rtp', rtp(payload, { sequence: sequence++, timestamp, ...options }));
    };
    return {
        relay: room.fallbackWorker,
        pipeline,
        // One frame, as one RTP packet (a keyframe carries its parameter sets).
        frame({ keyframe = false } = {}) {
            clock.now += 33;
            if (keyframe) {
                send(SPS);
                send(PPS);
                send(IDR, { marker: true });
            } else {
                send(SLICE, { marker: true });
            }
            frames += 1;
        },
        // A frame whose packet is lost on the way to Node.
        lostFrame() {
            clock.now += 33;
            sequence += 1;
            frames += 1;
        },
    };
}

test('a tail held behind a lost packet reaches the relay after the wait, though no packet follows', { concurrency: false }, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const clock = { now: 1_000_000 };
    const room = createRoom();
    const sender = await startRelay(room, clock);
    try {
        sender.frame({ keyframe: true });
        sender.frame();
        assert.equal(sender.relay.frames.length, 2, 'the frames that arrived in order were fed');

        // One frame is lost; the frame after it is held for a retransmission, and
        // then the burst ends: OBS sends nothing more for now.
        sender.lostFrame();
        sender.frame();
        assert.equal(sender.relay.frames.length, 2, 'the frame behind the hole is held');

        // Within the wait it stays held, however often the timer runs.
        clock.now += 60;
        t.mock.timers.tick(100);
        assert.equal(sender.relay.frames.length, 2, 'still held before the wait is over');

        clock.now += 80;
        t.mock.timers.tick(100);
        assert.equal(sender.relay.frames.length, 3, 'released once the wait is over, without another packet');
        assert.equal(room.fallbackSource.lostPackets, 1, 'the skipped packet is counted');

        // Released once: later ticks feed nothing more.
        clock.now += 1000;
        t.mock.timers.tick(1000);
        assert.equal(sender.relay.frames.length, 3);
    } finally {
        sender.pipeline.close();
    }
});

test('the flush timer is registered through the pipeline and goes with the fallback', { concurrency: false }, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const clock = { now: 1_000_000 };
    const room = createRoom();
    const timers = [];
    const sender = await startRelay(room, clock, timers);
    try {
        const registered = timers.filter((entry) => entry.name === FLUSH_TIMER);
        assert.equal(registered.length, 1, 'one flush timer, registered by name through pipeline.setTimer');
        assert.equal(typeof registered[0].clear, 'function', 'registered with a clear function');
        assert.equal(sender.pipeline._resources.has(FLUSH_TIMER), true, 'the pipeline owns it');

        sender.frame({ keyframe: true });
        sender.lostFrame();
        sender.frame();
        assert.equal(sender.relay.frames.length, 1);

        // Torn down with a tail still held: the timer is cleared with the rest.
        stopFallbackRelay(room);
        assert.equal(sender.pipeline._resources.has(FLUSH_TIMER), false, 'closeFallback() released it');
        clock.now += 1000;
        t.mock.timers.tick(1000);
        assert.equal(sender.relay.frames.length, 1, 'a stopped relay is fed nothing by a late flush');
    } finally {
        sender.pipeline.close();
    }
});

test('a flush timer of a stopped start does not feed the newer start on the same pipeline', { concurrency: false }, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const clock = { now: 1_000_000 };
    const room = createRoom();
    const a = await startRelay(room, clock);
    try {
        a.frame({ keyframe: true });
        a.lostFrame();
        a.frame();
        assert.equal(a.relay.frames.length, 1);

        stopFallbackRelay(room);
        const b = await startRelay(room, clock);
        assert.equal(b.pipeline, a.pipeline, 'B reuses the pipeline');
        assert.notEqual(b.relay, a.relay);

        clock.now += 1000;
        t.mock.timers.tick(1000);
        assert.equal(a.relay.frames.length, 1, "A's tail is not delivered after A stopped");
        assert.equal(b.relay.frames.length, 0, "B is not fed A's tail");

        // B's own flush works.
        b.frame({ keyframe: true });
        b.lostFrame();
        b.frame();
        assert.equal(b.relay.frames.length, 1);
        clock.now += 1000;
        t.mock.timers.tick(1000);
        assert.equal(b.relay.frames.length, 2, "B's tail is released by B's timer");
    } finally {
        a.pipeline.close();
    }
});
