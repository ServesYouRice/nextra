// lib/relayMp4.js - Browser-room MP4 relay: fragment framing, keyframe detection,
// and the per-viewer skip / host congestion policy.
//
// Chrome's MP4 MediaRecorder emits fragmented MP4 with one moof+mdat per video
// keyframe (plus shorter fragments when requestData() flushes). Re-framing the
// byte stream into whole fragments lets the server skip a lagging viewer ahead
// to the next keyframe instead of disconnecting it, and lets a late joiner start
// from the init segment plus the current GOP instead of the whole recording.
'use strict';

const { FMP4Parser } = require('./fmp4Parser');

const BOX = {
    moov: 0x6d6f6f76,
    trak: 0x7472616b,
    tkhd: 0x746b6864,
    mdia: 0x6d646961,
    hdlr: 0x68646c72,
    mvex: 0x6d766578,
    trex: 0x74726578,
    moof: 0x6d6f6f66,
    traf: 0x74726166,
    tfhd: 0x74666864,
    trun: 0x7472756e,
};

// ISO/IEC 14496-12 sample_is_non_sync_sample bit in sample flags.
const SAMPLE_IS_NON_SYNC = 0x10000;

// Skip policy, expressed in seconds of relay media queued for one viewer.
// Start skipping above SKIP_START; resume only on a keyframe fragment once the
// queue has drained below SKIP_RESUME (the gap is the hysteresis).
const SKIP_START_BACKLOG_SEC = 1.5;
const SKIP_RESUME_BACKLOG_SEC = 0.5;
// A viewer that cannot take even one GOP for this long is dropped from relay.
const SKIP_GIVE_UP_MS = 30_000;
// Every relay viewer skipping for this long means the host uplink (or the
// tunnel) cannot carry the recording; ask the host for a lower bitrate, at
// most once per interval.
const CONGESTION_HOLD_MS = 5_000;
const CONGESTION_SIGNAL_INTERVAL_MS = 20_000;

function forEachChildBox(buffer, start, end, visitor) {
    let offset = start;
    while (offset + 8 <= end) {
        let size = buffer.readUInt32BE(offset);
        const type = buffer.readUInt32BE(offset + 4);
        let headerSize = 8;
        if (size === 1) {
            if (offset + 16 > end) return;
            size = (buffer.readUInt32BE(offset + 8) * 0x100000000) + buffer.readUInt32BE(offset + 12);
            headerSize = 16;
        }
        if (size < headerSize || offset + size > end) return;
        visitor(type, offset + headerSize, offset + size, offset);
        offset += size;
    }
}

function readFullBoxFlags(buffer, boxStart) {
    return buffer.readUInt32BE(boxStart + 8) & 0xffffff;
}

/** Video track id and its trex default sample flags from an init segment. */
function readVideoTrackInfo(initSegment) {
    let videoTrackId = null;
    const trexFlags = new Map();

    forEachChildBox(initSegment, 0, initSegment.length, (type, start, end) => {
        if (type !== BOX.moov) return;
        forEachChildBox(initSegment, start, end, (moovType, moovStart, moovEnd) => {
            if (moovType === BOX.trak) {
                let trackId = null;
                let handler = null;
                forEachChildBox(initSegment, moovStart, moovEnd, (trakType, trakStart, trakEnd, trakBoxStart) => {
                    if (trakType === BOX.tkhd && trakEnd - trakBoxStart >= 24) {
                        const version = initSegment.readUInt8(trakBoxStart + 8);
                        const idOffset = trakBoxStart + (version === 1 ? 28 : 20);
                        if (idOffset + 4 <= trakEnd) trackId = initSegment.readUInt32BE(idOffset);
                    }
                    if (trakType !== BOX.mdia) return;
                    forEachChildBox(initSegment, trakStart, trakEnd, (mdiaType, _s, mdiaEnd, mdiaBoxStart) => {
                        if (mdiaType === BOX.hdlr && mdiaBoxStart + 20 <= mdiaEnd) {
                            handler = initSegment.toString('ascii', mdiaBoxStart + 16, mdiaBoxStart + 20);
                        }
                    });
                });
                if (handler === 'vide' && trackId && videoTrackId === null) videoTrackId = trackId;
                return;
            }
            if (moovType !== BOX.mvex) return;
            forEachChildBox(initSegment, moovStart, moovEnd, (mvexType, _s, mvexEnd, trexBoxStart) => {
                if (mvexType !== BOX.trex || trexBoxStart + 32 > mvexEnd) return;
                trexFlags.set(initSegment.readUInt32BE(trexBoxStart + 12), initSegment.readUInt32BE(trexBoxStart + 28));
            });
        });
    });

    if (videoTrackId === null) return null;
    return { videoTrackId, defaultSampleFlags: trexFlags.get(videoTrackId) ?? null };
}

/** True when the fragment's first video sample is a sync sample (keyframe). */
function fragmentStartsWithKeyframe(fragment, trackInfo) {
    if (!trackInfo) return false;
    let result = false;

    forEachChildBox(fragment, 0, fragment.length, (type, start, end) => {
        if (type !== BOX.moof || result) return;
        forEachChildBox(fragment, start, end, (moofType, trafStart, trafEnd) => {
            if (moofType !== BOX.traf || result) return;
            let isVideo = false;
            let tfhdFlags = null;
            let trunFlags = null;
            forEachChildBox(fragment, trafStart, trafEnd, (trafType, _s, boxEnd, boxStart) => {
                if (trafType === BOX.tfhd && boxStart + 16 <= boxEnd) {
                    if (fragment.readUInt32BE(boxStart + 12) !== trackInfo.videoTrackId) return;
                    isVideo = true;
                    const flags = readFullBoxFlags(fragment, boxStart);
                    let offset = boxStart + 16;
                    if (flags & 0x1) offset += 8; // base_data_offset
                    if (flags & 0x2) offset += 4; // sample_description_index
                    if (flags & 0x8) offset += 4; // default_sample_duration
                    if (flags & 0x10) offset += 4; // default_sample_size
                    if ((flags & 0x20) && offset + 4 <= boxEnd) tfhdFlags = fragment.readUInt32BE(offset);
                }
                if (trafType === BOX.trun && trunFlags === null && boxStart + 16 <= boxEnd) {
                    const flags = readFullBoxFlags(fragment, boxStart);
                    const sampleCount = fragment.readUInt32BE(boxStart + 12);
                    let offset = boxStart + 16;
                    if (flags & 0x1) offset += 4; // data_offset
                    if (flags & 0x4) {
                        if (offset + 4 <= boxEnd) trunFlags = fragment.readUInt32BE(offset);
                        return;
                    }
                    if (!(flags & 0x400) || sampleCount === 0) return;
                    if (flags & 0x100) offset += 4; // sample_duration
                    if (flags & 0x200) offset += 4; // sample_size
                    if (offset + 4 <= boxEnd) trunFlags = fragment.readUInt32BE(offset);
                }
            });
            if (!isVideo) return;
            const flags = trunFlags ?? tfhdFlags ?? trackInfo.defaultSampleFlags;
            result = flags !== null && (flags & SAMPLE_IS_NON_SYNC) === 0;
        });
    });

    return result;
}

/**
 * Re-frames one recorder generation's MP4 byte stream into its init segment and
 * whole fragments, each tagged with whether it starts on a video keyframe.
 */
function createMp4RelayStream({ onInit, onFragment, onError }) {
    const parser = new FMP4Parser();
    let trackInfo = null;
    parser.on('init', ({ initSegment }) => {
        trackInfo = readVideoTrackInfo(initSegment);
        onInit(initSegment);
    });
    parser.on('fragment', ({ data }) => {
        onFragment({ data, keyframe: fragmentStartsWithKeyframe(data, trackInfo) });
    });
    parser.on('error', (err) => onError?.(err));
    return {
        push(chunk) {
            parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        },
    };
}

/**
 * Per-viewer skip decision for one fragment. Mutates and returns `state`
 * ({ skipping, skippingSince }) and reports whether to send and whether the
 * viewer has been unable to keep up for too long.
 */
function decideFragmentDelivery(state, { backlogSec, keyframe, now }) {
    if (!state.skipping && backlogSec > SKIP_START_BACKLOG_SEC) {
        state.skipping = true;
        state.skippingSince = now;
    }
    if (state.skipping && keyframe && backlogSec < SKIP_RESUME_BACKLOG_SEC) {
        state.skipping = false;
        state.skippingSince = 0;
    }
    return {
        send: !state.skipping,
        giveUp: state.skipping && now - state.skippingSince >= SKIP_GIVE_UP_MS,
    };
}

/**
 * Host congestion decision. `congestion` ({ since, lastSignalAt }) is mutated.
 * Signals only while every relay viewer is skipping, so one slow viewer never
 * lowers the bitrate for the others.
 */
function decideHostCongestion(congestion, { viewerCount, skippingCount, now }) {
    if (viewerCount === 0 || skippingCount < viewerCount) {
        congestion.since = 0;
        return false;
    }
    if (!congestion.since) congestion.since = now;
    if (now - congestion.since < CONGESTION_HOLD_MS) return false;
    if (congestion.lastSignalAt && now - congestion.lastSignalAt < CONGESTION_SIGNAL_INTERVAL_MS) return false;
    congestion.lastSignalAt = now;
    return true;
}

module.exports = {
    createMp4RelayStream,
    decideFragmentDelivery,
    decideHostCongestion,
    fragmentStartsWithKeyframe,
    readVideoTrackInfo,
    SKIP_GIVE_UP_MS,
};
