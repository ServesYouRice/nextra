// lib/ivf.js - Minimal IVF framing for feeding timestamped H.264 to FFmpeg.
//
// A raw Annex-B stream carries no timestamps, so FFmpeg has to invent them from a
// frame rate. That drifts against the audio as soon as the source drops a frame or
// runs at a different rate than configured. IVF is the simplest container FFmpeg
// reads from a pipe that carries one timestamp per frame.
'use strict';

const IVF_HEADER_BYTES = 32;
const IVF_FRAME_HEADER_BYTES = 12;
// RTP video clock; frame timestamps are written in these units.
const IVF_TIMEBASE_HZ = 90000;

/** File header. Width and height are informational; FFmpeg reads them from the SPS. */
function ivfHeader({ fourcc = 'H264', width = 0, height = 0 } = {}) {
    const header = Buffer.alloc(IVF_HEADER_BYTES);
    header.write('DKIF', 0, 'ascii');
    header.writeUInt16LE(0, 4);
    header.writeUInt16LE(IVF_HEADER_BYTES, 6);
    header.write(fourcc, 8, 'ascii');
    header.writeUInt16LE(width & 0xffff, 12);
    header.writeUInt16LE(height & 0xffff, 14);
    header.writeUInt32LE(IVF_TIMEBASE_HZ, 16);
    header.writeUInt32LE(1, 20);
    return header;
}

/** One frame: 4-byte size, 8-byte timestamp (90 kHz ticks), then the access unit. */
function ivfFrame(data, timestamp) {
    const frame = Buffer.allocUnsafe(IVF_FRAME_HEADER_BYTES + data.length);
    frame.writeUInt32LE(data.length, 0);
    frame.writeBigUInt64LE(BigInt(Math.max(0, Math.round(timestamp))), 4);
    data.copy(frame, IVF_FRAME_HEADER_BYTES);
    return frame;
}

module.exports = { ivfHeader, ivfFrame, IVF_TIMEBASE_HZ };
