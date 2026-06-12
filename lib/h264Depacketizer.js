// lib/h264Depacketizer.js - Stateful H.264 RTP depacketizer.
//
// Reassembles a WebRTC/mediasoup H.264 RTP stream into an Annex-B elementary
// stream and injects SPS/PPS before every IDR. This lets the fallback relay feed
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

class H264Depacketizer {
    /**
     * @param {object} [opts]
     * @param {Buffer} [opts.sps] - parameter set to seed (OBS sends SPS once at
     *   stream start; seeding lets the relay inject it before every keyframe even
     *   if the relay's own consumer never receives an in-band copy).
     * @param {Buffer} [opts.pps]
     * @param {function} [opts.onKeyframe] - called once per IDR NAL emitted; used
     *   to observe OBS's keyframe cadence (diagnostics).
     */
    constructor(opts = {}) {
        this._sps = opts.sps ? Buffer.from(opts.sps) : null;
        this._pps = opts.pps ? Buffer.from(opts.pps) : null;
        this._fuBuffer = null;   // accumulating FU-A payload
        this._fuNalHeader = 0;   // reconstructed NAL header for the current FU-A
        this._onKeyframe = typeof opts.onKeyframe === 'function' ? opts.onKeyframe : null;
    }

    get hasParameterSets() {
        return !!(this._sps && this._pps);
    }

    /**
     * Push one RTP packet (full packet buffer). Returns a Buffer of Annex-B data
     * to append to the FFmpeg input (may be empty).
     */
    push(rtpPacket) {
        const offset = rtpPayloadOffset(rtpPacket);
        if (offset < 0 || offset >= rtpPacket.length) return Buffer.alloc(0);

        let end = rtpPacket.length;
        if ((rtpPacket[0] & 0x20) !== 0 && end > offset) {
            const pad = rtpPacket[end - 1];
            if (pad > 0 && end - pad >= offset) end -= pad;
        }
        const payload = rtpPacket.subarray(offset, end);
        if (payload.length < 1) return Buffer.alloc(0);

        const type = payload[0] & 0x1f;
        const completeNals = [];

        if (type >= 1 && type <= 23) {
            completeNals.push(Buffer.from(payload));
        } else if (type === NAL_STAP_A) {
            let i = 1;
            while (i + 2 <= payload.length) {
                const size = payload.readUInt16BE(i);
                i += 2;
                if (size === 0 || i + size > payload.length) break;
                completeNals.push(Buffer.from(payload.subarray(i, i + size)));
                i += size;
            }
        } else if (type === NAL_FU_A) {
            const fu = this._handleFuA(payload);
            if (fu) completeNals.push(fu);
        }
        // Other types (FU-B/STAP-B/MTAP) are not produced by WebRTC; ignore.

        if (completeNals.length === 0) return Buffer.alloc(0);

        const chunks = [];
        for (const nal of completeNals) {
            if (!nal.length) continue;
            const nalType = nal[0] & 0x1f;
            if (nalType === NAL_SPS) this._sps = Buffer.from(nal);
            else if (nalType === NAL_PPS) this._pps = Buffer.from(nal);

            // Inject the cached parameter sets before each IDR so FFmpeg can
            // always decode the keyframe even when OBS omits them in-band.
            if (nalType === NAL_IDR && this._sps && this._pps) {
                chunks.push(ANNEXB_START, this._sps, ANNEXB_START, this._pps);
            }
            if (nalType === NAL_IDR && this._onKeyframe) this._onKeyframe();
            chunks.push(ANNEXB_START, nal);
        }
        return Buffer.concat(chunks);
    }

    _handleFuA(payload) {
        if (payload.length < 2) return null;
        const fuIndicator = payload[0];
        const fuHeader = payload[1];
        const start = (fuHeader & 0x80) !== 0;
        const end = (fuHeader & 0x40) !== 0;
        const origType = fuHeader & 0x1f;
        const fragment = payload.subarray(2);

        if (start) {
            this._fuNalHeader = (fuIndicator & 0xe0) | origType;
            this._fuBuffer = [Buffer.from([this._fuNalHeader]), Buffer.from(fragment)];
        } else if (this._fuBuffer) {
            this._fuBuffer.push(Buffer.from(fragment));
        } else {
            // Missed the start fragment; cannot reassemble.
            return null;
        }

        if (end && this._fuBuffer) {
            const nal = Buffer.concat(this._fuBuffer);
            this._fuBuffer = null;
            return nal;
        }
        return null;
    }
}

module.exports = { H264Depacketizer };
