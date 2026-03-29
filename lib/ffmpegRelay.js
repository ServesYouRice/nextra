// lib/ffmpegRelay.js - FFmpeg spawn/stop/restart for OBS fallback relay
'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../config');
const { FMP4Parser } = require('./fmp4Parser');

class FFmpegRelay extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.roomCode
     * @param {string} opts.videoCodec - 'av1' | 'h264'
     * @param {boolean} opts.hasAudio
     * @param {number} opts.videoRtpPort
     * @param {number} opts.videoRtcpPort
     * @param {number} opts.audioRtpPort
     * @param {number} opts.audioRtcpPort
     * @param {number} opts.videoPayloadType
     * @param {number} opts.audioPayloadType
     * @param {number} [opts.videoClockRate=90000]
     * @param {number} [opts.audioClockRate=48000]
     */
    constructor(opts) {
        super();
        this.roomCode = opts.roomCode;
        this.videoCodec = opts.videoCodec;
        this.hasAudio = opts.hasAudio;
        this.videoRtpPort = opts.videoRtpPort;
        this.videoRtcpPort = opts.videoRtcpPort;
        this.audioRtpPort = opts.audioRtpPort;
        this.audioRtcpPort = opts.audioRtcpPort;
        this.videoPayloadType = opts.videoPayloadType;
        this.audioPayloadType = opts.audioPayloadType;
        this.videoClockRate = opts.videoClockRate || 90000;
        this.audioClockRate = opts.audioClockRate || 48000;

        this._process = null;
        this._parser = new FMP4Parser();
        this._running = false;
        this._restartCount = 0;
        this._sdpPath = null;

        // Forward parser events
        this._parser.on('init', (data) => this.emit('init', data));
        this._parser.on('fragment', (data) => this.emit('fragment', data));
        this._parser.on('error', (err) => this.emit('error', err));
    }

    /**
     * Build SDP content describing the RTP streams for FFmpeg input.
     */
    _buildSdp() {
        const codecName = this.videoCodec === 'av1' ? 'AV1' : 'H264';
        const lines = [
            'v=0',
            'o=- 0 0 IN IP4 127.0.0.1',
            's=Nextra Fallback',
            'c=IN IP4 127.0.0.1',
            't=0 0',
            `m=video ${this.videoRtpPort} RTP/AVP ${this.videoPayloadType}`,
            `a=rtpmap:${this.videoPayloadType} ${codecName}/${this.videoClockRate}`,
            'a=recvonly',
        ];

        if (this.hasAudio) {
            lines.push(
                `m=audio ${this.audioRtpPort} RTP/AVP ${this.audioPayloadType}`,
                `a=rtpmap:${this.audioPayloadType} opus/${this.audioClockRate}/2`,
                'a=recvonly',
            );
        }

        lines.push('');
        return lines.join('\r\n');
    }

    /**
     * Build FFmpeg command arguments.
     */
    _buildArgs(sdpPath) {
        const fragDurationUs = config.FALLBACK_FRAGMENT_DURATION_MS * 1000;

        const args = [
            '-protocol_whitelist', 'file,udp,rtp',
            '-fflags', '+nobuffer+discardcorrupt',
            '-i', sdpPath,
            '-c:v', 'copy',
        ];

        if (this.hasAudio) {
            args.push(
                '-c:a', 'aac',
                '-b:a', config.FALLBACK_AUDIO_BITRATE,
                '-ac', '2',
            );
        } else {
            args.push('-an');
        }

        args.push(
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-frag_duration', String(fragDurationUs),
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

        // Write SDP to temp file
        const sdpContent = this._buildSdp();
        this._sdpPath = path.join(os.tmpdir(), `nextra-ffmpeg-${this.roomCode}-${Date.now()}.sdp`);
        fs.writeFileSync(this._sdpPath, sdpContent, 'utf-8');

        const args = this._buildArgs(this._sdpPath);
        console.log(`[FFmpeg] Starting for room ${this.roomCode}: ${config.FFMPEG_PATH} ${args.join(' ')}`);

        this._parser.reset();
        this._running = true;

        this._process = spawn(config.FFMPEG_PATH, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Pipe stdout to parser
        this._process.stdout.on('data', (chunk) => {
            try {
                this._parser.push(chunk);
            } catch (err) {
                this.emit('error', err);
            }
        });

        // Log stderr (FFmpeg logs info/warnings to stderr)
        let stderrBuffer = '';
        this._process.stderr.on('data', (chunk) => {
            stderrBuffer += chunk.toString();
            const lines = stderrBuffer.split('\n');
            stderrBuffer = lines.pop(); // keep incomplete line
            for (const line of lines) {
                if (line.trim()) {
                    console.log(`[FFmpeg:${this.roomCode}] ${line.trim()}`);
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
            const wasRunning = this._running;
            this._running = false;
            this._process = null;

            this.emit('exit', { code, signal });

            // Unexpected exit — attempt restart only for non-zero exit code,
            // not for signal-based termination (our own stop() sends SIGTERM → signal != null)
            if (wasRunning && code !== 0 && signal == null) {
                this.restart().catch((err) => {
                    this.emit('error', err);
                });
            }
        });
    }

    /**
     * Stop the FFmpeg process gracefully.
     */
    stop() {
        this._running = false;

        if (this._process) {
            const proc = this._process;
            this._process = null;

            try { proc.stdout.destroy(); } catch { }
            try { proc.stderr.destroy(); } catch { }

            // Send SIGTERM, then SIGKILL after 3s
            try { proc.kill('SIGTERM'); } catch { }
            const killTimer = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch { }
            }, 3000);
            proc.on('exit', () => clearTimeout(killTimer));
        }

        // Clean up temp SDP file
        if (this._sdpPath) {
            try { fs.unlinkSync(this._sdpPath); } catch { }
            this._sdpPath = null;
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
