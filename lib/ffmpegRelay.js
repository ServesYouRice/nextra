// lib/ffmpegRelay.js - FFmpeg spawn/stop/restart for OBS fallback relay
'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const config = require('../config');
const { FMP4Parser } = require('./fmp4Parser');
const { OggOpusMuxer } = require('./oggOpusMuxer');

function mediaDebugLog(...args) {
    if (config.MEDIA_DEBUG_LOGS) {
        console.log(...args);
    }
}

// A run this long counts as "healthy" and replenishes the restart budget, so
// transient hiccups spread over a multi-hour stream cannot permanently exhaust
// FALLBACK_RESTART_CAP and kill the relay for the room.
const RESTART_BUDGET_RESET_UPTIME_MS = 60_000;

// Cap on bytes queued in FFmpeg's stdin stream. If FFmpeg stalls (encoder
// hiccup, NVENC session contention) Node would otherwise buffer the full
// ingest bitrate in memory with no bound.
const MAX_STDIN_BUFFERED_BYTES = 16 * 1024 * 1024;

// Probe once whether this machine's FFmpeg can actually encode with NVENC. We
// prefer NVENC for the relay transcode (the host already runs OBS on the GPU, so
// CPU is the scarce resource and NVENC can do native-res/4K cheaply). Cached so
// the cost is paid a single time.
let _nvencProbe = null;
function probeNvenc() {
    if (_nvencProbe) return _nvencProbe;
    _nvencProbe = new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
        let proc;
        try {
            proc = spawn(config.FFMPEG_PATH, [
                '-hide_banner', '-loglevel', 'error',
                '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30',
                '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-',
            ], { stdio: 'ignore' });
        } catch {
            finish(false);
            return;
        }
        proc.on('error', () => finish(false));
        proc.on('exit', (code) => finish(code === 0));
        setTimeout(() => { try { proc.kill(); } catch {} finish(false); }, 5000);
    });
    return _nvencProbe;
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
        this.h264ProfileLevelId = opts.h264ProfileLevelId || null;
        this.h264SpropParameterSets = opts.h264SpropParameterSets || null;
        this.videoFrameRate = opts.videoFrameRate || 30;
        // Relay output bitrate (kbps). Defaults to the 1440p@30 tier; the host
        // sends the exact value for its selected quality profile.
        this.videoBitrateKbps = opts.videoBitrateKbps || 14000;
        // Seconds to delay the audio input to compensate for the relay's audio
        // bootstrap (audio resumes a moment after the video pipe starts).
        this.audioOffsetSec = Number.isFinite(opts.audioOffsetSec) ? opts.audioOffsetSec : 0;
        // Extra audio delay for the one-time startup video backlog: frames
        // buffered during transport/spawn setup are fed first and get synthetic
        // PTS from 0, so they sit "in the past" relative to the live audio that
        // resumes after the bootstrap delay. Without matching the audio offset to
        // this backlog, audio plays ahead of the corresponding video. Set per
        // (re)start via setStartupVideoBacklogSec(); consumed and cleared in
        // start() so a restart (which has no backlog) is not over-delayed.
        this._startupBacklogSec = 0;
        // Chosen at start() once the NVENC probe resolves: 'h264_nvenc' | 'libx264'.
        this._videoEncoder = null;

        this._process = null;
        this._parser = new FMP4Parser();
        this._running = false;
        this._restartCount = 0;
        this._audioMuxer = null;
        this._initEmitted = false;
        this._preStartBuffer = [];
        this._preStartBytes = 0;
        this._spawnedAt = 0;
        this._stdinDropping = false;
        this._stdinDroppedBytes = 0;

        if (this.videoCodec !== 'h264') {
            throw new Error(`FFmpeg relay only supports H.264 input in this build (received ${this.videoCodec || 'unknown'})`);
        }

        // Forward parser events
        this._parser.on('init', (data) => {
            this._initEmitted = true;
            mediaDebugLog(`[FFmpeg] Parser emitted init for room ${this.roomCode}, forwarding (listeners: ${this.listenerCount('init')})`);
            this.emit('init', data);
        });
        this._parser.on('fragment', (data) => {
            if (data.sequence <= 3) mediaDebugLog(`[FFmpeg] Parser emitted fragment #${data.sequence} for room ${this.roomCode}`);
            this.emit('fragment', data);
        });
        this._parser.on('error', (err) => this.emit('error', err));
    }

    /**
     * Build FFmpeg command arguments.
     *
     * Video is read as a raw H.264 Annex-B stream from stdin (pipe:0) — the relay
     * has already depacketized the RTP and injected SPS/PPS before every keyframe,
     * so FFmpeg gets a clean, self-describing stream and never stalls on missing
     * parameter sets. Node wraps Opus RTP in Ogg pages for pipe:3, and FFmpeg
     * transcodes it to AAC without binding a UDP socket. Video uses synthetic
     * constant-rate PTS; audio uses RTP-derived Ogg granule timing.
     */
    _buildArgs() {
        const movFlags = 'frag_keyframe+empty_moov+default_base_moof';

        // Optional A/V fine-tune. Audio and video are started on the same event
        // (first keyframe), so this is normally 0. Positive delays audio (apply
        // itsoffset to the audio input); negative delays video instead (apply it to
        // the video input) so audio effectively moves earlier.
        const avOffset = this.audioOffsetSec + this._startupBacklogSec;

        const args = [
            // Suppress the version/config banner; surface only warnings/errors
            // (the relay still mirrors these during the init phase for diagnosis).
            '-hide_banner',
            '-loglevel', 'warning',
        ];

        // Input 0: video — raw H.264 Annex-B over stdin. Assign timestamps at a
        // constant frame rate. Do NOT use wallclock here: the depacketizer feeds
        // FFmpeg in bursts (bootstrap flush + RTP bursts), so wallclock produces
        // wildly wrong frame durations and the player can't pace playback.
        if (avOffset < 0) {
            args.push('-itsoffset', Math.abs(avOffset).toFixed(3));
        }
        args.push(
            '-fflags', '+genpts',
            '-r', String(this.videoFrameRate),
            '-f', 'h264',
            '-i', 'pipe:0',
        );

        if (this.hasAudio) {
            // Input 1: Ogg Opus over an inherited pipe. Ogg granule positions are
            // derived from RTP timestamps; FFmpeg normalizes output to start at zero.
            if (avOffset > 0) {
                args.push('-itsoffset', avOffset.toFixed(3));
            }
            args.push('-f', 'ogg', '-i', 'pipe:3');
        }

        // Transcode video (re-encode) rather than copy: OBS WHIP uses an effectively
        // infinite GOP and ignores keyframe requests, so the source has a single
        // keyframe at stream start — a viewer joining later could never decode. We
        // re-encode at the SOURCE resolution (no downscale) and the host's selected
        // tier bitrate, with a 1-second GOP so any viewer can start within one GOP.
        const bitrate = `${this.videoBitrateKbps}k`;
        const bufsize = `${this.videoBitrateKbps * 2}k`;
        args.push('-map', '0:v:0', '-pix_fmt', 'yuv420p');
        if (this._videoEncoder === 'h264_nvenc') {
            args.push(
                '-c:v', 'h264_nvenc',
                '-preset', 'p5',
                '-tune', 'll',
                '-profile:v', 'high',
                '-rc', 'cbr',
                '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bufsize,
                '-g', String(this.videoFrameRate),
                '-bf', '0',
                '-no-scenecut', '1',
                '-forced-idr', '1',
            );
        } else {
            args.push(
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-tune', 'zerolatency',
                '-profile:v', 'high',
                '-g', String(this.videoFrameRate),
                '-keyint_min', String(this.videoFrameRate),
                '-sc_threshold', '0',
                '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bufsize,
            );
        }
        // 1-second GOP + frag_keyframe (no frag_duration) ⇒ every fMP4 fragment is a
        // self-contained GOP starting with a keyframe, so any viewer can begin
        // decoding on whichever fragment it first receives.

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
            // No -frag_duration: fragment strictly on keyframes so each fragment is a
            // full, self-contained GOP (see the -g note above).
            '-movflags', movFlags,
            '-muxpreload', '0',
            '-muxdelay', '0',
            '-flush_packets', '1',
            '-f', 'mp4',
            'pipe:1',
        );

        return args;
    }

    /**
     * Record the duration of the one-time startup video backlog (frames buffered
     * before the FFmpeg pipe was ready). The next start() folds it into the audio
     * itsoffset so audio is not played ahead of the backlogged video, then clears
     * it — a restart streams live frames with no backlog and must not be delayed.
     * @param {number} sec
     */
    setStartupVideoBacklogSec(sec) {
        this._startupBacklogSec = Number.isFinite(sec) && sec > 0 ? sec : 0;
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

        console.log(`[FFmpeg] Starting relay for room ${this.roomCode} (video=pipe Annex-B, audio=${this.hasAudio ? 'pipe Ogg Opus' : 'none'})`);
        const args = this._buildArgs();
        // The startup backlog only applies to this first feed; a restart streams
        // live frames straight through, so clear it once the args have consumed it.
        this._startupBacklogSec = 0;
        console.log(`[FFmpeg] Starting for room ${this.roomCode}: ${config.FFMPEG_PATH} ${args.join(' ')}`);

        this._parser.reset();
        this._initEmitted = false;
        this._running = true;

        this._process = spawn(config.FFMPEG_PATH, args, {
            // stdin = video Annex-B, stdout = fMP4, stderr = logs, fd 3 = Ogg Opus.
            stdio: this.hasAudio ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        });
        this._spawnedAt = Date.now();
        this._stdinDropping = false;
        this._stdinDroppedBytes = 0;
        // Ignore EPIPE/errors on stdin — they occur when FFmpeg exits while we are
        // mid-write and must not crash the process.
        this._process.stdin.on('error', () => {});
        if (this.hasAudio) {
            this._audioMuxer = new OggOpusMuxer({ channels: 2, sampleRate: this.audioClockRate });
            this._process.stdio[3].on('error', () => {});
            this._process.stdio[3].write(this._audioMuxer.headers());
        }
        this.emit('spawn');

        // Pipe stdout to parser
        let totalStdoutBytes = 0;
        this._process.stdout.on('data', (chunk) => {
            totalStdoutBytes += chunk.length;
            if (config.MEDIA_DEBUG_LOGS && (totalStdoutBytes <= chunk.length || totalStdoutBytes % 100000 < chunk.length)) {
                mediaDebugLog(`[FFmpeg:${this.roomCode}] stdout chunk: ${chunk.length} bytes (total: ${totalStdoutBytes})`);
            }
            try {
                this._parser.push(chunk);
            } catch (err) {
                this.emit('error', err);
            }
        });

        // Log stderr (FFmpeg logs info/warnings to stderr)
        let stderrBuffer = '';
        const recentStderrLines = [];
        this._process.stderr.on('data', (chunk) => {
            stderrBuffer += chunk.toString();
            const lines = stderrBuffer.split('\n');
            stderrBuffer = lines.pop(); // keep incomplete line
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

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

        this._process.on('error', (err) => {
            console.error(`[FFmpeg] Spawn error for room ${this.roomCode}:`, err);
            this._running = false;
            this.emit('error', err);
        });

        this._process.on('exit', (code, signal) => {
            console.log(`[FFmpeg] Exited for room ${this.roomCode} (code=${code}, signal=${signal})`);
            if (code !== 0 && signal == null && recentStderrLines.length > 0) {
                console.warn(`[FFmpeg:${this.roomCode}] Recent stderr before exit:\n${recentStderrLines.join('\n')}`);
            }
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
     * Feed raw H.264 Annex-B bytes (already depacketized + SPS-injected) to FFmpeg.
     * If FFmpeg's stdin isn't ready yet (it is spawned a few ms after the video
     * consumer starts), the data is buffered (bounded) and flushed on spawn so the
     * initial keyframe — which OBS only sends once at stream start — is never lost.
     */
    writeVideo(buffer) {
        const proc = this._process;
        if (this._running && proc && proc.stdin && proc.stdin.writable) {
            this._flushPreStart();
            // Backpressure cap: if FFmpeg stops consuming stdin, Node would queue
            // the full ingest bitrate in memory with no bound. Past the cap, drop
            // the data instead; once FFmpeg catches up, emit 'video-gap' so the
            // caller can request a fresh keyframe (the gap is only cleanly
            // decodable again from the next IDR).
            if (proc.stdin.writableLength > MAX_STDIN_BUFFERED_BYTES) {
                this._stdinDropping = true;
                this._stdinDroppedBytes += buffer.length;
                return false;
            }
            if (this._stdinDropping) {
                this._stdinDropping = false;
                console.warn(`[FFmpeg] Dropped ${this._stdinDroppedBytes} bytes of video for room ${this.roomCode} while stdin was backed up; requesting keyframe`);
                this._stdinDroppedBytes = 0;
                this.emit('video-gap');
            }
            try {
                return proc.stdin.write(buffer);
            } catch {
                return false;
            }
        }
        // Not ready yet — buffer, capped so a never-starting process can't grow it
        // unbounded. We trim from the front but always keep the head (it holds the
        // bootstrap SPS/PPS+IDR that FFmpeg needs first).
        this._preStartBuffer.push(Buffer.from(buffer));
        this._preStartBytes += buffer.length;
        const CAP = 12 * 1024 * 1024;
        while (this._preStartBytes > CAP && this._preStartBuffer.length > 2) {
            this._preStartBytes -= this._preStartBuffer.splice(1, 1)[0].length;
        }
        return false;
    }

    _flushPreStart() {
        if (!this._preStartBuffer.length) return;
        const proc = this._process;
        const pending = this._preStartBuffer;
        this._preStartBuffer = [];
        this._preStartBytes = 0;
        for (const b of pending) {
            try { proc.stdin.write(b); } catch {}
        }
    }

    /** Feed one Opus RTP packet from a mediasoup DirectTransport consumer. */
    writeAudioRtp(packet) {
        const proc = this._process;
        const audioPipe = proc?.stdio?.[3];
        if (!this._running || !this._audioMuxer || !audioPipe?.writable) return false;
        const page = this._audioMuxer.pushRtp(packet);
        if (!page || audioPipe.writableLength > MAX_STDIN_BUFFERED_BYTES) return false;
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
        this._preStartBuffer = [];
        this._preStartBytes = 0;
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
    get initSegment() { return this._parser.initSegment; }
}

module.exports = { FFmpegRelay };
