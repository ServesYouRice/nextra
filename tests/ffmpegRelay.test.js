const test = require('node:test');
const assert = require('node:assert/strict');

const { FFmpegRelay, getNvencProbeStatus } = require('../lib/ffmpegRelay');
const config = require('../config');

function createRelay(videoCodec, opts = {}) {
    return new FFmpegRelay({
        roomCode: 'TEST01',
        videoCodec,
        hasAudio: opts.hasAudio !== undefined ? opts.hasAudio : true,
        ...opts,
    });
}

test('FFmpeg relay reads video and Ogg Opus from inherited pipes', () => {
    const relay = createRelay('h264');
    const args = relay._buildArgs();

    // Video input 0 is a raw H.264 Annex-B stream over stdin at a constant rate.
    assert.equal(args[args.indexOf('-f') + 1], 'h264');
    assert.ok(args.includes('pipe:0'));
    assert.ok(args.includes('-r'));
    assert.ok(!args.includes('-use_wallclock_as_timestamps'));
    assert.ok(args.includes('pipe:3'));
    assert.ok(!args.includes('-protocol_whitelist'));
    // Video is re-encoded (H.264) with a regular keyframe interval so late
    // viewers can start; audio is transcoded to AAC from the second input.
    assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
    assert.ok(args.includes('-g'));
    assert.ok(args.includes('1:a:0'));
    assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    // Output is fragmented MP4 to stdout with zero mux latency.
    assert.equal(args[args.indexOf('-muxpreload') + 1], '0');
    assert.equal(args[args.indexOf('-muxdelay') + 1], '0');
    assert.equal(args[args.length - 1], 'pipe:1');
});

test('FFmpeg relay omits the audio input when there is no audio', () => {
    const relay = createRelay('h264', { hasAudio: false });
    const args = relay._buildArgs(null);
    assert.ok(args.includes('-an'));
    assert.ok(!args.includes('1:a:0'));
});

test('FFmpeg relay rejects non-H.264 input', () => {
    assert.throws(() => createRelay('av1'), /H\.264 input/i);
});

test('NVENC probe diagnostics have a stable serializable shape', () => {
    const status = getNvencProbeStatus();
    assert.equal(status.state, 'not-started');
    assert.equal(status.startedAt, null);
    assert.equal(status.completedAt, null);
    assert.equal(status.durationMs, null);
    assert.doesNotThrow(() => JSON.stringify(status));
});

test('writeVideo returns false when the relay is not running', () => {
    const relay = createRelay('h264');
    assert.equal(relay.writeVideo(Buffer.from([0, 0, 0, 1])), false);
});

test('audio itsoffset is the bootstrap delay plus the startup video backlog', () => {
    const relay = createRelay('h264', { audioOffsetSec: 0.5 });
    relay.setStartupVideoBacklogSec(0.4);
    const args = relay._buildArgs('test.sdp');
    const idx = args.indexOf('-itsoffset');
    assert.ok(idx !== -1, 'itsoffset should be present');
    assert.equal(args[idx + 1], '0.900');
});

test('startup video backlog does not apply when there is no audio input', () => {
    const relay = createRelay('h264', { hasAudio: false, audioOffsetSec: 0.5 });
    relay.setStartupVideoBacklogSec(0.4);
    const args = relay._buildArgs(null);
    assert.ok(!args.includes('-itsoffset'));
});

test('setStartupVideoBacklogSec ignores invalid or negative values', () => {
    const relay = createRelay('h264', { audioOffsetSec: 0.5 });
    relay.setStartupVideoBacklogSec(-1);
    assert.equal(relay._buildArgs('test.sdp')[relay._buildArgs('test.sdp').indexOf('-itsoffset') + 1], '0.500');
    relay.setStartupVideoBacklogSec(NaN);
    assert.equal(relay._buildArgs('test.sdp')[relay._buildArgs('test.sdp').indexOf('-itsoffset') + 1], '0.500');
});

test('writeVideo bounds FFmpeg stdin backpressure and requests a keyframe after recovery', () => {
    const relay = createRelay('h264', { hasAudio: false });
    const writes = [];
    relay._running = true;
    relay._process = {
        stdin: {
            writable: true,
            writableLength: 17 * 1024 * 1024,
            write: (buffer) => {
                writes.push(buffer);
                return true;
            },
        },
    };
    let videoGaps = 0;
    relay.on('video-gap', () => { videoGaps += 1; });

    assert.equal(relay.writeVideo(Buffer.alloc(512)), false);
    assert.equal(relay.totalStdinDroppedBytes, 512);
    assert.equal(writes.length, 0);

    relay._process.stdin.writableLength = 0;
    assert.equal(relay.writeVideo(Buffer.alloc(64)), true);
    assert.equal(videoGaps, 1);
    assert.equal(writes.length, 1);
});

test('pre-start video buffering remains bounded while preserving the bootstrap head', () => {
    const relay = createRelay('h264', { hasAudio: false });
    const bootstrap = Buffer.alloc(4 * 1024 * 1024, 1);
    relay.writeVideo(bootstrap);
    relay.writeVideo(Buffer.alloc(4 * 1024 * 1024, 2));
    relay.writeVideo(Buffer.alloc(4 * 1024 * 1024, 3));
    relay.writeVideo(Buffer.alloc(4 * 1024 * 1024, 4));

    assert.ok(relay._preStartBytes <= 12 * 1024 * 1024);
    assert.equal(relay._preStartBuffer[0].equals(bootstrap), true);
    assert.equal(relay._preStartBuffer.length, 3);
});

test('restart stops at the configured budget without spawning another child', async () => {
    const relay = createRelay('h264', { hasAudio: false });
    const originalCap = config.FALLBACK_RESTART_CAP;
    const errors = [];
    config.FALLBACK_RESTART_CAP = 2;
    relay._restartCount = 2;
    relay.on('error', (err) => errors.push(err));

    try {
        await relay.restart();
    } finally {
        config.FALLBACK_RESTART_CAP = originalCap;
    }

    assert.equal(relay.restartCount, 3);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /restart cap \(2\) reached/);
    assert.equal(relay.running, false);
});
