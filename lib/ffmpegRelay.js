// lib/ffmpegRelay.js - FFmpeg spawn/stop/restart for OBS fallback relay
'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const config = require('../config');
const { FMP4Parser } = require('./fmp4Parser');
const { OggOpusMuxer } = require('./oggOpusMuxer');
const { ivfHeader, ivfFrame } = require('./ivf');
const { readVideoTrackInfo, fragmentStartsWithKeyframe, fragmentVideoTimeSec } = require('./relayMp4');

function mediaDebugLog(...args) {
    if (config.MEDIA_DEBUG_LOGS) {
        console.log(...args);
    }
}

// A run this long counts as "healthy" and replenishes the restart budget, so
// transient hiccups spread over a multi-hour stream cannot permanently exhaust
// FALLBACK_RESTART_CAP and kill the relay for the room.
const RESTART_BUDGET_RESET_UPTIME_MS = 60_000;

// Cap on bytes queued in FFmpeg's stdin stream. Anything queued here is latency
// the viewer sees, so a relay that cannot keep up drops frames early and resumes
// from the next keyframe instead of falling seconds behind.
const MAX_STDIN_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_BUFFERED_BYTES = 1024 * 1024;


function probeFfmpeg(args, timeoutMs = 5000) {
    return new Promise((resolve) => {
        let settled = false;
        let timeout = null;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            resolve(ok);
        };
        let proc;
        try {
            proc = spawn(config.FFMPEG_PATH, args, { stdio: 'ignore' });
        } catch {
            finish(false);
            return;
        }
        proc.on('error', () => finish(false));
        proc.on('exit', (code) => finish(code === 0));
        timeout = setTimeout(() => { try { proc.kill(); } catch {} finish(false); }, timeoutMs);
        timeout.unref?.();
    });
}

// Probe once whether this machine's FFmpeg can actually encode with NVENC. We
// prefer NVENC for the relay transcode (the host already runs OBS on the GPU, so
// CPU is the scarce resource and NVENC can do native-res/4K cheaply). Cached so
// the cost is paid a single time.
let _nvencProbe = null;
let _nvencProbeStatus = {
    state: 'not-started',
    startedAt: null,
    completedAt: null,
    durationMs: null,
};
function probeNvenc() {
    if (_nvencProbe) return _nvencProbe;
    const startedAtMs = Date.now();
    _nvencProbeStatus = {
        state: 'probing',
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: null,
        durationMs: null,
    };
    _nvencProbe = probeFfmpeg([
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30',
        '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-',
    ]).then((ok) => {
        const completedAtMs = Date.now();
        _nvencProbeStatus = {
            state: ok ? 'available' : 'unavailable',
            startedAt: new Date(startedAtMs).toISOString(),
            completedAt: new Date(completedAtMs).toISOString(),
            durationMs: completedAtMs - startedAtMs,
        };
        return ok;
    });
    return _nvencProbe;
}

// OBS stamps WHIP video in decode order. With B-frames those are not presentation
// times, so FFmpeg is told to treat them as decode times and derive the rest
// (FFmpeg 7.1+ accepts a bitstream filter on an input). Older builds go without:
// correct for streams without B-frames, which is what WHIP is meant to carry.
let _inputBsfProbe = null;
function probeInputBsf() {
    if (!_inputBsfProbe) {
        _inputBsfProbe = probeFfmpeg([
            '-hide_banner', '-loglevel', 'error',
            '-bsf:v', 'setts=pts=NOPTS:dts=PTS',
            '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1',
            '-frames:v', '1', '-f', 'null', '-',
        ]);
    }
    return _inputBsfProbe;
}

function warmNvencProbe() {
    probeInputBsf();
    return probeNvenc();
}

function getNvencProbeStatus() {
    return { ..._nvencProbeStatus };
}

class FFmpegRelay extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.roomCode
     * @param {string} opts.videoCodec - must be 'h264'
     * @param {boolean} opts.hasAudio
     * @param {number} [opts.audioClockRate=48000]
     */
    constructor(opts) {
        super();
        this.roomCode = opts.roomCode;
        this.videoCodec = opts.videoCodec;
        this.hasAudio = opts.hasAudio;
        this.audioClockRate = opts.audioClockRate || 48000;
        this.videoFrameRate = opts.videoFrameRate || 30;
        // Relay output bitrate (kbps). Defaults to the 1440p@30 tier; the host
        // sends the exact value for its selected quality profile.
        this.videoBitrateKbps = opts.videoBitrateKbps || 14000;
        // Pass the source's video through untouched instead of re-encoding it.
        // Only right for a source that already is what viewers need (a keyframe
        // every second or so, no B-frames) on a link that carries its bitrate.
        this.videoCopy = opts.videoCopy === true;
        // Optional A/V fine-tune in seconds: positive plays audio later, negative
        // earlier. Audio and video carry their real timestamps, so this is 0
        // unless a particular setup needs correcting.
        this.audioOffsetSec = Number.isFinite(opts.audioOffsetSec) ? opts.audioOffsetSec : 0;
        // Chosen at start() once the probes resolve.
        this._videoEncoder = null;
        this._inputBsf = null;

        this._process = null;
        this._parser = new FMP4Parser();
        this._trackInfo = null;
        this._running = false;
        this._restartCount = 0;
        this._audioMuxer = null;
        this._initEmitted = false;
        this._spawnedAt = 0;
        this._stdinCap = MAX_STDIN_BUFFERED_BYTES;
        this._stdinDropping = false;
        this._stdinDroppedBytes = 0;
        this._totalStdinDroppedBytes = 0;
        this._reconfiguring = false;

        if (this.videoCodec !== 'h264') {
            throw new Error(`FFmpeg relay only supports H.264 input in this build (received ${this.videoCodec || 'unknown'})`);
        }

        // Forward parser events
        this._parser.on('init', (data) => {
            this._initEmitted = true;
            this._trackInfo = readVideoTrackInfo(data.initSegment);
            mediaDebugLog(`[FFmpeg] Parser emitted init for room ${this.roomCode}, forwarding (listeners: ${this.listenerCount('init')})`);
            this.emit('init', data);
        });
        this._parser.on('fragment', (data) => {
            if (data.sequence <= 3) mediaDebugLog(`[FFmpeg] Parser emitted fragment #${data.sequence} for room ${this.roomCode}`);
            // Fragments are far shorter than a GOP, so most of them do not start
            // on a keyframe; a viewer can only begin (or resume) on one that does.
            data.keyframeStart = fragmentStartsWithKeyframe(data.data, this._trackInfo);
            data.videoTimeSec = fragmentVideoTimeSec(data.data, this._trackInfo);
            this.emit('fragment', data);
        });
        this._parser.on('error', (err) => this.emit('error', err));
    }

    /**
     * Build FFmpeg command arguments.
     *
     * Video arrives on stdin as IVF: one H.264 access unit per frame (already
     * depacketized, SPS/PPS before every keyframe) with its RTP timestamp. Audio
     * is Opus RTP wrapped in Ogg pages on fd 3, timed from its RTP clock. Both are
     * re-stamped from zero on the same instant, so the muxed output stays in sync
     * without a frame-rate guess, and stays in sync when the source drops frames.
     *
     * Everything here is tuned for delay: no input probing window, no decoder
     * frame-thread queue, an encoder that emits each frame immediately, and
     * fragments a few frames long.
     */
    _buildArgs() {
        const fps = String(this.videoFrameRate);
        const args = [
            // Suppress the version/config banner; surface only warnings/errors
            // (the relay still mirrors these during the init phase for diagnosis).
            '-hide_banner',
            '-loglevel', 'warning',
            // Both inputs start at zero on the same instant; keep it that way.
            '-copyts',
        ];

        // Input 0: video. Frame threads would hold back one frame per thread
        // (half a second on a 16-thread CPU), so decode with just enough of them
        // to keep up. Probing is pointless (the stream describes itself) and
        // would delay the first picture by seconds.
        if (this.audioOffsetSec < 0) {
            args.push('-itsoffset', Math.abs(this.audioOffsetSec).toFixed(3));
        }
        if (!this.videoCopy) {
            args.push('-threads', this.videoFrameRate > 30 ? '3' : '2');
            if (this._inputBsf) {
                args.push('-bsf:v', 'setts=pts=NOPTS:dts=PTS');
            }
        }
        args.push(
            '-probesize', '32',
            '-analyzeduration', '0',
            '-f', 'ivf',
            '-i', 'pipe:0',
        );

        if (this.hasAudio) {
            // Input 1: Ogg Opus over an inherited pipe.
            if (this.audioOffsetSec > 0) {
                args.push('-itsoffset', this.audioOffsetSec.toFixed(3));
            }
            args.push('-probesize', '32', '-analyzeduration', '0', '-f', 'ogg', '-i', 'pipe:3');
        }

        if (this.videoCopy) {
            // The source as it is: nothing is lost to a second encode. Used when
            // the source already is what viewers need and the link carries it.
            args.push('-map', '0:v:0', '-c:v', 'copy');
        } else {
            // Re-encode: the relay needs its own bitrate (what the viewers'
            // connection carries, not what OBS sends) and a keyframe every second
            // so a viewer can start within one GOP whatever OBS's own GOP is.
            // Source resolution is kept. The output frame rate is fixed: the
            // encoder's rate control needs it, and it pads a source that drops
            // frames.
            const bitrate = `${this.videoBitrateKbps}k`;
            // Half a second of VBV: enough for a keyframe, small enough that the
            // stream cannot burst far above what the connection was measured to
            // carry.
            const bufsize = `${Math.round(this.videoBitrateKbps / 2)}k`;
            args.push('-map', '0:v:0', '-pix_fmt', 'yuv420p', '-r', fps);
            if (this._videoEncoder === 'h264_nvenc') {
                args.push(
                    '-c:v', 'h264_nvenc',
                    '-preset', 'p5',
                    '-tune', 'll',
                    '-profile:v', 'high',
                    '-rc', 'cbr',
                    '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bufsize,
                    // Without a floor CBR spends the whole budget on a still screen.
                    '-qmin', '16', '-qmax', '51',
                    '-g', fps,
                    '-bf', '0',
                    '-forced-idr', '1',
                    '-strict_gop', '1',
                    // Emit each frame as soon as it is encoded.
                    '-delay', '0',
                    '-zerolatency', '1',
                );
            } else {
                args.push(
                    '-c:v', 'libx264',
                    '-preset', 'veryfast',
                    '-tune', 'zerolatency',
                    '-profile:v', 'high',
                    '-g', fps,
                    '-keyint_min', fps,
                    '-sc_threshold', '0',
                    '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bufsize,
                );
            }
        }

        if (this.hasAudio) {
            args.push(
                '-map', '1:a:0',
                '-c:a', 'aac',
                '-b:a', config.FALLBACK_AUDIO_BITRATE,
                '-ac', '2',
            );
        } else {
            args.push('-an');
        }

        args.push(
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            // Short fragments are what keeps the relay close to live: a fragment
            // can only be sent once it is complete, and only be played once it has
            // fully arrived.
            '-frag_duration', String(Math.max(1, config.FALLBACK_FRAGMENT_DURATION_MS) * 1000),
            '-muxpreload', '0',
            '-muxdelay', '0',
            '-flush_packets', '1',
            '-f', 'mp4',
            'pipe:1',
        );

        return args;
    }

    /**
     * Start the FFmpeg process.
     */
    async start() {
        if (this._running) return;

        // Pick the video encoder once: NVENC if available (keeps the CPU free for
        // OBS), otherwise libx264.
        if (!this._videoEncoder) {
            this._videoEncoder = (await probeNvenc()) ? 'h264_nvenc' : 'libx264';
            console.log(`[FFmpeg] Relay video encoder for room ${this.roomCode}: ${this._videoEncoder}`);
        }
        if (this._inputBsf === null) {
            this._inputBsf = await probeInputBsf();
        }
        if (this._running) return;

        const args = this._buildArgs();
        console.log(`[FFmpeg] Starting for room ${this.roomCode}: ${config.FFMPEG_PATH} ${args.join(' ')}`);

        this._parser.reset();
        this._trackInfo = null;
        this._initEmitted = false;
        this._running = true;

        const child = spawn(config.FFMPEG_PATH, args, {
            // stdin = video IVF, stdout = fMP4, stderr = logs, fd 3 = Ogg Opus.
            stdio: this.hasAudio ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        });
        this._process = child;
        this._spawnedAt = Date.now();
        this._stdinCap = MAX_STDIN_BUFFERED_BYTES;
        this._stdinDropping = false;
        this._stdinDroppedBytes = 0;
        // Ignore EPIPE/errors on stdin — they occur when FFmpeg exits while we are
        // mid-write and must not crash the process.
        child.stdin.on('error', () => {});
        child.stdin.write(ivfHeader());
        if (this.hasAudio) {
            this._audioMuxer = new OggOpusMuxer({ channels: 2, sampleRate: this.audioClockRate });
            child.stdio[3].on('error', () => {});
            child.stdio[3].write(this._audioMuxer.headers());
        }
        this.emit('spawn');

        // Pipe stdout to parser
        child.stdout.on('data', (chunk) => {
            try {
                this._parser.push(chunk);
            } catch (err) {
                this.emit('error', err);
            }
        });

        // Log stderr (FFmpeg logs info/warnings to stderr)
        let stderrBuffer = '';
        const recentStderrLines = [];
        child.stderr.on('data', (chunk) => {
            stderrBuffer += chunk.toString();
            const lines = stderrBuffer.split('\n');
            stderrBuffer = lines.pop(); // keep incomplete line
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                // Expected with a zero-length probe; says nothing useful.
                if (/not enough frames to estimate rate/.test(trimmed)) continue;

                // Always surface FFmpeg output during the startup/init phase so
                // init-segment failures are diagnosable; quiet down once media is
                // flowing (unless MEDIA_DEBUG_LOGS is explicitly enabled).
                if (config.MEDIA_DEBUG_LOGS || !this._initEmitted) {
                    console.log(`[FFmpeg:${this.roomCode}] ${trimmed}`);
                    continue;
                }

                recentStderrLines.push(trimmed);
                if (recentStderrLines.length > 12) {
                    recentStderrLines.shift();
                }
            }
        });

        child.on('error', (err) => {
            console.error(`[FFmpeg] Spawn error for room ${this.roomCode}:`, err);
            if (this._process === child) this._running = false;
            this.emit('error', err);
        });

        child.on('exit', (code, signal) => {
            console.log(`[FFmpeg] Exited for room ${this.roomCode} (code=${code}, signal=${signal})`);
            if (code !== 0 && signal == null && recentStderrLines.length > 0) {
                console.warn(`[FFmpeg:${this.roomCode}] Recent stderr before exit:\n${recentStderrLines.join('\n')}`);
            }
            // A process superseded by a newer spawn must not clear the new one's state.
            if (this._process && this._process !== child) return;
            const wasRunning = this._running;
            this._running = false;
            this._process = null;

            // A sustained healthy run replenishes the restart budget so transient
            // failures over a long stream never permanently disable the relay.
            const uptimeMs = this._spawnedAt ? Date.now() - this._spawnedAt : 0;
            if (wasRunning && uptimeMs >= RESTART_BUDGET_RESET_UPTIME_MS && this._restartCount > 0) {
                mediaDebugLog(`[FFmpeg] Healthy run (${Math.round(uptimeMs / 1000)}s) for room ${this.roomCode} — resetting restart budget`);
                this._restartCount = 0;
            }

            this.emit('exit', { code, signal });

            // Unexpected exit — restart on ANY exit code while we considered
            // ourselves running: a clean code-0 exit mid-stream (e.g. stdin EOF)
            // still leaves viewers with no media. Signal-based termination is our
            // own stop() (SIGTERM/SIGKILL) and must not restart.
            if (wasRunning && signal == null) {
                this.restart().catch((err) => {
                    this.emit('error', err);
                });
            }
        });
    }

    /**
     * Feed one H.264 access unit (Annex-B, SPS/PPS before every keyframe) with
     * its timestamp in 90 kHz ticks since the start of this FFmpeg process.
     *
     * Returns false when the frame was not taken. If FFmpeg stops reading, frames
     * are dropped whole rather than queued (a queue here is delay for every
     * viewer); once it catches up 'video-gap' fires and the caller must resume
     * from a keyframe, because the frames in between are gone.
     */
    writeVideoFrame(data, timestamp) {
        const proc = this._process;
        if (!this._running || !proc || !proc.stdin || !proc.stdin.writable) return false;
        // A burst has drained once stdin is back under the normal cap.
        if (proc.stdin.writableLength <= MAX_STDIN_BUFFERED_BYTES) this._stdinCap = MAX_STDIN_BUFFERED_BYTES;
        if (proc.stdin.writableLength > this._stdinCap) {
            this._stdinDropping = true;
            this._stdinDroppedBytes += data.length;
            this._totalStdinDroppedBytes += data.length;
            return false;
        }
        if (this._stdinDropping) {
            this._stdinDropping = false;
            console.warn(`[FFmpeg] Dropped ${this._stdinDroppedBytes} bytes of video for room ${this.roomCode} while stdin was backed up; resuming from the next keyframe`);
            this._stdinDroppedBytes = 0;
            this.emit('video-gap');
            return false;
        }
        try {
            proc.stdin.write(ivfFrame(data, timestamp));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Announce a deliberate burst of `bytes` (the cached GOP replayed into a
     * fresh process). Until FFmpeg has worked through it, that much queued input
     * is expected and must not be mistaken for FFmpeg falling behind.
     */
    beginBurst(bytes) {
        this._stdinCap = MAX_STDIN_BUFFERED_BYTES + Math.max(0, bytes) * 2;
    }

    /**
     * Place the first audio packet of this process at `seconds` on the video
     * timeline instead of at zero. Used when video starts from a keyframe that
     * is already in the past: the audio that follows belongs after it.
     */
    setAudioStartSec(seconds) {
        const muxer = this._audioMuxer;
        if (!muxer || muxer.baseTimestamp !== null) return;
        const samples = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * this.audioClockRate) : 0;
        muxer.granule = BigInt(samples);
    }

    /** Feed one Opus RTP packet from a mediasoup DirectTransport consumer. */
    writeAudioRtp(packet) {
        const proc = this._process;
        const audioPipe = proc?.stdio?.[3];
        if (!this._running || !this._audioMuxer || !audioPipe?.writable) return false;
        const page = this._audioMuxer.pushRtp(packet);
        if (!page || audioPipe.writableLength > MAX_AUDIO_BUFFERED_BYTES) return false;
        try {
            return audioPipe.write(page);
        } catch {
            return false;
        }
    }

    /**
     * Stop the FFmpeg process gracefully.
     */
    stop() {
        this._running = false;
        this._stdinDropping = false;
        this._stdinDroppedBytes = 0;
        this._audioMuxer = null;

        if (this._process) {
            const proc = this._process;
            this._process = null;

            try { proc.stdin.end(); } catch { }
            try { proc.stdin.destroy(); } catch { }
            try { proc.stdout.destroy(); } catch { }
            try { proc.stderr.destroy(); } catch { }
            try { proc.stdio?.[3]?.end(); } catch { }
            try { proc.stdio?.[3]?.destroy(); } catch { }

            // Send SIGTERM, then SIGKILL after 3s
            try { proc.kill('SIGTERM'); } catch { }
            const killTimer = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch { }
            }, 3000);
            proc.on('exit', () => clearTimeout(killTimer));
        }

        this._parser.reset();
    }

    /**
     * Deliberately restart FFmpeg with a new video bitrate, or to pass the
     * source's video through (`copy`). Unlike restart() this is not a failure,
     * so it does not use up the restart budget.
     * @param {number} videoBitrateKbps
     * @param {{ copy?: boolean }} [options]
     */
    async reconfigure(videoBitrateKbps, { copy = false } = {}) {
        // Recorded even when nothing is running, so a restart that is already
        // under way (or a later crash recovery) picks the new settings up.
        this.videoBitrateKbps = videoBitrateKbps;
        this.videoCopy = copy === true;
        if (!this._running || this._reconfiguring) return;
        this._reconfiguring = true;
        try {
            console.log(`[FFmpeg] Restarting for room ${this.roomCode} ${this.videoCopy ? 'to pass the source video through' : `at ${videoBitrateKbps}kbps`}`);
            // The old process is not waited for: until the new one produces
            // output the viewers get nothing, and their players only hold a
            // fraction of a second in reserve. It has been cut off from this
            // relay's pipes and parser, and its exit is ignored once the new
            // process is in place (see the exit handler).
            this.stop();
            await this.start();
        } finally {
            this._reconfiguring = false;
        }
    }

    /**
     * Restart the FFmpeg process (on failure, with cap).
     */
    async restart() {
        this._restartCount++;

        if (this._restartCount > config.FALLBACK_RESTART_CAP) {
            const msg = `FFmpeg restart cap (${config.FALLBACK_RESTART_CAP}) reached for room ${this.roomCode}`;
            console.error(`[FFmpeg] ${msg}`);
            this.emit('error', new Error(msg));
            return;
        }

        console.log(`[FFmpeg] Restarting for room ${this.roomCode} (attempt ${this._restartCount}/${config.FALLBACK_RESTART_CAP})`);

        this.stop();

        // Brief delay before restart
        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (!this._running) {
            await this.start();
        }
    }

    get running() { return this._running; }
    get restartCount() { return this._restartCount; }
    get totalStdinDroppedBytes() { return this._totalStdinDroppedBytes; }
    get initSegment() { return this._parser.initSegment; }
}

module.exports = { FFmpegRelay, warmNvencProbe, getNvencProbeStatus };
