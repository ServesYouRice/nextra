const test = require('node:test');
const assert = require('node:assert/strict');

const { H264Depacketizer } = require('../lib/h264Depacketizer');

const START = Buffer.from([0x00, 0x00, 0x00, 0x01]);

// Build a minimal 12-byte RTP header (no padding/extension/CSRC) with a marker bit option.
function rtp(payload, { marker = false } = {}) {
    const head = Buffer.alloc(12);
    head[0] = 0x80;
    head[1] = (marker ? 0x80 : 0) | 102;
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

    assert.equal(d.push(rtp(start)).length, 0);
    assert.equal(d.push(rtp(mid)).length, 0);
    const out = d.push(rtp(end));
    assert.deepEqual(out.subarray(0, 4), START);
    assert.deepEqual(out.subarray(4), Buffer.concat([Buffer.from([0x61]), body]));
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
