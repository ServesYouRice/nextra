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

// A stdin whose queue grows with every write, as a pipe that FFmpeg has not read
// from yet does. `drain()` is FFmpeg catching up.
function queueingProcess() {
    const proc = fakeProcess();
    proc.stdin.write = (buffer) => {
        proc.writes.push(buffer);
        proc.stdin.writableLength += buffer.length;
        return true;
    };
    proc.drain = () => { proc.stdin.writableLength = 0; };
    return proc;
}

test('a replayed GOP of the declared size is written whole to a fresh process (VAL-013)', () => {
    const relay = createRelay('h264', { hasAudio: false });
    relay._running = true;
    relay._process = queueingProcess();
    let videoGaps = 0;
    relay.on('video-gap', () => { videoGaps += 1; });

    // Ten 1 MiB frames, 10 MiB in all, written back to back into an empty stdin.
    const frames = 10;
    const frameBytes = 1024 * 1024;
    relay.beginBurst(frames * frameBytes);
    for (let i = 0; i < frames; i += 1) {
        assert.equal(relay.writeVideoFrame(Buffer.alloc(frameBytes), i * 3000), true, `frame ${i} of the burst`);
    }

    assert.equal(relay._process.writes.length, frames);
    assert.ok(relay._process.stdin.writableLength > 4 * 1024 * 1024, 'the burst is held by stdin, past the normal cap');
    assert.equal(relay.totalStdinDroppedBytes, 0);
    assert.equal(videoGaps, 0);
});

test('the normal cap and the video-gap return once the burst has been written and has drained (VAL-013)', () => {
    const relay = createRelay('h264', { hasAudio: false });
    relay._running = true;
    relay._process = queueingProcess();
    let videoGaps = 0;
    relay.on('video-gap', () => { videoGaps += 1; });

    const frameBytes = 1024 * 1024;
    relay.beginBurst(6 * frameBytes);
    for (let i = 0; i < 6; i += 1) assert.equal(relay.writeVideoFrame(Buffer.alloc(frameBytes), i * 3000), true);
    // Written, not yet read: the live frame that follows is still taken.
    assert.equal(relay.writeVideoFrame(Buffer.alloc(64), 6 * 3000), true);

    // FFmpeg has worked through the burst: the 4 MiB cap is back.
    relay._process.drain();
    assert.equal(relay.writeVideoFrame(Buffer.alloc(64), 7 * 3000), true);
    relay._process.stdin.writableLength = 5 * 1024 * 1024;
    assert.equal(relay.writeVideoFrame(Buffer.alloc(512), 8 * 3000), false);
    assert.equal(relay.totalStdinDroppedBytes, 512);
    assert.equal(videoGaps, 0);

    // Once it catches up the gap is reported, as it is without a burst.
    relay._process.drain();
    assert.equal(relay.writeVideoFrame(Buffer.alloc(64), 9 * 3000), false);
    assert.equal(videoGaps, 1);
    assert.equal(relay.writeVideoFrame(Buffer.alloc(64), 10 * 3000), true);
});

test('a burst that is declared but not yet written keeps its allowance while stdin is empty (VAL-013)', () => {
    const relay = createRelay('h264', { hasAudio: false });
    relay._running = true;
    relay._process = queueingProcess();

    relay.beginBurst(8 * 1024 * 1024);
    // Two frames in, stdin is still under the normal cap: the other six are due.
    assert.equal(relay.writeVideoFrame(Buffer.alloc(1024 * 1024), 0), true);
    assert.equal(relay.writeVideoFrame(Buffer.alloc(1024 * 1024), 3000), true);
    relay._process.stdin.writableLength = 9 * 1024 * 1024;
    assert.equal(relay.writeVideoFrame(Buffer.alloc(1024 * 1024), 6000), true);
    assert.equal(relay.totalStdinDroppedBytes, 0);
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

// --- Lifecycle against a stubbed spawn -------------------------------------
//
// lib/ffmpegRelay.js takes `spawn` from child_process when it loads, so each
// test loads its own copy of the module with a fake spawn in place. A fresh copy
// also has fresh NVENC/BSF probe caches, so a probe can be held pending. No real
// FFmpeg is started.

const { EventEmitter } = require('node:events');

function fakeStream() {
    return Object.assign(new EventEmitter(), {
        writable: true,
        writableLength: 0,
        write() { return true; },
        end() {},
        destroy() {},
    });
}

function fakeChild(args) {
    const child = new EventEmitter();
    child.args = args;
    child.stdin = fakeStream();
    child.stdout = fakeStream();
    child.stderr = fakeStream();
    child.stdio = [child.stdin, child.stdout, child.stderr, fakeStream()];
    child.killed = [];
    child.exited = false;
    // Report an exit the way Node does: synchronously from the 'exit' event.
    child.exit = (code, signal = null) => {
        if (child.exited) return;
        child.exited = true;
        child.emit('exit', code, signal);
    };
    // A kill is answered a moment later, as a real process would.
    child.kill = (signal = 'SIGTERM') => {
        child.killed.push(signal);
        setImmediate(() => child.exit(null, signal));
        return true;
    };
    return child;
}

function loadRelayWithFakeSpawn() {
    const childProcess = require('node:child_process');
    const modulePath = require.resolve('../lib/ffmpegRelay');
    const previous = require.cache[modulePath];
    const realSpawn = childProcess.spawn;
    const relays = [];
    const probes = [];
    childProcess.spawn = (command, args, options) => {
        const child = fakeChild(args);
        // The probes run with stdio 'ignore'; relay processes pipe everything.
        (options && options.stdio === 'ignore' ? probes : relays).push(child);
        return child;
    };
    delete require.cache[modulePath];
    try {
        const mod = require(modulePath);
        return { FFmpegRelay: mod.FFmpegRelay, relays, probes };
    } finally {
        childProcess.spawn = realSpawn;
        if (previous) require.cache[modulePath] = previous;
        else delete require.cache[modulePath];
    }
}

function createLifecycleRelay(fake, { probed = true } = {}) {
    const relay = new fake.FFmpegRelay({ roomCode: 'LIFE01', videoCodec: 'h264', hasAudio: false });
    if (probed) {
        // As after a first start(): the encoder choice is known, no probe runs.
        relay._videoEncoder = 'libx264';
        relay._inputBsf = false;
    }
    return relay;
}

const flush = async (rounds = 3) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function quietLogs(t) {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
}

test('an owner stop() during the restart backoff keeps FFmpeg stopped (VAL-011)', async (t) => {
    quietLogs(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fake = loadRelayWithFakeSpawn();
    const relay = createLifecycleRelay(fake);

    await relay.start();
    assert.equal(fake.relays.length, 1);

    // FFmpeg dies on its own: the relay restarts it after a 1s backoff ...
    fake.relays[0].exit(1, null);
    assert.equal(relay.restartCount, 1);
    // ... and the owner tears the relay down during that second.
    t.mock.timers.tick(500);
    relay.stop();
    t.mock.timers.tick(500);
    await flush();
    t.mock.timers.tick(5000);
    await flush();

    assert.equal(fake.relays.length, 1, 'no FFmpeg may be spawned after the owner stopped the relay');
    assert.equal(relay.running, false);
});

test('an owner stop() from an exit listener keeps FFmpeg stopped (VAL-011)', async (t) => {
    quietLogs(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fake = loadRelayWithFakeSpawn();
    const relay = createLifecycleRelay(fake);
    relay.on('exit', () => relay.stop());

    await relay.start();
    fake.relays[0].exit(1, null);
    t.mock.timers.tick(1000);
    await flush();
    t.mock.timers.tick(5000);
    await flush();

    assert.equal(fake.relays.length, 1, 'no FFmpeg may be spawned after an exit listener stopped the relay');
    assert.equal(relay.running, false);
    assert.equal(relay.restartCount, 0, 'a restart the owner cancelled uses no budget');
});

test('an owner stop() while start() awaits the encoder probes prevents the spawn (VAL-011)', async (t) => {
    quietLogs(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });

    // Stopped while the NVENC probe is pending.
    let fake = loadRelayWithFakeSpawn();
    let relay = createLifecycleRelay(fake, { probed: false });
    let starting = relay.start();
    assert.equal(fake.probes.length, 1, 'the NVENC probe is running');
    relay.stop();
    for (let i = 0; i < 3; i += 1) {
        for (const probe of fake.probes) probe.exit(0, null);
        await flush();
    }
    await starting;
    assert.equal(fake.relays.length, 0, 'stop() during the NVENC probe must prevent the spawn');
    assert.equal(relay.running, false);

    // Stopped while the input-BSF probe is pending (the NVENC probe is done).
    fake = loadRelayWithFakeSpawn();
    relay = createLifecycleRelay(fake, { probed: false });
    starting = relay.start();
    fake.probes[0].exit(1, null);
    await flush();
    assert.equal(fake.probes.length, 2, 'the BSF probe is running');
    relay.stop();
    fake.probes[1].exit(0, null);
    await flush();
    await starting;
    assert.equal(fake.relays.length, 0, 'stop() during the BSF probe must prevent the spawn');
    assert.equal(relay.running, false);

    // A fresh start() after that stop() spawns exactly one process, with the
    // probe results it already has.
    await relay.start();
    assert.equal(fake.relays.length, 1);
    assert.equal(relay.running, true);
    assert.equal(fake.relays[0].args[fake.relays[0].args.indexOf('-c:v') + 1], 'libx264');
    assert.ok(fake.relays[0].args.includes('-bsf:v'));
    relay.stop();
    await flush();
});

test('a running FFmpeg that dies by a signal is restarted and uses the restart budget (VAL-012)', async (t) => {
    quietLogs(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fake = loadRelayWithFakeSpawn();
    const relay = createLifecycleRelay(fake);

    await relay.start();
    // A decoder or driver crash on Linux/macOS: no exit code, a signal.
    fake.relays[0].exit(null, 'SIGSEGV');
    assert.equal(relay.restartCount, 1, 'the crash uses one restart');
    t.mock.timers.tick(1000);
    await flush();

    assert.equal(fake.relays.length, 2, 'the crashed FFmpeg is replaced');
    assert.equal(relay.running, true);
    relay.stop();
    await flush();
});

test('signal crashes stop at the restart cap (VAL-012)', async (t) => {
    quietLogs(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fake = loadRelayWithFakeSpawn();
    const relay = createLifecycleRelay(fake);
    const errors = [];
    relay.on('error', (err) => errors.push(err));
    const originalCap = config.FALLBACK_RESTART_CAP;
    config.FALLBACK_RESTART_CAP = 1;
    try {
        await relay.start();
        fake.relays[0].exit(null, 'SIGKILL');
        t.mock.timers.tick(1000);
        await flush();
        assert.equal(fake.relays.length, 2);

        fake.relays[1].exit(null, 'SIGKILL');
        t.mock.timers.tick(1000);
        await flush();
    } finally {
        config.FALLBACK_RESTART_CAP = originalCap;
    }

    assert.equal(fake.relays.length, 2, 'no spawn past the cap');
    assert.equal(relay.restartCount, 2);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /restart cap \(1\) reached/);
    assert.equal(relay.running, false);
});

test('a long healthy run still refills the budget before a signal crash is restarted', async (t) => {
    quietLogs(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const fake = loadRelayWithFakeSpawn();
    const relay = createLifecycleRelay(fake);

    await relay.start();
    relay._restartCount = 3;
    t.mock.timers.tick(60_000);
    fake.relays[0].exit(null, 'SIGABRT');
    assert.equal(relay.restartCount, 1, 'budget reset after a healthy minute, then one restart used');
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(fake.relays.length, 2);
    relay.stop();
    await flush();
});

test('the relay\'s own stop() and a reconfigure never trigger a restart (VAL-011, VAL-012)', async (t) => {
    quietLogs(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fake = loadRelayWithFakeSpawn();
    const relay = createLifecycleRelay(fake);

    await relay.start();
    assert.equal(fake.relays.length, 1);

    // reconfigure replaces the process at once and uses no budget; the old
    // process's exit (it was sent SIGTERM) changes nothing.
    await relay.reconfigure(5000);
    assert.equal(fake.relays.length, 2);
    assert.deepEqual(fake.relays[0].killed, ['SIGTERM']);
    assert.equal(fake.relays[1].args[fake.relays[1].args.indexOf('-b:v') + 1], '5000k');
    await flush();
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(fake.relays.length, 2);
    assert.equal(relay.restartCount, 0);
    assert.equal(relay.running, true);

    // The relay's own stop() kills with a signal; that exit is not a crash.
    relay.stop();
    await flush();
    assert.equal(fake.relays[1].exited, true);
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(fake.relays.length, 2);
    assert.equal(relay.restartCount, 0);
    assert.equal(relay.running, false);

    // FFmpeg traps SIGTERM and usually exits 255 without a signal: still no restart.
    await relay.start();
    assert.equal(fake.relays.length, 3, 'a fresh start() after stop() spawns one process');
    fake.relays[2].kill = (signal = 'SIGTERM') => {
        fake.relays[2].killed.push(signal);
        setImmediate(() => fake.relays[2].exit(255, null));
        return true;
    };
    relay.stop();
    await flush();
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(fake.relays.length, 3);
    assert.equal(relay.restartCount, 0);
});

test('stop() and a new start() clear an unfinished burst allowance (VAL-013)', async (t) => {
    quietLogs(t);
    const fake = loadRelayWithFakeSpawn();
    const relay = createLifecycleRelay(fake);

    await relay.start();
    relay.beginBurst(10 * 1024 * 1024);
    relay.stop();
    await flush();
    assert.equal(relay._burstRemainingBytes, 0, 'stop() clears the burst');

    // A burst announced on the old process must not follow a new one.
    relay.beginBurst(10 * 1024 * 1024);
    await relay.start();
    assert.equal(relay._burstRemainingBytes, 0, 'start() clears the burst');
    fake.relays[1].stdin.writableLength = 5 * 1024 * 1024;
    assert.equal(relay.writeVideoFrame(Buffer.alloc(512), 0), false, 'the normal cap applies to the new process');
    assert.equal(relay.totalStdinDroppedBytes, 512);
    relay.stop();
    await flush();
});
