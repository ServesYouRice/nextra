const test = require('node:test');
const assert = require('node:assert/strict');

const { H264Depacketizer } = require('../lib/h264Depacketizer');

const START = Buffer.from([0x00, 0x00, 0x00, 0x01]);

// Build a minimal 12-byte RTP header (no padding/extension/CSRC) with a marker bit option.
function rtp(payload, { marker = false, sequence = 0, timestamp = 0, ssrc = 1 } = {}) {
    const head = Buffer.alloc(12);
    head[0] = 0x80;
    head[1] = (marker ? 0x80 : 0) | 102;
    head.writeUInt16BE(sequence, 2);
    head.writeUInt32BE(timestamp, 4);
    head.writeUInt32BE(ssrc, 8);
    return Buffer.concat([head, payload]);
}

function nalTypes(buf) {
    // Split an Annex-B buffer on 4-byte start codes and return NAL types.
    const types = [];
    for (let i = 0; i + 4 < buf.length; i++) {
        if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
            types.push(buf[i + 4] & 0x1f);
            i += 3;
        }
    }
    return types;
}

test('single-NAL packets are emitted as Annex-B', () => {
    const d = new H264Depacketizer();
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x1f]);
    const out = d.push(rtp(sps));
    assert.deepEqual(out.subarray(0, 4), START);
    assert.deepEqual(out.subarray(4), sps);
});

test('STAP-A is split into its constituent NAL units', () => {
    const d = new H264Depacketizer();
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x1f]);
    const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
    const stap = Buffer.concat([
        Buffer.from([0x78]),
        Buffer.from([0x00, sps.length]), sps,
        Buffer.from([0x00, pps.length]), pps,
    ]);
    const out = d.push(rtp(stap));
    assert.deepEqual(nalTypes(out), [7, 8]);
});

test('FU-A fragments are reassembled into one NAL', () => {
    const d = new H264Depacketizer();
    // Reassembled NAL should be type 1 (non-IDR slice), nri=3 -> header 0x61.
    const body = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
    // FU indicator: nri=3, type=28 -> 0x7c
    const start = Buffer.concat([Buffer.from([0x7c, 0x80 | 1]), body.subarray(0, 2)]); // S=1, type=1
    const mid = Buffer.concat([Buffer.from([0x7c, 0x00 | 1]), body.subarray(2, 4)]);
    const end = Buffer.concat([Buffer.from([0x7c, 0x40 | 1]), body.subarray(4)]); // E=1

    assert.equal(d.push(rtp(start, { sequence: 10, timestamp: 9000 })).length, 0);
    assert.equal(d.push(rtp(mid, { sequence: 11, timestamp: 9000 })).length, 0);
    const out = d.push(rtp(end, { sequence: 12, timestamp: 9000, marker: true }));
    assert.deepEqual(out.subarray(0, 4), START);
    assert.deepEqual(out.subarray(4), Buffer.concat([Buffer.from([0x61]), body]));
});

test('FU-A assembly is discarded when an RTP packet is lost', () => {
    const d = new H264Depacketizer();
    const start = Buffer.from([0x7c, 0x81, 0xaa]);
    const end = Buffer.from([0x7c, 0x41, 0xcc]);
    assert.equal(d.push(rtp(start, { sequence: 20, timestamp: 12000 })).length, 0);
    assert.equal(d.push(rtp(end, { sequence: 22, timestamp: 12000, marker: true })).length, 0);
});

test('FU-A assembly is discarded across timestamp or SSRC changes', () => {
    const d = new H264Depacketizer();
    const start = Buffer.from([0x7c, 0x81, 0xaa]);
    const end = Buffer.from([0x7c, 0x41, 0xcc]);
    assert.equal(d.push(rtp(start, { sequence: 30, timestamp: 15000, ssrc: 1 })).length, 0);
    assert.equal(d.push(rtp(end, { sequence: 31, timestamp: 18000, ssrc: 1, marker: true })).length, 0);
    assert.equal(d.push(rtp(start, { sequence: 40, timestamp: 21000, ssrc: 1 })).length, 0);
    assert.equal(d.push(rtp(end, { sequence: 41, timestamp: 21000, ssrc: 2, marker: true })).length, 0);
});

test('SPS/PPS are cached and injected before each IDR', () => {
    const d = new H264Depacketizer();
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x1f]);
    const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
    d.push(rtp(sps));
    d.push(rtp(pps));
    assert.equal(d.hasParameterSets, true);

    // An IDR slice (type 5) arrives without in-band parameter sets.
    const idr = Buffer.concat([Buffer.from([0x65]), Buffer.from([1, 2, 3, 4])]);
    const out = d.push(rtp(idr, { marker: true }));
    // Expect SPS, PPS, then the IDR — parameter sets injected ahead of the keyframe.
    assert.deepEqual(nalTypes(out), [7, 8, 5]);
});

test('non-IDR slices are not preceded by parameter sets', () => {
    const d = new H264Depacketizer();
    d.push(rtp(Buffer.from([0x67, 0x42, 0xe0, 0x1f])));
    d.push(rtp(Buffer.from([0x68, 0xce, 0x3c, 0x80])));
    const p = Buffer.concat([Buffer.from([0x61]), Buffer.from([9, 9, 9])]); // type 1
    const out = d.push(rtp(p));
    assert.deepEqual(nalTypes(out), [1]);
});

test('pushFrames returns whole frames, ended by the marker bit', () => {
    const d = new H264Depacketizer({ sps: Buffer.from([0x67, 1]), pps: Buffer.from([0x68, 2]) });
    const idr = Buffer.from([0x65, 0xaa]);
    const slice = Buffer.from([0x41, 0xbb]);

    // A two-slice keyframe: nothing is returned until its last packet.
    assert.deepEqual(d.pushFrames(rtp(idr, { sequence: 1, timestamp: 9000 })), []);
    const [keyframe] = d.pushFrames(rtp(idr, { sequence: 2, timestamp: 9000, marker: true }));
    assert.equal(keyframe.timestamp, 9000);
    assert.equal(keyframe.keyframe, true);
    assert.equal(keyframe.intact, true);
    // Parameter sets go in before each IDR slice.
    assert.deepEqual(nalTypes(keyframe.data), [7, 8, 5, 7, 8, 5]);

    const [delta] = d.pushFrames(rtp(slice, { sequence: 3, timestamp: 12000, marker: true }));
    assert.equal(delta.timestamp, 12000);
    assert.equal(delta.keyframe, false);
    assert.deepEqual(nalTypes(delta.data), [1]);
});

test('pushFrames ends a frame at the next timestamp when the marker never came', () => {
    const d = new H264Depacketizer();
    const slice = Buffer.from([0x41, 0xbb]);
    assert.deepEqual(d.pushFrames(rtp(slice, { sequence: 1, timestamp: 3000 })), []);
    const frames = d.pushFrames(rtp(slice, { sequence: 2, timestamp: 6000, marker: true }));
    assert.deepEqual(frames.map((frame) => frame.timestamp), [3000, 6000]);
});

test('pushFrames flags a frame that has packets missing', () => {
    const d = new H264Depacketizer();
    const slice = Buffer.from([0x41, 0xbb]);
    assert.equal(d.pushFrames(rtp(slice, { sequence: 1, timestamp: 3000, marker: true }))[0].intact, true);
    // Sequence 2 never arrives.
    assert.equal(d.pushFrames(rtp(slice, { sequence: 3, timestamp: 6000, marker: true }))[0].intact, false);
    assert.equal(d.pushFrames(rtp(slice, { sequence: 4, timestamp: 9000, marker: true }))[0].intact, true);
});

test('pushFrames carries the damage forward when a frame is lost entirely', () => {
    const d = new H264Depacketizer();
    const slice = Buffer.from([0x41, 0xbb]);
    d.pushFrames(rtp(slice, { sequence: 1, timestamp: 3000, marker: true }));
    // The start of a fragmented frame goes missing, so none of it can be used...
    const middle = Buffer.from([0x7c, 0x01, 0xcc]);
    const end = Buffer.from([0x7c, 0x41, 0xdd]);
    assert.deepEqual(d.pushFrames(rtp(middle, { sequence: 3, timestamp: 6000 })), []);
    assert.deepEqual(d.pushFrames(rtp(end, { sequence: 4, timestamp: 6000, marker: true })), []);
    // ...and the frame after it, which depends on it, is the one reported.
    assert.equal(d.pushFrames(rtp(slice, { sequence: 5, timestamp: 9000, marker: true }))[0].intact, false);
});

// --- Frame-integrity attribution when packets go missing (VAL-003, VAL-004) ---

const SLICE = Buffer.from([0x41, 0xbb]);

test('VAL-003: a lost marker packet flags the damaged frame, not its successor', () => {
    const d = new H264Depacketizer();
    // Frame A is a two-packet frame whose second (marker) packet, sequence 2, never arrives.
    assert.deepEqual(d.pushFrames(rtp(SLICE, { sequence: 1, timestamp: 3000 })), []);
    // The first packet of frame B ends frame A by its new timestamp.
    const atTransition = d.pushFrames(rtp(SLICE, { sequence: 3, timestamp: 6000, marker: true }));
    assert.deepEqual(atTransition.map((frame) => [frame.timestamp, frame.intact]), [[3000, false], [6000, true]]);
    // Nothing after it is affected.
    assert.equal(d.pushFrames(rtp(SLICE, { sequence: 4, timestamp: 9000, marker: true }))[0].intact, true);
});

test('VAL-004 (a): one packet missing where a frame never saw its marker damages only that frame', () => {
    const d = new H264Depacketizer();
    d.pushFrames(rtp(SLICE, { sequence: 1, timestamp: 3000, marker: true }));
    assert.deepEqual(d.pushFrames(rtp(SLICE, { sequence: 2, timestamp: 6000 })), []);
    // Sequence 3, the marker packet of the 6000 frame, is lost; the next frame starts at 4.
    assert.deepEqual(d.pushFrames(rtp(SLICE, { sequence: 4, timestamp: 9000 })).map((frame) => [frame.timestamp, frame.intact]), [[6000, false]]);
    const [last] = d.pushFrames(rtp(SLICE, { sequence: 5, timestamp: 9000, marker: true }));
    assert.equal(last.timestamp, 9000);
    assert.equal(last.intact, true);
});

test('VAL-004 (b): more than one packet missing where a frame never saw its marker damages both frames', () => {
    const d = new H264Depacketizer();
    d.pushFrames(rtp(SLICE, { sequence: 1, timestamp: 3000, marker: true }));
    assert.deepEqual(d.pushFrames(rtp(SLICE, { sequence: 2, timestamp: 6000 })), []);
    // Sequence 3 and 4 are lost: the tail of frame 6000 and, possibly, the head of frame 9000.
    const frames = d.pushFrames(rtp(SLICE, { sequence: 5, timestamp: 9000, marker: true }));
    assert.deepEqual(frames.map((frame) => [frame.timestamp, frame.intact]), [[6000, false], [9000, false]]);
    // The damage does not outlive the frame it belongs to.
    assert.equal(d.pushFrames(rtp(SLICE, { sequence: 6, timestamp: 12000, marker: true }))[0].intact, true);
});

test('VAL-004 (c): packets missing after a frame that closed on its marker damage the next frame', () => {
    const d = new H264Depacketizer();
    const [closed] = d.pushFrames(rtp(SLICE, { sequence: 1, timestamp: 3000, marker: true }));
    assert.equal(closed.intact, true);
    // Sequence 2 is lost, and frame 3000 had already ended on its marker.
    const [next] = d.pushFrames(rtp(SLICE, { sequence: 3, timestamp: 6000, marker: true }));
    assert.equal(next.timestamp, 6000);
    assert.equal(next.intact, false);
    assert.equal(d.pushFrames(rtp(SLICE, { sequence: 4, timestamp: 9000, marker: true }))[0].intact, true);
});

test('VAL-004 (d): a gap inside a frame, with no timestamp change, damages that frame', () => {
    const d = new H264Depacketizer();
    d.pushFrames(rtp(SLICE, { sequence: 1, timestamp: 3000, marker: true }));
    assert.deepEqual(d.pushFrames(rtp(SLICE, { sequence: 2, timestamp: 6000 })), []);
    // Sequence 3 is lost in the middle of the 6000 frame, whose marker does arrive.
    const [damaged] = d.pushFrames(rtp(SLICE, { sequence: 4, timestamp: 6000, marker: true }));
    assert.equal(damaged.timestamp, 6000);
    assert.equal(damaged.intact, false);
    assert.equal(d.pushFrames(rtp(SLICE, { sequence: 5, timestamp: 9000, marker: true }))[0].intact, true);
});

test('pushFrames keeps a frame intact when its marker is missing but no packet is', () => {
    // Some senders never set the marker bit; the timestamp change alone ends the frame.
    const d = new H264Depacketizer();
    d.pushFrames(rtp(SLICE, { sequence: 1, timestamp: 3000 }));
    const frames = d.pushFrames(rtp(SLICE, { sequence: 2, timestamp: 6000 }));
    assert.deepEqual(frames.map((frame) => [frame.timestamp, frame.intact]), [[3000, true]]);
    const later = d.pushFrames(rtp(SLICE, { sequence: 3, timestamp: 9000 }));
    assert.deepEqual(later.map((frame) => [frame.timestamp, frame.intact]), [[6000, true]]);
});

test('pushFrames counts a sequence number wrap as contiguous and a gap across it as missing', () => {
    const d = new H264Depacketizer();
    d.pushFrames(rtp(SLICE, { sequence: 65534, timestamp: 3000 }));
    const wrapped = d.pushFrames(rtp(SLICE, { sequence: 65535, timestamp: 3000, marker: true }));
    assert.equal(wrapped[0].intact, true);
    // Sequence 0 is lost across the wrap.
    assert.equal(d.pushFrames(rtp(SLICE, { sequence: 1, timestamp: 6000, marker: true }))[0].intact, false);
});

test('a frame whose fragments vanish at a lost marker still marks the following frame', () => {
    const d = new H264Depacketizer();
    d.pushFrames(rtp(SLICE, { sequence: 1, timestamp: 3000, marker: true }));
    // Only the start of a fragmented frame arrives; its end and marker packet (sequence 3) are lost.
    assert.deepEqual(d.pushFrames(rtp(Buffer.from([0x7c, 0x81, 0xcc]), { sequence: 2, timestamp: 6000 })), []);
    assert.equal(d.pushFrames(rtp(SLICE, { sequence: 4, timestamp: 9000, marker: true }))[0].intact, false);
    assert.equal(d.pushFrames(rtp(SLICE, { sequence: 5, timestamp: 12000, marker: true }))[0].intact, true);
});

// --- Bounded reassembly memory (VAL-005) ---

// FU-A packet payloads: `size` bytes of body after the two FU bytes.
const fuStart = (size) => Buffer.concat([Buffer.from([0x7c, 0x81]), Buffer.alloc(size, 0xaa)]);
const fuMiddle = (size) => Buffer.concat([Buffer.from([0x7c, 0x01]), Buffer.alloc(size, 0xbb)]);
const fuEnd = (size) => Buffer.concat([Buffer.from([0x7c, 0x41]), Buffer.alloc(size, 0xcc)]);
// A complete single-NAL packet of `size` bytes (it becomes size + 4 bytes of Annex-B).
const nalOf = (size) => Buffer.concat([Buffer.from([0x41]), Buffer.alloc(size - 1, 0xdd)]);

test('VAL-005: a fragmented NAL over the byte limit is dropped instead of growing without end', () => {
    const d = new H264Depacketizer({ maxNalBytes: 50 });
    // NAL header + 20 + 20 = 41 bytes so far, then 61 > 50.
    assert.equal(d.push(rtp(fuStart(20), { sequence: 1, timestamp: 3000 })).length, 0);
    assert.equal(d.push(rtp(fuMiddle(20), { sequence: 2, timestamp: 3000 })).length, 0);
    assert.equal(d.push(rtp(fuMiddle(20), { sequence: 3, timestamp: 3000 })).length, 0);
    // The end of the NAL would have completed it; it was dropped, so nothing comes out.
    assert.equal(d.push(rtp(fuEnd(5), { sequence: 4, timestamp: 3000, marker: true })).length, 0);
    assert.equal(d._fuBuffer, null);
});

test('VAL-005: a fragmented NAL at exactly the byte limit is still reassembled', () => {
    const d = new H264Depacketizer({ maxNalBytes: 41 });
    d.push(rtp(fuStart(20), { sequence: 1, timestamp: 3000 }));
    d.push(rtp(fuMiddle(20), { sequence: 2, timestamp: 3000 }));
    const out = d.push(rtp(fuEnd(0), { sequence: 3, timestamp: 3000, marker: true }));
    assert.equal(out.length, 4 + 41);
});

test('VAL-005: a fragmented NAL over the fragment limit is dropped', () => {
    const d = new H264Depacketizer({ maxFragments: 3 });
    d.push(rtp(fuStart(1), { sequence: 1, timestamp: 3000 }));
    d.push(rtp(fuMiddle(1), { sequence: 2, timestamp: 3000 }));
    d.push(rtp(fuMiddle(1), { sequence: 3, timestamp: 3000 }));
    d.push(rtp(fuMiddle(1), { sequence: 4, timestamp: 3000 }));
    assert.equal(d.push(rtp(fuEnd(1), { sequence: 5, timestamp: 3000, marker: true })).length, 0);
    assert.equal(d._fuBuffer, null);
});

test('VAL-005: a frame whose NAL overflows is dropped, its packets are skipped, and the next frame is flagged', () => {
    const d = new H264Depacketizer({ maxNalBytes: 50 });
    d.pushFrames(rtp(SLICE, { sequence: 1, timestamp: 1500, marker: true }));
    const seen = [];
    seen.push(d.pushFrames(rtp(fuStart(20), { sequence: 2, timestamp: 3000 })));
    seen.push(d.pushFrames(rtp(fuMiddle(20), { sequence: 3, timestamp: 3000 })));
    seen.push(d.pushFrames(rtp(fuMiddle(20), { sequence: 4, timestamp: 3000 })));
    // Later packets of the same frame, even a whole small NAL, are skipped.
    seen.push(d.pushFrames(rtp(fuEnd(5), { sequence: 5, timestamp: 3000 })));
    seen.push(d.pushFrames(rtp(SLICE, { sequence: 6, timestamp: 3000, marker: true })));
    assert.deepEqual(seen, [[], [], [], [], []]);
    // The frame after it carries the damage, and the one after that is clean.
    const [next] = d.pushFrames(rtp(SLICE, { sequence: 7, timestamp: 6000, marker: true }));
    assert.equal(next.timestamp, 6000);
    assert.equal(next.intact, false);
    assert.equal(d.pushFrames(rtp(SLICE, { sequence: 8, timestamp: 9000, marker: true }))[0].intact, true);
});

test('VAL-005: an access unit over the byte limit is dropped even when no marker ever arrives', () => {
    const d = new H264Depacketizer({ maxAccessUnitBytes: 100 });
    // Each packet adds 4 + 20 bytes: four fit (96), the fifth does not (120).
    for (let sequence = 1; sequence <= 40; sequence++) {
        assert.deepEqual(d.pushFrames(rtp(nalOf(20), { sequence, timestamp: 3000 })), []);
        assert.ok(d._frameChunks.length <= 4, 'held chunks stay within the limit');
    }
    // The boundary to the next timestamp emits only the next frame, flagged as damaged.
    const frames = d.pushFrames(rtp(SLICE, { sequence: 41, timestamp: 6000, marker: true }));
    assert.deepEqual(frames.map((frame) => [frame.timestamp, frame.intact]), [[6000, false]]);
    assert.equal(d.pushFrames(rtp(SLICE, { sequence: 42, timestamp: 9000, marker: true }))[0].intact, true);
});

test('VAL-005: the marker of an oversized frame ends the skipping', () => {
    const d = new H264Depacketizer({ maxAccessUnitBytes: 100 });
    for (let sequence = 1; sequence <= 5; sequence++) {
        assert.deepEqual(d.pushFrames(rtp(nalOf(20), { sequence, timestamp: 3000 })), []);
    }
    assert.deepEqual(d.pushFrames(rtp(nalOf(20), { sequence: 6, timestamp: 3000, marker: true })), []);
    const [next] = d.pushFrames(rtp(SLICE, { sequence: 7, timestamp: 6000, marker: true }));
    assert.deepEqual([next.timestamp, next.intact], [6000, false]);
});

test('VAL-005: an access unit at exactly the byte limit is emitted whole', () => {
    const d = new H264Depacketizer({ maxAccessUnitBytes: 96 });
    for (let sequence = 1; sequence <= 3; sequence++) {
        assert.deepEqual(d.pushFrames(rtp(nalOf(20), { sequence, timestamp: 3000 })), []);
    }
    const [frame] = d.pushFrames(rtp(nalOf(20), { sequence: 4, timestamp: 3000, marker: true }));
    assert.equal(frame.data.length, 96);
    assert.equal(frame.intact, true);
});

test('VAL-005: an access unit over the packet limit is dropped', () => {
    const d = new H264Depacketizer({ maxFragments: 3 });
    for (let sequence = 1; sequence <= 20; sequence++) {
        assert.deepEqual(d.pushFrames(rtp(SLICE, { sequence, timestamp: 3000 })), []);
        assert.ok(d._frameChunks.length <= 3, 'held chunks stay within the limit');
    }
    const [next] = d.pushFrames(rtp(SLICE, { sequence: 21, timestamp: 6000, marker: true }));
    assert.deepEqual([next.timestamp, next.intact], [6000, false]);
});

test('VAL-005: a fragmented NAL in progress counts toward the access unit limit', () => {
    const d = new H264Depacketizer({ maxAccessUnitBytes: 100 });
    d.pushFrames(rtp(nalOf(20), { sequence: 1, timestamp: 3000 })); // 24 bytes held
    d.pushFrames(rtp(fuStart(30), { sequence: 2, timestamp: 3000 })); // + 31 in progress = 55
    d.pushFrames(rtp(fuMiddle(30), { sequence: 3, timestamp: 3000 })); // + 61 = 85
    assert.ok(d._fuBuffer, 'still within the limit');
    d.pushFrames(rtp(fuMiddle(30), { sequence: 4, timestamp: 3000 })); // 24 + 91 = 115 > 100
    assert.equal(d._fuBuffer, null);
    assert.equal(d._frameChunks.length, 0);
    assert.deepEqual(d.pushFrames(rtp(fuEnd(5), { sequence: 5, timestamp: 3000, marker: true })), []);
    const [next] = d.pushFrames(rtp(SLICE, { sequence: 6, timestamp: 6000, marker: true }));
    assert.deepEqual([next.timestamp, next.intact], [6000, false]);
});

test('VAL-005: invalid limit options fall back to the defaults', () => {
    const d = new H264Depacketizer({ maxNalBytes: 0, maxAccessUnitBytes: -1, maxFragments: 'many' });
    d.pushFrames(rtp(fuStart(1000), { sequence: 1, timestamp: 3000 }));
    d.pushFrames(rtp(fuMiddle(1000), { sequence: 2, timestamp: 3000 }));
    const [frame] = d.pushFrames(rtp(fuEnd(1000), { sequence: 3, timestamp: 3000, marker: true }));
    assert.equal(frame.data.length, 4 + 1 + 3000);
    assert.equal(frame.intact, true);
});
