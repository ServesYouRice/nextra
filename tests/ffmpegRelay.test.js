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

function fakeProcess({ writableLength = 0 } = {}) {
    const writes = [];
    return {
        writes,
        stdin: {
            writable: true,
            writableLength,
            write: (buffer) => {
                writes.push(buffer);
                return true;
            },
        },
    };
}

test('FFmpeg relay reads timestamped video and Ogg Opus from inherited pipes', () => {
    const relay = createRelay('h264');
    const args = relay._buildArgs();

    // Video input 0 is IVF over stdin: every frame carries its own timestamp.
    assert.equal(args[args.indexOf('-f') + 1], 'ivf');
    assert.ok(args.includes('pipe:0'));
    assert.ok(args.includes('-copyts'));
    assert.ok(!args.includes('-use_wallclock_as_timestamps'));
    assert.ok(args.includes('pipe:3'));
    assert.ok(!args.includes('-protocol_whitelist'));
    // Video is re-encoded (H.264) with a regular keyframe interval so late
    // viewers can start; audio is transcoded to AAC from the second input.
    assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
    assert.equal(args[args.indexOf('-g') + 1], '30');
    assert.ok(args.includes('1:a:0'));
    assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    // Output is fragmented MP4 to stdout with zero mux latency.
    assert.equal(args[args.indexOf('-muxpreload') + 1], '0');
    assert.equal(args[args.indexOf('-muxdelay') + 1], '0');
    assert.equal(args[args.length - 1], 'pipe:1');
});

test('FFmpeg relay is tuned for delay', () => {
    const relay = createRelay('h264', { videoFrameRate: 60 });
    relay._videoEncoder = 'h264_nvenc';
    const args = relay._buildArgs();

    // No input probing window: the stream describes itself, and probing would
    // hold the first picture back by seconds.
    assert.equal(args[args.indexOf('-probesize') + 1], '32');
    assert.equal(args[args.indexOf('-analyzeduration') + 1], '0');
    // A few decoder threads at most: every frame thread holds back one frame.
    assert.equal(args[args.indexOf('-threads') + 1], '3');
    // The encoder emits each frame as soon as it is encoded.
    assert.equal(args[args.indexOf('-delay') + 1], '0');
    assert.equal(args[args.indexOf('-zerolatency') + 1], '1');
    // Fragments are a few frames long, not a whole GOP.
    assert.equal(args[args.indexOf('-frag_duration') + 1], String(config.FALLBACK_FRAGMENT_DURATION_MS * 1000));
    // The encoder is told the real frame rate: its rate control depends on it.
    assert.equal(args[args.indexOf('-r') + 1], '60');
    assert.equal(args[args.indexOf('-g') + 1], '60');
    // The option that added a second of delay when it was tried.
    assert.ok(!args.join(' ').includes('nobuffer'));
});

test('FFmpeg relay keeps half a second of rate-control buffer and does not pad a still picture', () => {
    const relay = createRelay('h264', { videoBitrateKbps: 8000 });
    relay._videoEncoder = 'h264_nvenc';
    const args = relay._buildArgs();
    assert.equal(args[args.indexOf('-b:v') + 1], '8000k');
    assert.equal(args[args.indexOf('-maxrate') + 1], '8000k');
    assert.equal(args[args.indexOf('-bufsize') + 1], '4000k');
    assert.ok(args.includes('-qmin'));
});

test('FFmpeg relay treats source timestamps as decode times when FFmpeg supports it', () => {
    const relay = createRelay('h264');
    relay._inputBsf = true;
    let args = relay._buildArgs();
    assert.equal(args[args.indexOf('-bsf:v') + 1], 'setts=pts=NOPTS:dts=PTS');
    assert.ok(args.indexOf('-bsf:v') < args.indexOf('pipe:0'), 'the filter belongs to the video input');

    relay._inputBsf = false;
    args = relay._buildArgs();
    assert.ok(!args.includes('-bsf:v'));
});

test('FFmpeg relay omits the audio input when there is no audio', () => {
    const relay = createRelay('h264', { hasAudio: false });
    const args = relay._buildArgs();
    assert.ok(args.includes('-an'));
    assert.ok(!args.includes('1:a:0'));
    assert.ok(!args.includes('pipe:3'));
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

test('the audio offset is off by default and applies to whichever stream it delays', () => {
    assert.ok(!createRelay('h264')._buildArgs().includes('-itsoffset'));

    // Positive: audio later, so the offset sits on the audio input.
    let args = createRelay('h264', { audioOffsetSec: 0.25 })._buildArgs();
    assert.equal(args[args.indexOf('-itsoffset') + 1], '0.250');
    assert.ok(args.indexOf('-itsoffset') > args.indexOf('pipe:0'));

    // Negative: audio earlier, which is the video input held back instead.
    args = createRelay('h264', { audioOffsetSec: -0.25 })._buildArgs();
    assert.equal(args[args.indexOf('-itsoffset') + 1], '0.250');
    assert.ok(args.indexOf('-itsoffset') < args.indexOf('pipe:0'));
});

test('writeVideoFrame returns false when the relay is not running', () => {
    const relay = createRelay('h264');
    assert.equal(relay.writeVideoFrame(Buffer.from([0, 0, 0, 1]), 0), false);
});

test('writeVideoFrame wraps each frame with its size and timestamp', () => {
    const relay = createRelay('h264', { hasAudio: false });
    relay._running = true;
    relay._process = fakeProcess();

    assert.equal(relay.writeVideoFrame(Buffer.from([1, 2, 3]), 90000), true);

    const frame = relay._process.writes[0];
    assert.equal(frame.readUInt32LE(0), 3);
    assert.equal(frame.readBigUInt64LE(4), 90000n);
    assert.deepEqual([...frame.subarray(12)], [1, 2, 3]);
});

test('writeVideoFrame drops whole frames while stdin is backed up and reports the gap once it clears', () => {
    const relay = createRelay('h264', { hasAudio: false });
    relay._running = true;
    relay._process = fakeProcess({ writableLength: 5 * 1024 * 1024 });
    let videoGaps = 0;
    relay.on('video-gap', () => { videoGaps += 1; });

    assert.equal(relay.writeVideoFrame(Buffer.alloc(512), 0), false);
    assert.equal(relay.totalStdinDroppedBytes, 512);
    assert.equal(relay._process.writes.length, 0);

    // FFmpeg caught up. The frame that finds that out is not written either:
    // the frames before it are gone, so nothing decodes until the next keyframe.
    relay._process.stdin.writableLength = 0;
    assert.equal(relay.writeVideoFrame(Buffer.alloc(64), 3000), false);
    assert.equal(videoGaps, 1);
    assert.equal(relay.writeVideoFrame(Buffer.alloc(64), 6000), true);
    assert.equal(relay._process.writes.length, 1);
});

test('a replayed GOP is not mistaken for FFmpeg falling behind', () => {
    const relay = createRelay('h264', { hasAudio: false });
    relay._running = true;
    relay._process = fakeProcess({ writableLength: 0 });

    // Ten megabytes written at once on purpose: stdin holds it for a moment.
    relay.beginBurst(10 * 1024 * 1024);
    relay._process.stdin.writableLength = 10 * 1024 * 1024;
    assert.equal(relay.writeVideoFrame(Buffer.alloc(64), 0), true);

    // Once FFmpeg has worked through it the normal limit applies again.
    relay._process.stdin.writableLength = 0;
    assert.equal(relay.writeVideoFrame(Buffer.alloc(64), 3000), true);
    relay._process.stdin.writableLength = 10 * 1024 * 1024;
    assert.equal(relay.writeVideoFrame(Buffer.alloc(64), 6000), false);
});

test('audio can be placed after a replayed GOP on the video timeline', () => {
    const relay = createRelay('h264');
    const { OggOpusMuxer } = require('../lib/oggOpusMuxer');
    relay._audioMuxer = new OggOpusMuxer({ channels: 2, sampleRate: 48000 });

    relay.setAudioStartSec(1.5);
    assert.equal(relay._audioMuxer.granule, 72000n);
    relay.setAudioStartSec(-3);
    assert.equal(relay._audioMuxer.granule, 0n);

    // Once audio has started, its position is fixed.
    relay._audioMuxer.baseTimestamp = 1234;
    relay.setAudioStartSec(2);
    assert.equal(relay._audioMuxer.granule, 0n);
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

test('reconfigure restarts at the new bitrate without using the restart budget', async () => {
    const relay = createRelay('h264', { hasAudio: false, videoBitrateKbps: 14000 });
    relay._videoEncoder = 'libx264';
    relay._running = true;
    let starts = 0;
    relay.start = async () => {
        starts += 1;
        relay._running = true;
    };

    await relay.reconfigure(5000);

    assert.equal(starts, 1);
    assert.equal(relay.restartCount, 0);
    assert.equal(relay.running, true);
    const args = relay._buildArgs();
    assert.equal(args[args.indexOf('-b:v') + 1], '5000k');
    assert.equal(args[args.indexOf('-bufsize') + 1], '2500k');
});

test('reconfigure while nothing runs only records the bitrate for the next start', async () => {
    const relay = createRelay('h264', { hasAudio: false, videoBitrateKbps: 14000 });
    relay._videoEncoder = 'libx264';
    relay.start = async () => { throw new Error('must not start'); };

    await relay.reconfigure(4000);

    const args = relay._buildArgs();
    assert.equal(args[args.indexOf('-b:v') + 1], '4000k');
    assert.equal(relay.running, false);
});

test('reconfigure starts the new process without waiting for the old one to go', async () => {
    const relay = createRelay('h264', { hasAudio: false, videoBitrateKbps: 14000 });
    relay._videoEncoder = 'libx264';
    relay._running = true;
    // A process that has not reported its exit yet.
    const killed = [];
    let reportExit = null;
    relay._process = {
        stdin: { end() {}, destroy() {} },
        stdout: { destroy() {} },
        stderr: { destroy() {} },
        kill: (signal) => killed.push(signal),
        on: (event, listener) => { if (event === 'exit') reportExit = listener; },
    };
    let started = false;
    relay.start = async () => {
        started = true;
        relay._running = true;
    };

    const done = relay.reconfigure(6000);

    // Every moment between the two is a moment without video for the viewers.
    assert.equal(started, true);
    assert.deepEqual(killed, ['SIGTERM']);
    await done;
    assert.equal(relay.running, true);
    reportExit();
});

test('a relay that passes the source through copies the video and still converts the audio', () => {
    const relay = createRelay('h264', { videoCopy: true, videoBitrateKbps: 18000 });
    relay._videoEncoder = 'h264_nvenc';
    relay._inputBsf = true;
    const args = relay._buildArgs();

    assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
    // Nothing that belongs to decoding or encoding: no bitrate, no frame rate,
    // no pixel format, no timestamp rewrite for a decoder.
    for (const flag of ['-b:v', '-maxrate', '-g', '-r', '-pix_fmt', '-threads', '-bsf:v', '-preset']) {
        assert.equal(args.includes(flag), false, flag);
    }
    // The rest of the pipeline is the same: timestamped input, AAC audio, short
    // fragments.
    assert.equal(args[args.indexOf('-f') + 1], 'ivf');
    assert.ok(args.includes('-copyts'));
    assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    assert.equal(args[args.indexOf('-frag_duration') + 1], String(config.FALLBACK_FRAGMENT_DURATION_MS * 1000));
});

test('reconfigure switches between passing the source through and re-encoding it', async () => {
    const relay = createRelay('h264', { hasAudio: false, videoBitrateKbps: 14000 });
    relay._videoEncoder = 'libx264';
    relay._running = true;
    relay.start = async () => { relay._running = true; };

    await relay.reconfigure(18000, { copy: true });
    assert.equal(relay.videoCopy, true);
    assert.equal(relay._buildArgs()[relay._buildArgs().indexOf('-c:v') + 1], 'copy');

    await relay.reconfigure(9000);
    assert.equal(relay.videoCopy, false);
    const args = relay._buildArgs();
    assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
    assert.equal(args[args.indexOf('-b:v') + 1], '9000k');
});
