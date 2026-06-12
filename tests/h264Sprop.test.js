const test = require('node:test');
const assert = require('node:assert/strict');

const {
    rtpPayloadOffset,
    extractNalUnits,
    extractNalUnitsFromRtp,
    collectParameterSets,
    buildSpropParameterSets,
} = require('../lib/h264Sprop');

// Minimal 12-byte RTP header (V=2, no padding/extension/CSRC).
function rtpHeader({ csrc = 0, ext = false } = {}) {
    const first = 0x80 | (ext ? 0x10 : 0) | (csrc & 0x0f);
    const head = Buffer.alloc(12 + csrc * 4);
    head[0] = first;
    head[1] = 96; // payload type
    return head;
}

test('rtpPayloadOffset accounts for CSRCs and extension headers', () => {
    assert.equal(rtpPayloadOffset(rtpHeader()), 12);
    assert.equal(rtpPayloadOffset(rtpHeader({ csrc: 2 })), 20);

    // Extension: 4-byte ext header declaring 1 word (4 bytes) of extension data.
    const withExt = Buffer.concat([rtpHeader({ ext: true }), Buffer.from([0xbe, 0xde, 0x00, 0x01, 1, 2, 3, 4])]);
    assert.equal(rtpPayloadOffset(withExt), 12 + 4 + 4);

    assert.equal(rtpPayloadOffset(Buffer.alloc(4)), -1);
});

test('extractNalUnits returns a single NAL unit packet', () => {
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x1f]); // NAL type 7
    const nals = extractNalUnits(sps);
    assert.equal(nals.length, 1);
    assert.deepEqual(nals[0], sps);
});

test('extractNalUnits splits a STAP-A aggregation packet', () => {
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x1f]);
    const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
    const stapA = Buffer.concat([
        Buffer.from([0x78]), // STAP-A header (type 24)
        Buffer.from([0x00, sps.length]), sps,
        Buffer.from([0x00, pps.length]), pps,
    ]);
    const nals = extractNalUnits(stapA);
    assert.equal(nals.length, 2);
    assert.deepEqual(nals[0], sps);
    assert.deepEqual(nals[1], pps);
});

test('collectParameterSets + buildSpropParameterSets produce the SDP value', () => {
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x1f]);
    const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);

    const packet = Buffer.concat([
        rtpHeader(),
        Buffer.from([0x78]),
        Buffer.from([0x00, sps.length]), sps,
        Buffer.from([0x00, pps.length]), pps,
    ]);

    const acc = collectParameterSets(extractNalUnitsFromRtp(packet));
    assert.ok(acc.sps && acc.pps);

    const sprop = buildSpropParameterSets(acc.sps, acc.pps);
    assert.equal(sprop, `${sps.toString('base64')},${pps.toString('base64')}`);
});

test('buildSpropParameterSets requires both SPS and PPS', () => {
    assert.equal(buildSpropParameterSets(Buffer.from([0x67]), null), null);
    assert.equal(buildSpropParameterSets(null, Buffer.from([0x68])), null);
});
