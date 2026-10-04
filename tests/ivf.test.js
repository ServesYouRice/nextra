const test = require('node:test');
const assert = require('node:assert/strict');

const { ivfHeader, ivfFrame, IVF_TIMEBASE_HZ } = require('../lib/ivf');

test('the IVF header declares H.264 on a 90 kHz clock', () => {
    const header = ivfHeader();
    assert.equal(header.length, 32);
    assert.equal(header.toString('ascii', 0, 4), 'DKIF');
    assert.equal(header.readUInt16LE(6), 32);
    assert.equal(header.toString('ascii', 8, 12), 'H264');
    assert.equal(header.readUInt32LE(16), IVF_TIMEBASE_HZ);
    assert.equal(header.readUInt32LE(20), 1);
});

test('an IVF frame carries its size and timestamp ahead of the data', () => {
    const data = Buffer.from([0, 0, 0, 1, 0x65, 0xaa]);
    const frame = ivfFrame(data, 3000);
    assert.equal(frame.readUInt32LE(0), data.length);
    assert.equal(frame.readBigUInt64LE(4), 3000n);
    assert.deepEqual(frame.subarray(12), data);
});

test('IVF timestamps go past 32 bits and never below zero', () => {
    // A day of stream at 90 kHz.
    assert.equal(ivfFrame(Buffer.alloc(1), 90000 * 86400).readBigUInt64LE(4), 7_776_000_000n);
    assert.equal(ivfFrame(Buffer.alloc(1), -5).readBigUInt64LE(4), 0n);
});
