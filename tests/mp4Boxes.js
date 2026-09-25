'use strict';

// Minimal fragmented-MP4 box builders for relay tests: an init segment with an
// audio (track 1) and video (track 2) trak, and moof+mdat fragments whose video
// sample flags can be set at each level of the ISO BMFF precedence chain.
const NON_SYNC = 0x10000;

function box(type, ...payloads) {
    const body = Buffer.concat(payloads.map((payload) => (Buffer.isBuffer(payload) ? payload : Buffer.from(payload))));
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + body.length, 0);
    header.write(type, 4, 'ascii');
    return Buffer.concat([header, body]);
}

function fullBox(type, flags, ...fields) {
    const versionFlags = Buffer.alloc(4);
    versionFlags.writeUInt32BE(flags & 0xffffff, 0);
    return box(type, versionFlags, ...fields);
}

function u32(...values) {
    const out = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => out.writeUInt32BE(value >>> 0, index * 4));
    return out;
}

function trak(trackId, handler) {
    const tkhd = fullBox('tkhd', 0, u32(0, 0, trackId), Buffer.alloc(68));
    const hdlr = fullBox('hdlr', 0, u32(0), Buffer.from(handler, 'ascii'), Buffer.alloc(13));
    return box('trak', tkhd, box('mdia', hdlr));
}

function initSegment({ videoDefaultFlags = NON_SYNC } = {}) {
    const trex = (trackId, flags) => fullBox('trex', 0, u32(trackId, 1, 0, 0, flags));
    return Buffer.concat([
        box('ftyp', Buffer.from('isom\0\0\0\0', 'binary')),
        box('moov', trak(1, 'soun'), trak(2, 'vide'), box('mvex', trex(1, 0), trex(2, videoDefaultFlags))),
    ]);
}

function fragment(trafs, mdatBytes = 4) {
    return Buffer.concat([box('moof', fullBox('mfhd', 0, u32(1)), ...trafs), box('mdat', Buffer.alloc(mdatBytes))]);
}

function traf(trackId, { tfhdDefaultFlags, firstSampleFlags, perSampleFlags } = {}) {
    const tfhdFields = [u32(trackId)];
    let tfhdFlags = 0;
    if (tfhdDefaultFlags !== undefined) {
        tfhdFlags |= 0x20;
        tfhdFields.push(u32(tfhdDefaultFlags));
    }
    let trunFlags = 0x1;
    const trunFields = [u32(1, 0)];
    if (firstSampleFlags !== undefined) {
        trunFlags |= 0x4;
        trunFields.push(u32(firstSampleFlags));
    }
    if (perSampleFlags !== undefined) {
        trunFlags |= 0x100 | 0x200 | 0x400;
        trunFields.push(u32(33, 100, perSampleFlags));
    }
    return box('traf', fullBox('tfhd', tfhdFlags, ...tfhdFields), fullBox('trun', trunFlags, ...trunFields));
}

module.exports = { NON_SYNC, box, fragment, fullBox, initSegment, traf, trak, u32 };
