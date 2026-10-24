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

// FU-A start fragment (type 28) carrying the first bytes of a NAL of `origType`.
function fuAStart(origType, body, { nri = 0x60 } = {}) {
    return Buffer.concat([
        Buffer.from([nri | 28, 0x80 | origType]),
        Buffer.from(body),
    ]);
}

const SPS = Buffer.from([0x67, 0x42, 0xe0, 0x1f, 0x8c, 0x8d, 0x40]);
const PPS = Buffer.from([0x68, 0xce, 0x3c, 0x80]);

test('extractNalUnits still reports a FU-A start fragment with its original NAL type', () => {
    // Callers use the reported type for diagnostics and keyframe detection.
    const idrStart = extractNalUnits(fuAStart(5, [0x88, 0x84, 0x00]));
    assert.equal(idrStart.length, 1);
    assert.equal(idrStart[0][0] & 0x1f, 5);
    assert.deepEqual(idrStart[0], Buffer.from([0x65, 0x88, 0x84, 0x00]));

    const spsStart = extractNalUnits(fuAStart(7, SPS.subarray(1, 4)));
    assert.equal(spsStart.length, 1);
    assert.equal(spsStart[0][0] & 0x1f, 7);
});

test('extractNalUnits ignores FU-A continuation and end fragments', () => {
    const middle = Buffer.from([0x7c, 0x07, 0x01, 0x02]);
    const end = Buffer.from([0x7c, 0x47, 0x03]);
    assert.deepEqual(extractNalUnits(middle), []);
    assert.deepEqual(extractNalUnits(end), []);
});

test('collectParameterSets does not cache a FU-A start fragment of an SPS or PPS', () => {
    const spsStart = extractNalUnits(fuAStart(7, SPS.subarray(1, 4)));
    const ppsStart = extractNalUnits(fuAStart(8, PPS.subarray(1, 3)));
    assert.deepEqual(collectParameterSets(spsStart), { sps: null, pps: null });
    assert.deepEqual(collectParameterSets(ppsStart), { sps: null, pps: null });
    assert.deepEqual(collectParameterSets([...spsStart, ...ppsStart]), { sps: null, pps: null });

    // The same through the RTP entry point used by the WHIP capture.
    const packet = Buffer.concat([rtpHeader(), fuAStart(7, SPS.subarray(1, 4))]);
    const acc = collectParameterSets(extractNalUnitsFromRtp(packet));
    assert.equal(acc.sps, null);
    assert.equal(acc.pps, null);
    assert.equal(buildSpropParameterSets(acc.sps, acc.pps), null);
});

test('a complete SPS/PPS after a FU-A start fragment replaces nothing and is captured', () => {
    // Same-call order: fragment first, then the complete units.
    const sameCall = collectParameterSets([
        ...extractNalUnits(fuAStart(7, SPS.subarray(1, 4))),
        ...extractNalUnits(fuAStart(8, PPS.subarray(1, 3))),
        Buffer.from(SPS),
        Buffer.from(PPS),
    ]);
    assert.deepEqual(sameCall.sps, SPS);
    assert.deepEqual(sameCall.pps, PPS);

    // Packet by packet, threading the accumulator the way lib/whipRoutes.js does:
    // fragment start, then a single-NAL SPS, then a STAP-A that carries the PPS.
    let acc = { sps: null, pps: null };
    acc = collectParameterSets(
        extractNalUnitsFromRtp(Buffer.concat([rtpHeader(), fuAStart(7, SPS.subarray(1, 4))])),
        acc,
    );
    assert.equal(acc.sps, null);
    acc = collectParameterSets(extractNalUnitsFromRtp(Buffer.concat([rtpHeader(), fuAStart(8, PPS.subarray(1, 3))])), acc);
    assert.equal(acc.pps, null);

    acc = collectParameterSets(extractNalUnitsFromRtp(Buffer.concat([rtpHeader(), SPS])), acc);
    assert.deepEqual(acc.sps, SPS);
    assert.equal(acc.pps, null);

    const stapA = Buffer.concat([
        Buffer.from([0x78]),
        Buffer.from([0x00, PPS.length]), PPS,
    ]);
    acc = collectParameterSets(extractNalUnitsFromRtp(Buffer.concat([rtpHeader(), stapA])), acc);
    assert.deepEqual(acc.sps, SPS);
    assert.deepEqual(acc.pps, PPS);
    assert.equal(
        buildSpropParameterSets(acc.sps, acc.pps),
        `${SPS.toString('base64')},${PPS.toString('base64')}`,
    );
});

test('collectParameterSets keeps the first complete SPS/PPS and ignores later fragments', () => {
    const first = collectParameterSets([Buffer.from(SPS), Buffer.from(PPS)]);
    const later = collectParameterSets(
        [
            ...extractNalUnits(fuAStart(7, [0x99, 0x98])),
            ...extractNalUnits(fuAStart(8, [0x97])),
        ],
        first,
    );
    assert.deepEqual(later.sps, SPS);
    assert.deepEqual(later.pps, PPS);
});
