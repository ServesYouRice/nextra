const test = require('node:test');
const assert = require('node:assert/strict');

const { RtpReorderBuffer } = require('../lib/rtpReorder');

function packet(sequence) {
    const buffer = Buffer.alloc(12);
    buffer[0] = 0x80;
    buffer.writeUInt16BE(sequence & 0xffff, 2);
    return buffer;
}

const sequences = (packets) => packets.map((p) => p.readUInt16BE(2));

test('packets in order pass straight through', () => {
    const reorder = new RtpReorderBuffer();
    assert.deepEqual(sequences(reorder.push(packet(10))), [10]);
    assert.deepEqual(sequences(reorder.push(packet(11))), [11]);
    assert.equal(reorder.lostPackets, 0);
});

test('a retransmitted packet is put back where it belongs', () => {
    const reorder = new RtpReorderBuffer();
    reorder.push(packet(1));
    // 2 was dropped on the way; 3 and 4 are held until its retransmission.
    assert.deepEqual(reorder.push(packet(3)), []);
    assert.deepEqual(reorder.push(packet(4)), []);
    assert.deepEqual(sequences(reorder.push(packet(2))), [2, 3, 4]);
    assert.equal(reorder.lostPackets, 0);
    assert.equal(reorder.recoveredPackets, 1);
    assert.deepEqual(sequences(reorder.push(packet(5))), [5]);
});

test('a packet that never comes is given up on after a short wait', () => {
    let now = 1000;
    const reorder = new RtpReorderBuffer({ maxWaitMs: 120, now: () => now });
    reorder.push(packet(1));
    assert.deepEqual(reorder.push(packet(3)), []);
    now += 100;
    assert.deepEqual(reorder.push(packet(4)), []);
    now += 50;
    // The wait is over: the stream carries on with a hole where 2 was.
    assert.deepEqual(sequences(reorder.push(packet(5))), [3, 4, 5]);
    assert.equal(reorder.lostPackets, 1);
    // The late original is no use any more.
    assert.deepEqual(reorder.push(packet(2)), []);
});

test('a burst of loss does not hold packets without bound', () => {
    const reorder = new RtpReorderBuffer({ maxHeld: 4, maxWaitMs: 60_000, now: () => 0 });
    reorder.push(packet(1));
    const out = [];
    for (let sequence = 3; sequence <= 8; sequence++) out.push(...reorder.push(packet(sequence)));
    assert.deepEqual(sequences(out), [3, 4, 5, 6, 7, 8]);
});

test('sequence numbers wrap', () => {
    const reorder = new RtpReorderBuffer();
    reorder.push(packet(65534));
    assert.deepEqual(reorder.push(packet(0)), []);
    assert.deepEqual(sequences(reorder.push(packet(65535))), [65535, 0]);
    assert.deepEqual(sequences(reorder.push(packet(1))), [1]);
});

test('a sender that restarts its numbering is picked up again', () => {
    const reorder = new RtpReorderBuffer();
    reorder.push(packet(30000));
    let delivered = 0;
    for (let sequence = 100; sequence < 400; sequence++) delivered += reorder.push(packet(sequence)).length;
    // The first couple of hundred look like stragglers; after that they flow.
    assert.ok(delivered >= 100 && delivered < 300, `delivered ${delivered}`);
    assert.deepEqual(sequences(reorder.push(packet(400))), [400]);
});

test('anything that is not an RTP packet is ignored', () => {
    const reorder = new RtpReorderBuffer();
    assert.deepEqual(reorder.push(Buffer.alloc(4)), []);
    assert.deepEqual(reorder.push(null), []);
});

test('held packets are released by poll() once the wait is over, without another packet', () => {
    let now = 1000;
    const reorder = new RtpReorderBuffer({ maxWaitMs: 120, now: () => now });
    reorder.push(packet(1));
    assert.deepEqual(reorder.push(packet(3)), []);
    assert.deepEqual(reorder.push(packet(4)), []);
    // The burst ended and nothing else is coming.
    now += 121;
    assert.deepEqual(sequences(reorder.poll()), [3, 4]);
    assert.equal(reorder.lostPackets, 1);
    assert.equal(reorder.recoveredPackets, 0);
    // Nothing is left to release, and the late original is no use any more.
    assert.deepEqual(reorder.poll(), []);
    assert.deepEqual(reorder.push(packet(2)), []);
    assert.deepEqual(sequences(reorder.push(packet(5))), [5]);
    assert.equal(reorder.lostPackets, 1);
});

test('poll() before the wait is over returns nothing and keeps the packets for the missing one', () => {
    let now = 1000;
    const reorder = new RtpReorderBuffer({ maxWaitMs: 120, now: () => now });
    reorder.push(packet(1));
    reorder.push(packet(3));
    reorder.push(packet(4));
    now += 50;
    assert.deepEqual(reorder.poll(), []);
    // Exactly maxWaitMs is not yet over: push() gives up only after more than that.
    now += 70;
    assert.deepEqual(reorder.poll(), []);
    assert.equal(reorder.lostPackets, 0);
    // The held packets are still there for a retransmission.
    assert.deepEqual(sequences(reorder.push(packet(2))), [2, 3, 4]);
    assert.equal(reorder.lostPackets, 0);
    assert.equal(reorder.recoveredPackets, 1);
});

test('poll() with nothing held returns nothing, however long it has been', () => {
    let now = 1000;
    const reorder = new RtpReorderBuffer({ maxWaitMs: 120, now: () => now });
    assert.deepEqual(reorder.poll(), []);
    reorder.push(packet(1));
    reorder.push(packet(2));
    now += 10_000;
    assert.deepEqual(reorder.poll(), []);
    assert.equal(reorder.lostPackets, 0);
});

test('poll() releases every held run in order, across a second gap, and counts each gap once', () => {
    let now = 1000;
    const reorder = new RtpReorderBuffer({ maxWaitMs: 120, now: () => now });
    reorder.push(packet(65533));
    // 65534 and 65535 and 1 and 2 are missing; the wrap sits between the runs.
    for (const sequence of [65535, 0, 3, 4]) assert.deepEqual(reorder.push(packet(sequence)), []);
    now += 121;
    // The first gap is given up on; the run after it is delivered.
    assert.deepEqual(sequences(reorder.poll()), [65535, 0]);
    assert.equal(reorder.lostPackets, 1);
    // The second gap starts its own wait.
    assert.deepEqual(reorder.poll(), []);
    now += 121;
    assert.deepEqual(sequences(reorder.poll()), [3, 4]);
    assert.equal(reorder.lostPackets, 3);
    assert.deepEqual(reorder.poll(), []);
    // Nothing already delivered or given up on comes out again.
    assert.deepEqual(reorder.push(packet(0)), []);
    assert.deepEqual(reorder.push(packet(4)), []);
    assert.deepEqual(sequences(reorder.push(packet(5))), [5]);
});

test('poll() leaves in-order delivery and the counters as push() has them', () => {
    let now = 1000;
    const reorder = new RtpReorderBuffer({ maxWaitMs: 120, now: () => now });
    const out = [];
    for (let sequence = 10; sequence < 20; sequence++) {
        out.push(...reorder.push(packet(sequence)));
        now += 40;
        out.push(...reorder.poll());
    }
    assert.deepEqual(sequences(out), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    assert.equal(reorder.lostPackets, 0);
    assert.equal(reorder.recoveredPackets, 0);
});
