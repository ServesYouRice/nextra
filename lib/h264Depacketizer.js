// lib/h264Depacketizer.js - Stateful H.264 RTP depacketizer.
//
// Reassembles a WebRTC/mediasoup H.264 RTP stream into an Annex-B elementary
// stream and injects the cached SPS/PPS into each keyframe access unit that
// lacks them (once per access unit, before its first IDR slice, and only the
// sets it does not carry in band). This lets the fallback relay feed
// FFmpeg a clean, self-describing stream over a pipe instead of relying on
// FFmpeg's RTP/SDP demuxer + sprop, which proved unreliable for OBS ingest
// (OBS emits parameter sets only once and bursts large keyframes over UDP).
'use strict';

const { rtpPayloadOffset } = require('./h264Sprop');

const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_IDR = 5;
const NAL_STAP_A = 24;
const NAL_FU_A = 28;

const ANNEXB_START = Buffer.from([0x00, 0x00, 0x00, 0x01]);

// Reassembly limits. RTP comes from an untrusted peer, and a stream that never
// ends a fragmented NAL or never sets the marker bit would otherwise grow the
// buffers until the process runs out of memory. A real keyframe is far smaller
// than these; the packet count also caps the per-buffer overhead of tiny packets.
const DEFAULT_MAX_NAL_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ACCESS_UNIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FRAGMENTS = 32768;

function positiveInteger(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

class H264Depacketizer {
    /**
     * @param {object} [opts]
     * @param {Buffer} [opts.sps] - parameter set to seed (OBS sends SPS once at
     *   stream start; seeding lets the relay inject it into every keyframe that
     *   lacks it even if the relay's own consumer never receives an in-band copy).
     * @param {Buffer} [opts.pps]
     * @param {function} [opts.onKeyframe] - called once per IDR NAL emitted; used
     *   to observe OBS's keyframe cadence (diagnostics).
     * @param {number} [opts.maxNalBytes] - largest fragmented (FU-A) NAL to
     *   reassemble, in bytes. Default 8 MiB.
     * @param {number} [opts.maxAccessUnitBytes] - largest access unit (whole
     *   frame) to assemble, in bytes, counting a fragmented NAL still in
     *   progress. Default 16 MiB.
     * @param {number} [opts.maxFragments] - most FU-A fragments in one NAL, and
     *   most packets in one access unit. Default 32768.
     *   A NAL or frame over a limit is dropped whole; see pushFrames.
     */
    constructor(opts = {}) {
        this._sps = opts.sps ? Buffer.from(opts.sps) : null;
        this._pps = opts.pps ? Buffer.from(opts.pps) : null;
        this._fuBuffer = null;   // accumulating FU-A payload
        this._fuBytes = 0;       // bytes held in _fuBuffer
        this._fuOverflow = false; // the last push() dropped a FU-A over a limit
        this._fuNalHeader = 0;   // reconstructed NAL header for the current FU-A
        this._fuExpectedSequence = null;
        this._fuTimestamp = null;
        this._fuSsrc = null;
        this._fuType = null;
        this._maxNalBytes = positiveInteger(opts.maxNalBytes, DEFAULT_MAX_NAL_BYTES);
        this._maxAccessUnitBytes = positiveInteger(opts.maxAccessUnitBytes, DEFAULT_MAX_ACCESS_UNIT_BYTES);
        this._maxFragments = positiveInteger(opts.maxFragments, DEFAULT_MAX_FRAGMENTS);
        this._onKeyframe = typeof opts.onKeyframe === 'function' ? opts.onKeyframe : null;
        // The access unit being depacketized (push): the packets that share an
        // SSRC and RTP timestamp, up to the marker. A parameter set is injected
        // at most once, before the first IDR slice, and only if the access unit
        // has not already carried or been given that set.
        this._auSsrc = null;
        this._auTimestamp = null;
        this._auSpsSeen = false;
        this._auPpsSeen = false;
        this._auSpsInjected = false;
        this._auPpsInjected = false;
        this._auIdrSeen = false;
        this._idrsMissingParameterSets = 0;
        // Access-unit assembly (pushFrames).
        this._pushHadIdr = false;
        this._frameChunks = [];
        this._frameBytes = 0;    // bytes held in _frameChunks
        this._frameTimestamp = null;
        this._frameKeyframe = false;
        this._frameIntact = true;
        this._lastSequence = null;
        // Timestamp of a frame dropped for size: its remaining packets are
        // skipped until its marker or the next timestamp.
        this._skipTimestamp = null;
    }

    get hasParameterSets() {
        return !!(this._sps && this._pps);
    }

    /**
     * How many keyframe access units were emitted with an SPS or a PPS still
     * missing after the cached ones were injected (nothing had been cached yet).
     */
    get idrsMissingParameterSets() {
        return this._idrsMissingParameterSets;
    }

    /**
     * Push one RTP packet (full packet buffer). Returns a Buffer of Annex-B data
     * to append to the FFmpeg input (may be empty).
     */
    push(rtpPacket) {
        const offset = rtpPayloadOffset(rtpPacket);
        if (offset < 0) return Buffer.alloc(0);
        const timestamp = rtpPacket.readUInt32BE(4);
        const ssrc = rtpPacket.readUInt32BE(8);
        const marker = (rtpPacket[1] & 0x80) !== 0;

        if (ssrc !== this._auSsrc || timestamp !== this._auTimestamp) {
            this._resetAccessUnit();
            this._auSsrc = ssrc;
            this._auTimestamp = timestamp;
        }
        const annexb = offset < rtpPacket.length
            ? this._depacketize(rtpPacket, offset, { timestamp, ssrc, marker })
            : Buffer.alloc(0);
        // The marker closes the access unit: whatever follows is a new one, even
        // if it carries the same timestamp.
        if (marker) this._resetAccessUnit();
        return annexb;
    }

    _resetAccessUnit() {
        this._auSsrc = null;
        this._auTimestamp = null;
        this._auSpsSeen = false;
        this._auPpsSeen = false;
        this._auSpsInjected = false;
        this._auPpsInjected = false;
        this._auIdrSeen = false;
    }

    // Put the cached parameter sets the access unit lacks in front of its first
    // IDR slice. Later slices of the same access unit get nothing: an SPS or PPS
    // between two slices of one picture would start a new access unit.
    _injectParameterSets(chunks) {
        if (this._auIdrSeen) return;
        this._auIdrSeen = true;
        const hasSps = this._auSpsSeen || this._auSpsInjected;
        const hasPps = this._auPpsSeen || this._auPpsInjected;
        if (!hasSps && this._sps) {
            chunks.push(ANNEXB_START, this._sps);
            this._auSpsInjected = true;
            // A PPS refers to its SPS, and a decoder drops one that precedes it;
            // so the PPS follows the SPS injected here, even if the access unit
            // carried one already (the cache holds that very PPS).
            if (this._pps) {
                chunks.push(ANNEXB_START, this._pps);
                this._auPpsInjected = true;
            }
        } else if (!hasPps && this._pps) {
            chunks.push(ANNEXB_START, this._pps);
            this._auPpsInjected = true;
        }
        if (!(this._auSpsSeen || this._auSpsInjected) || !(this._auPpsSeen || this._auPpsInjected)) {
            this._idrsMissingParameterSets++;
        }
    }

    _depacketize(rtpPacket, offset, { timestamp, ssrc, marker }) {
        let end = rtpPacket.length;
        if ((rtpPacket[0] & 0x20) !== 0 && end > offset) {
            const pad = rtpPacket[end - 1];
            if (pad > 0 && end - pad >= offset) end -= pad;
        }
        const payload = rtpPacket.subarray(offset, end);
        if (payload.length < 1) return Buffer.alloc(0);

        const type = payload[0] & 0x1f;
        const sequence = rtpPacket.readUInt16BE(2);
        const completeNals = [];

        if (type >= 1 && type <= 23) {
            this._dropFu();
            completeNals.push(Buffer.from(payload));
        } else if (type === NAL_STAP_A) {
            this._dropFu();
            let i = 1;
            while (i + 2 <= payload.length) {
                const size = payload.readUInt16BE(i);
                i += 2;
                if (size === 0 || i + size > payload.length) break;
                completeNals.push(Buffer.from(payload.subarray(i, i + size)));
                i += size;
            }
        } else if (type === NAL_FU_A) {
            const fu = this._handleFuA(payload, { sequence, timestamp, ssrc, marker });
            if (fu) completeNals.push(fu);
        } else {
            this._dropFu();
        }
        // Other types (FU-B/STAP-B/MTAP) are not produced by WebRTC; ignore.

        if (completeNals.length === 0) return Buffer.alloc(0);

        const chunks = [];
        for (const nal of completeNals) {
            if (!nal.length) continue;
            const nalType = nal[0] & 0x1f;
            if (nalType === NAL_SPS) {
                this._sps = Buffer.from(nal);
                this._auSpsSeen = true;
            } else if (nalType === NAL_PPS) {
                this._pps = Buffer.from(nal);
                this._auPpsSeen = true;
            }

            // Complete the keyframe's access unit with the cached parameter sets
            // it lacks, so FFmpeg can always decode it even when OBS omits them
            // in-band. Only its first IDR slice is preceded by them.
            if (nalType === NAL_IDR) {
                this._injectParameterSets(chunks);
                this._pushHadIdr = true;
                if (this._onKeyframe) this._onKeyframe();
            }
            chunks.push(ANNEXB_START, nal);
        }
        return Buffer.concat(chunks);
    }

    /**
     * Push one RTP packet and get back the access units (whole frames) it
     * completed, each as { data, timestamp, keyframe, intact }. A frame ends at
     * the RTP marker bit, or when a packet with a different timestamp arrives.
     * `intact` is false when packets went missing from the frame, so the caller
     * can wait for the next keyframe instead of decoding garbage. A frame that
     * vanishes entirely (nothing of it could be used) marks the next frame.
     *
     * A frame that grows past the byte or packet limits is dropped, the rest of
     * its packets are skipped, and the next frame is reported as not intact.
     */
    pushFrames(rtpPacket) {
        const frames = [];
        if (!Buffer.isBuffer(rtpPacket) || rtpPacket.length < 12) return frames;
        const sequence = rtpPacket.readUInt16BE(2);
        const timestamp = rtpPacket.readUInt32BE(4);
        const marker = (rtpPacket[1] & 0x80) !== 0;

        // Packets missing between the previous packet and this one.
        const missing = this._lastSequence === null
            ? 0
            : (sequence - this._lastSequence - 1) & 0xffff;
        this._lastSequence = sequence;

        if (this._skipTimestamp !== null) {
            if (timestamp === this._skipTimestamp) {
                // Still inside the dropped frame; its marker ends it.
                if (marker) this._skipTimestamp = null;
                return frames;
            }
            this._skipTimestamp = null;
        }

        if (this._frameTimestamp !== null && timestamp !== this._frameTimestamp) {
            // The pending frame never saw its marker, so packets lost just
            // before this one are its tail: it is the damaged frame.
            if (missing > 0) this._frameIntact = false;
            this._emitFrame(frames);
            // One lost packet is accounted for by the pending frame's marker
            // packet. More than that may have taken the start of this frame too.
            if (missing > 1) this._frameIntact = false;
        } else if (missing > 0) {
            // A gap inside a frame damages that frame; a gap after a frame that
            // closed on its marker damages the frame that starts here.
            this._frameIntact = false;
        }

        this._pushHadIdr = false;
        this._fuOverflow = false;
        const annexb = this.push(rtpPacket);
        if (annexb.length > 0) {
            this._frameChunks.push(annexb);
            this._frameBytes += annexb.length;
            this._frameTimestamp = timestamp;
            if (this._pushHadIdr) this._frameKeyframe = true;
        } else if (this._frameTimestamp === null) {
            // Nothing complete yet (e.g. the first fragments of a FU-A), but the
            // frame has begun: remember its timestamp for the boundary check.
            this._frameTimestamp = timestamp;
        }
        if (
            this._fuOverflow
            || this._frameBytes + this._fuBytes > this._maxAccessUnitBytes
            || this._frameChunks.length > this._maxFragments
        ) {
            this._discardFrame(timestamp, marker);
            return frames;
        }
        if (marker) this._emitFrame(frames);
        return frames;
    }

    _emitFrame(frames) {
        if (this._frameChunks.length > 0) {
            frames.push({
                data: this._frameChunks.length === 1 ? this._frameChunks[0] : Buffer.concat(this._frameChunks),
                timestamp: this._frameTimestamp,
                keyframe: this._frameKeyframe,
                intact: this._frameIntact,
            });
            this._frameIntact = true;
        }
        // A frame that vanished entirely leaves the flag set, so the frame that
        // follows (which depends on it) is reported as damaged instead.
        this._frameChunks = [];
        this._frameBytes = 0;
        this._frameTimestamp = null;
        this._frameKeyframe = false;
    }

    // Drop the frame being assembled because it outgrew a limit. Like a frame
    // lost entirely, it leaves the damaged flag set for the frame that follows,
    // and its remaining packets are skipped unless this one already ended it.
    _discardFrame(timestamp, marker) {
        this._dropFu();
        this._frameChunks = [];
        this._frameBytes = 0;
        this._frameTimestamp = null;
        this._frameKeyframe = false;
        this._frameIntact = false;
        this._skipTimestamp = marker ? null : timestamp;
    }

    _dropFu() {
        this._fuBuffer = null;
        this._fuBytes = 0;
        this._fuExpectedSequence = null;
        this._fuTimestamp = null;
        this._fuSsrc = null;
        this._fuType = null;
    }

    _handleFuA(payload, { sequence, timestamp, ssrc, marker }) {
        if (payload.length < 2) return null;
        const fuIndicator = payload[0];
        const fuHeader = payload[1];
        const start = (fuHeader & 0x80) !== 0;
        const end = (fuHeader & 0x40) !== 0;
        const origType = fuHeader & 0x1f;
        const fragment = payload.subarray(2);

        if (start) {
            this._dropFu();
            if (end || marker) return null;
            this._fuNalHeader = (fuIndicator & 0xe0) | origType;
            this._fuBuffer = [Buffer.from([this._fuNalHeader]), Buffer.from(fragment)];
            this._fuBytes = 1 + fragment.length;
            this._fuTimestamp = timestamp;
            this._fuSsrc = ssrc;
            this._fuType = origType;
            this._fuExpectedSequence = (sequence + 1) & 0xffff;
        } else if (
            this._fuBuffer
            && sequence === this._fuExpectedSequence
            && timestamp === this._fuTimestamp
            && ssrc === this._fuSsrc
            && origType === this._fuType
            && (!marker || end)
        ) {
            this._fuBuffer.push(Buffer.from(fragment));
            this._fuBytes += fragment.length;
            this._fuExpectedSequence = (sequence + 1) & 0xffff;
        } else {
            this._dropFu();
            return null;
        }

        // A NAL that never ends must not grow for ever. Dropping the buffer also
        // drops the fragments still to come, which then match nothing.
        if (this._fuBytes > this._maxNalBytes || this._fuBuffer.length - 1 > this._maxFragments) {
            this._dropFu();
            this._fuOverflow = true;
            return null;
        }

        if (end && this._fuBuffer) {
            const nal = Buffer.concat(this._fuBuffer);
            this._dropFu();
            return nal;
        }
        return null;
    }
}

module.exports = { H264Depacketizer };
