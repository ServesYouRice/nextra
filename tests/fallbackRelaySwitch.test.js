const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { startFallbackRelay } = require('../lib/socket');

// A relay whose FFmpeg processes are lists of the frames written to them.
class FakeRelay extends EventEmitter {
    constructor(opts) {
        super();
        this.opts = opts;
        this.processes = [];
        this.reconfigured = [];
        this.copies = [];
        this.videoCopy = false;
    }

    async start() {
        this.processes.push([]);
        this.emit('spawn');
    }

    stop() {}

    beginBurst() {}

    writeVideoFrame(data, timestamp) {
        this.processes.at(-1).push({ timestamp, keyframe: data.includes(IDR) });
        return true;
    }

    // Like the real one: the old process is gone and the new one spawned before
    // this returns to its caller.
    async reconfigure(kbps, { copy = false } = {}) {
        this.reconfigured.push(kbps);
        this.copies.push(copy);
        this.videoCopy = copy;
        this.processes.push([]);
        this.emit('spawn');
    }

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

async function startRoom() {
    const clock = { now: 1_000_000 };
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
    const room = {
        code: 'SWITCH',
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
    const io = { sockets: { sockets: new Map() }, to: () => ({ emit() {} }) };
    await startFallbackRelay(room, router, io, {
        FFmpegRelay: FakeRelay,
        relayRuntime: { now: () => clock.now, measureBacklogBytes: () => 0 },
    });

    let sequence = 0;
    let frames = 0;
    const video = consumers[0];
    // One frame every 1/30 s; a keyframe carries its parameter sets.
    const sendFrame = ({ keyframe = false } = {}) => {
        const timestamp = frames * 3000;
        frames += 1;
        clock.now += 33;
        if (keyframe) {
            video.emit('rtp', rtp(SPS, { sequence: sequence++, timestamp }));
            video.emit('rtp', rtp(PPS, { sequence: sequence++, timestamp }));
            video.emit('rtp', rtp(IDR, { sequence: sequence++, timestamp, marker: true }));
        } else {
            video.emit('rtp', rtp(SLICE, { sequence: sequence++, timestamp, marker: true }));
        }
    };
    return { room, relay: room.fallbackWorker, clock, sendFrame, close: () => room._mediaPipeline.close() };
}

test('a bitrate change restarts the relay on the next keyframe from the source, starting with it', async () => {
    const { room, relay, sendFrame, close } = await startRoom();
    try {
        sendFrame({ keyframe: true });
        for (let i = 0; i < 9; i++) sendFrame();
        assert.equal(relay.processes.length, 1);
        assert.equal(relay.processes[0].length, 10);

        // A change is decided in the middle of a GOP. It waits.
        room.fallbackPendingBitrate = { kbps: 9000, deadline: Number.POSITIVE_INFINITY };
        for (let i = 0; i < 20; i++) sendFrame();
        assert.deepEqual(relay.reconfigured, []);
        assert.equal(relay.processes[0].length, 30);

        // The keyframe arrives: the old process got every frame before it, and
        // the new one starts with it, at the start of its own timeline.
        sendFrame({ keyframe: true });
        assert.deepEqual(relay.reconfigured, [9000]);
        assert.equal(room.fallbackPendingBitrate, null);
        assert.equal(relay.processes.length, 2);
        assert.equal(relay.processes[0].length, 30);
        assert.deepEqual(relay.processes[1], [{ timestamp: 0, keyframe: true }]);

        // And carries on from there, once.
        sendFrame();
        sendFrame();
        assert.deepEqual(relay.processes[1].map((frame) => frame.timestamp), [0, 3000, 6000]);
        sendFrame({ keyframe: true });
        assert.deepEqual(relay.reconfigured, [9000]);
        assert.equal(relay.processes[1].length, 4);
    } finally {
        close();
    }
});

test('a source whose keyframes are far apart does not hold a bitrate change up', async () => {
    const { room, relay, clock, sendFrame, close } = await startRoom();
    try {
        sendFrame({ keyframe: true });
        for (let i = 0; i < 14; i++) sendFrame();
        relay.emit('init', { initSegment: Buffer.from('ftypmoovavc1payload') });

        room.fallbackPendingBitrate = { kbps: 9000, deadline: clock.now + 1500 };
        const fragment = (sequence) => relay.emit('fragment', { sequence, hasVideo: true, keyframeStart: false, data: Buffer.alloc(1000, 1) });
        for (let i = 0; i < 30; i++) sendFrame();
        fragment(1);
        assert.deepEqual(relay.reconfigured, []);

        // No keyframe within the wait: the change goes ahead in the middle of the
        // GOP, and the new process is given the GOP so far to decode from.
        for (let i = 0; i < 20; i++) sendFrame();
        fragment(2);
        assert.deepEqual(relay.reconfigured, [9000]);
        assert.equal(relay.processes.length, 2);
        assert.equal(relay.processes[1].length, 65);
        assert.equal(relay.processes[1][0].keyframe, true);
        assert.equal(relay.processes[1][0].timestamp, 0);
    } finally {
        close();
    }
});

// A second of stream as OBS sends it with Nextra's settings: a keyframe, then 29 frames.
function sendSecond(sendFrame) {
    sendFrame({ keyframe: true });
    for (let i = 0; i < 29; i++) sendFrame();
}

test('the OBS stream is passed through untouched once it shows the settings Nextra wrote', async () => {
    const { room, relay, sendFrame, close } = await startRoom();
    try {
        room.obsEncoderSettingsApplied = true;
        const fragment = (sequence) => relay.emit('fragment', { sequence, hasVideo: true, keyframeStart: false, data: Buffer.alloc(1000, 1) });

        // One keyframe says nothing about how far apart they are.
        sendSecond(sendFrame);
        fragment(1);
        assert.deepEqual(relay.reconfigured, []);

        // The second one does: a keyframe every second, as asked. The switch
        // itself waits for the next keyframe, like any other.
        sendSecond(sendFrame);
        fragment(2);
        assert.deepEqual(relay.reconfigured, []);
        sendFrame({ keyframe: true });
        assert.deepEqual(relay.reconfigured, [14000]);
        assert.deepEqual(relay.copies, [true]);

        // And stays that way.
        for (let i = 0; i < 29; i++) sendFrame();
        sendSecond(sendFrame);
        fragment(3);
        sendSecond(sendFrame);
        assert.deepEqual(relay.copies, [true]);
    } finally {
        close();
    }
});

test('a stream Nextra did not configure is re-encoded, however it looks', async () => {
    const { relay, sendFrame, close } = await startRoom();
    try {
        const fragment = (sequence) => relay.emit('fragment', { sequence, hasVideo: true, keyframeStart: false, data: Buffer.alloc(1000, 1) });
        for (let second = 1; second <= 4; second++) {
            sendSecond(sendFrame);
            fragment(second);
        }
        // Keyframes a second apart, but nothing says there are no B-frames.
        assert.deepEqual(relay.reconfigured, []);
    } finally {
        close();
    }
});

test('a stream with keyframes far apart is re-encoded even on Nextra\'s settings', async () => {
    const { room, relay, sendFrame, close } = await startRoom();
    try {
        // The settings were written, but OBS is still running on its old ones.
        room.obsEncoderSettingsApplied = true;
        const fragment = (sequence) => relay.emit('fragment', { sequence, hasVideo: true, keyframeStart: false, data: Buffer.alloc(1000, 1) });
        for (let gop = 1; gop <= 3; gop++) {
            sendFrame({ keyframe: true });
            for (let i = 0; i < 249; i++) sendFrame();
            fragment(gop);
        }
        assert.deepEqual(relay.reconfigured, []);
    } finally {
        close();
    }
});
