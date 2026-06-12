// lib/h264Sprop.js - Extract H.264 SPS/PPS from RTP packets to build sprop-parameter-sets.
//
// OBS WHIP does not always repeat parameter sets in-band, which leaves the FFmpeg
// fallback relay unable to determine video dimensions ("unspecified size") and
// blocks the MP4 init segment. Capturing SPS (NAL type 7) and PPS (NAL type 8)
// from the producer's RTP and handing them to FFmpeg via the SDP's
// sprop-parameter-sets attribute fixes that.
'use strict';

const NAL_TYPE_SPS = 7;
const NAL_TYPE_PPS = 8;
const NAL_TYPE_STAP_A = 24;
const NAL_TYPE_FU_A = 28;

/**
 * Compute the byte offset of the RTP payload (past the fixed header, CSRCs and
 * any header extension). Returns -1 if the buffer is too short to be valid RTP.
 */
function rtpPayloadOffset(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return -1;
    const csrcCount = buf[0] & 0x0f;
    const hasExtension = (buf[0] & 0x10) !== 0;
    let offset = 12 + csrcCount * 4;
    if (hasExtension) {
        if (buf.length < offset + 4) return -1;
        const extWords = buf.readUInt16BE(offset + 2);
        offset += 4 + extWords * 4;
    }
    return offset <= buf.length ? offset : -1;
}

/**
 * Extract H.264 NAL units relevant to parameter-set capture from a single RTP
 * payload. Handles single NAL unit packets (types 1-23) and STAP-A aggregation
 * (type 24). Fragmented units (FU-A/FU-B) are ignored — SPS/PPS are small and
 * are not fragmented in practice.
 * @returns {Buffer[]} NAL units including their 1-byte NAL header.
 */
function extractNalUnits(payload) {
    if (!Buffer.isBuffer(payload) || payload.length < 1) return [];
    const headerType = payload[0] & 0x1f;
    const nals = [];

    if (headerType >= 1 && headerType <= 23) {
        nals.push(Buffer.from(payload));
        return nals;
    }

    if (headerType === NAL_TYPE_STAP_A) {
        let i = 1; // skip STAP-A header byte
        while (i + 2 <= payload.length) {
            const size = payload.readUInt16BE(i);
            i += 2;
            if (size === 0 || i + size > payload.length) break;
            nals.push(Buffer.from(payload.subarray(i, i + size)));
            i += size;
        }
    }

    // FU-A (type 28): fragmented NAL. Only the START fragment carries the original
    // NAL header (reconstructed from the FU header). Parameter sets are rarely
    // fragmented, but handle the start fragment so we at least see the NAL type.
    if (headerType === NAL_TYPE_FU_A && payload.length >= 2) {
        const fuHeader = payload[1];
        const startBit = (fuHeader & 0x80) !== 0;
        const origType = fuHeader & 0x1f;
        if (startBit) {
            const nalHeader = (payload[0] & 0xe0) | origType;
            nals.push(Buffer.concat([Buffer.from([nalHeader]), payload.subarray(2)]));
        }
    }

    return nals;
}

/** Extract NAL units directly from a full RTP packet buffer. */
function extractNalUnitsFromRtp(packet) {
    const offset = rtpPayloadOffset(packet);
    if (offset < 0 || offset >= packet.length) return [];
    let end = packet.length;
    // Strip RTP padding (P bit set): the last byte is the padding length and the
    // trailing pad bytes are not part of the NAL — including them corrupts the SPS.
    if ((packet[0] & 0x20) !== 0 && end > offset) {
        const pad = packet[end - 1];
        if (pad > 0 && end - pad >= offset) end -= pad;
    }
    return extractNalUnits(packet.subarray(offset, end));
}

/**
 * Fold NAL units into an accumulator capturing the first SPS and PPS seen.
 * @param {Buffer[]} nals
 * @param {{sps: Buffer|null, pps: Buffer|null}} acc
 * @returns {{sps: Buffer|null, pps: Buffer|null}}
 */
function collectParameterSets(nals, acc = { sps: null, pps: null }) {
    let { sps, pps } = acc;
    for (const nal of nals) {
        if (!nal || nal.length < 1) continue;
        const type = nal[0] & 0x1f;
        if (type === NAL_TYPE_SPS && !sps) sps = Buffer.from(nal);
        else if (type === NAL_TYPE_PPS && !pps) pps = Buffer.from(nal);
    }
    return { sps, pps };
}

/** Build the SDP sprop-parameter-sets value ("base64(SPS),base64(PPS)"). */
function buildSpropParameterSets(sps, pps) {
    if (!sps || !pps) return null;
    return `${Buffer.from(sps).toString('base64')},${Buffer.from(pps).toString('base64')}`;
}

/**
 * Read the H.264 profile-level-id (profile_idc + constraints + level_idc, hex)
 * from the avcC box of an fMP4 init segment. Used to build an accurate MSE MIME
 * type for the transcoded relay output (its profile/level differ from OBS's).
 */
function profileLevelIdFromInitSegment(initSegment) {
    if (!Buffer.isBuffer(initSegment)) return null;
    const idx = initSegment.indexOf(Buffer.from('avcC'));
    if (idx < 0) return null;
    // After the 'avcC' type: configurationVersion, AVCProfileIndication,
    // profile_compatibility, AVCLevelIndication.
    const profile = initSegment[idx + 5];
    const compat = initSegment[idx + 6];
    const level = initSegment[idx + 7];
    if (profile === undefined || compat === undefined || level === undefined) return null;
    return Buffer.from([profile, compat, level]).toString('hex');
}

module.exports = {
    rtpPayloadOffset,
    extractNalUnits,
    extractNalUnitsFromRtp,
    collectParameterSets,
    buildSpropParameterSets,
    profileLevelIdFromInitSegment,
};
