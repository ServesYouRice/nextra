const test = require('node:test');
const assert = require('node:assert/strict');

const {
    OggOpusMuxer,
    extractOpusRtp,
    oggCrc,
    opusPacketDurationSamples,
} = require('../lib/oggOpusMuxer');

function rtp(payload, { timestamp = 1000, sequence = 1, ssrc = 7, extension = null, padding = 0 } = {}) {
    const extensionBytes = extension ? 4 + extension.length : 0;
    const packet = Buffer.alloc(12 + extensionBytes + payload.length + padding);
    packet[0] = 0x80 | (extension ? 0x10 : 0) | (padding ? 0x20 : 0);
    packet[1] = 111;
    packet.writeUInt16BE(sequence, 2);
    packet.writeUInt32BE(timestamp, 4);
    packet.writeUInt32BE(ssrc, 8);
    let offset = 12;
    if (extension) {
        packet.writeUInt16BE(0xbede, offset);
        packet.writeUInt16BE(extension.length / 4, offset + 2);
        extension.copy(packet, offset + 4);
        offset += extensionBytes;
    }
    payload.copy(packet, offset);
    if (padding) packet[packet.length - 1] = padding;
    return packet;
}

function pageBody(page) {
    const segmentCount = page[26];
    const bodyLength = page.subarray(27, 27 + segmentCount).reduce((sum, value) => sum + value, 0);
    return page.subarray(27 + segmentCount, 27 + segmentCount + bodyLength);
}

test('Ogg Opus headers are valid BOS and comment pages', () => {
    const muxer = new OggOpusMuxer({ serial: 123 });
    const headers = muxer.headers();
    const firstLength = 27 + headers[26] + headers[27];
    const headPage = headers.subarray(0, firstLength);
    const tagsPage = headers.subarray(firstLength);

    assert.equal(headPage.subarray(0, 4).toString(), 'OggS');
    assert.equal(headPage[5], 2);
    assert.equal(pageBody(headPage).subarray(0, 8).toString(), 'OpusHead');
    assert.equal(pageBody(tagsPage).subarray(0, 8).toString(), 'OpusTags');
    assert.equal(headPage.readUInt32LE(14), 123);
    assert.equal(tagsPage.readUInt32LE(18), 1);
});

test('Ogg page checksum covers the page with a zeroed checksum field', () => {
    const page = new OggOpusMuxer({ serial: 42 }).pushRtp(rtp(Buffer.from([0x98, 1, 2])));
    const expected = page.readUInt32LE(22);
    const copy = Buffer.from(page);
    copy.writeUInt32LE(0, 22);
    assert.equal(oggCrc(copy), expected);
});

test('Opus RTP timestamps become monotonic Ogg granule positions', () => {
    const muxer = new OggOpusMuxer({ serial: 1 });
    muxer.headers();
    const first = muxer.pushRtp(rtp(Buffer.from([0x98, 1]), { timestamp: 10_000 }));
    const second = muxer.pushRtp(rtp(Buffer.from([0x98, 2]), { timestamp: 10_960, sequence: 2 }));

    assert.equal(first.readBigUInt64LE(6), 960n);
    assert.equal(second.readBigUInt64LE(6), 1920n);
    assert.deepEqual(pageBody(second), Buffer.from([0x98, 2]));
});

test('Opus RTP extraction handles extensions and padding', () => {
    const payload = Buffer.from([0x98, 0xaa, 0xbb]);
    const parsed = extractOpusRtp(rtp(payload, {
        extension: Buffer.from([1, 2, 3, 4]),
        padding: 4,
    }));

    assert.deepEqual(parsed.payload, payload);
    assert.equal(opusPacketDurationSamples(parsed.payload), 960);
});

test('opusPacketDurationSamples supports frame-code 3 multi-frame packets', () => {
    // config 0 (480 samples), frame code 3, 3 frames -> 1440 samples
    const validPacket = Buffer.from([0x03, 0x03]);
    assert.equal(opusPacketDurationSamples(validPacket), 1440);

    // config 0 (480 samples), frame code 3, 20 frames -> 9600 samples (> 5760 ceiling) -> 0
    const overCeilingPacket = Buffer.from([0x03, 0x14]);
    assert.equal(opusPacketDurationSamples(overCeilingPacket), 0);

    // Truncation guard: frame code 3 with 1-byte packet -> 0
    const truncatedPacket = Buffer.from([0x03]);
    assert.equal(opusPacketDurationSamples(truncatedPacket), 0);
});

test('OggOpusMuxer multi-segment lacing handles 600-byte payload', () => {
    const muxer = new OggOpusMuxer({ serial: 99 });
    muxer.headers();

    const payload = Buffer.alloc(600);
    payload[0] = 0x98; // valid 960-sample Opus frame

    const page = muxer.pushRtp(rtp(payload, { timestamp: 1000 }));
    assert.ok(page);
    assert.equal(page.subarray(0, 4).toString('ascii'), 'OggS');

    const segmentCount = page[26];
    const lacing = Array.from(page.subarray(27, 27 + segmentCount));

    const totalLacing = lacing.reduce((sum, v) => sum + v, 0);
    assert.equal(totalLacing, 600);
    assert.equal(lacing.length, 3);
    assert.deepEqual(lacing, [255, 255, 90]);
    assert.ok(lacing.slice(0, -1).every((v) => v === 255));
});

test('OggOpusMuxer table-tests exact lacing boundaries', () => {
    const cases = [
        { length: 254, expectedLacing: [254] },
        { length: 255, expectedLacing: [255, 0] },
        { length: 256, expectedLacing: [255, 1] },
        { length: 510, expectedLacing: [255, 255, 0] },
    ];

    for (const { length, expectedLacing } of cases) {
        const muxer = new OggOpusMuxer({ serial: 100 + length });
        muxer.headers();

        const payload = Buffer.alloc(length);
        payload[0] = 0x98;

        const page = muxer.pushRtp(rtp(payload, { timestamp: 1000 }));
        assert.ok(page, `Expected page for payload length ${length}`);

        const segmentCount = page[26];
        const lacing = Array.from(page.subarray(27, 27 + segmentCount));
        assert.deepEqual(lacing, expectedLacing, `Lacing mismatch for length ${length}`);
    }
});

test('OggOpusMuxer rejects 65025-byte payload exceeding one Ogg page segment limit', () => {
    const muxer = new OggOpusMuxer({ serial: 200 });
    muxer.headers();

    const payload = Buffer.alloc(65025);
    payload[0] = 0x98;

    assert.throws(
        () => muxer.pushRtp(rtp(payload, { timestamp: 1000 })),
        /Opus packet is too large for one Ogg page\./
    );
});

const OPUS_20_MS = Buffer.from([0x98, 1]); // 960 samples at 48 kHz

function granuleOf(page) {
    return page.readBigUInt64LE(6);
}

function pushAt(muxer, timestamp, options = {}) {
    return muxer.pushRtp(rtp(OPUS_20_MS, { timestamp: timestamp >>> 0, ...options }));
}

test('Ogg granules keep following the RTP clock past 2^31 samples', () => {
    const muxer = new OggOpusMuxer({ serial: 1 });
    muxer.headers();
    const start = 5000;
    const step = 0x40000000; // 2^30 samples between packets, about 6.2 hours of 48 kHz audio

    const granules = [];
    for (let index = 0; index < 6; index += 1) {
        const page = pushAt(muxer, start + index * step, { sequence: index });
        assert.ok(page, 'packet ' + index + ' at ' + (index * step) + ' samples after the first was dropped');
        granules.push(granuleOf(page));
    }

    assert.deepEqual(granules, [0, 1, 2, 3, 4, 5].map((index) => BigInt(index * step + 960)));
    for (let index = 1; index < granules.length; index += 1) {
        assert.ok(granules[index] > granules[index - 1], 'granule positions must strictly increase');
    }
});

test('Ogg granules stay correct when the 32-bit RTP timestamp wraps', () => {
    // Small steps across the 0xffffffff -> 0 wrap.
    const small = new OggOpusMuxer({ serial: 2 });
    small.headers();
    const first = 0xfffffc40;
    for (let index = 0; index < 8; index += 1) {
        const page = pushAt(small, first + index * 960, { sequence: index });
        assert.ok(page, 'packet ' + index + ' around the wrap was dropped');
        assert.equal(granuleOf(page), BigInt((index + 1) * 960));
    }

    // Large steps: the total distance from the first packet passes 2^32, so a
    // delta kept from the first packet would read as a small number again.
    const large = new OggOpusMuxer({ serial: 3 });
    large.headers();
    const step = 0x30000000;
    for (let index = 0; index < 8; index += 1) {
        const page = pushAt(large, 0xf0000000 + index * step, { sequence: index });
        assert.ok(page, 'packet ' + index + ' after the 2^32 total was dropped');
        assert.equal(granuleOf(page), BigInt(index * step + 960));
    }
});

test('Ogg muxer still drops late and duplicate packets after the 2^31 horizon', () => {
    const muxer = new OggOpusMuxer({ serial: 4 });
    muxer.headers();
    const step = 0x40000000;
    let last;
    for (let index = 0; index < 4; index += 1) {
        last = pushAt(muxer, 100 + index * step, { sequence: index });
        assert.ok(last);
    }
    const lastTimestamp = 100 + 3 * step;
    const lastGranule = granuleOf(last);
    assert.equal(lastGranule, BigInt(3 * step + 960));

    assert.equal(pushAt(muxer, lastTimestamp, { sequence: 10 }), null, 'duplicate packet');
    assert.equal(pushAt(muxer, lastTimestamp - 960, { sequence: 11 }), null, 'late packet');
    assert.equal(pushAt(muxer, lastTimestamp - step, { sequence: 12 }), null, 'packet far in the past');
    assert.equal(muxer.granule, lastGranule);

    // Dropped packets must not move the anchor: the next in-order packet is
    // still measured from the last accepted one.
    const next = pushAt(muxer, lastTimestamp + 1920, { sequence: 13 });
    assert.equal(granuleOf(next), lastGranule + 1920n);
});

test('Ogg muxer measures the 2^31 limit from the last accepted packet', () => {
    const muxer = new OggOpusMuxer({ serial: 5 });
    muxer.headers();
    assert.ok(pushAt(muxer, 1000));

    // 0x80000000 samples ahead reads as behind and is dropped without re-anchoring.
    assert.equal(pushAt(muxer, 1000 + 0x80000000), null);
    assert.equal(muxer.baseTimestamp, 1000);

    const page = pushAt(muxer, 1000 + 0x7fffffff);
    assert.ok(page, '0x7fffffff samples ahead is the largest delta that is accepted');
    assert.equal(granuleOf(page), BigInt(0x7fffffff + 960));

    // The accepted packet is the new anchor, so one more big step is fine too.
    const after = pushAt(muxer, 1000 + 0x7fffffff + 0x7fffffff);
    assert.ok(after);
    assert.equal(granuleOf(after), BigInt(2 * 0x7fffffff + 960));
});

test('Ogg muxer re-anchors to the current granule on an SSRC change', () => {
    const muxer = new OggOpusMuxer({ serial: 6 });
    muxer.headers();
    const step = 0x40000000;
    for (let index = 0; index < 3; index += 1) {
        assert.ok(pushAt(muxer, 777 + index * step, { ssrc: 7, sequence: index }));
    }
    assert.equal(muxer.granule, BigInt(2 * step + 960));

    // A new source with an unrelated timestamp continues from the current granule.
    const switched = pushAt(muxer, 3_000_000_000, { ssrc: 8, sequence: 1 });
    assert.equal(granuleOf(switched), BigInt(2 * step + 1920));
    const following = pushAt(muxer, 3_000_000_000 + 960, { ssrc: 8, sequence: 2 });
    assert.equal(granuleOf(following), BigInt(2 * step + 2880));

    // The new source can also run past 2^31 samples.
    const far = pushAt(muxer, 3_000_000_000 + 960 + step, { ssrc: 8, sequence: 3 });
    assert.equal(granuleOf(far), BigInt(2 * step + 2880 + step));

    // A packet of the old source arriving late is a new source again; it continues
    // from the current granule instead of jumping back.
    const old = pushAt(muxer, 777, { ssrc: 7, sequence: 99 });
    assert.equal(granuleOf(old), BigInt(3 * step + 2880 + 960));
});

test('Ogg muxer starts from a preset granule and keeps counting from it', () => {
    // FFmpegRelay.setAudioStartSec sets muxer.granule while baseTimestamp is still null.
    const muxer = new OggOpusMuxer({ serial: 7 });
    muxer.headers();
    muxer.granule = 72000n;
    assert.equal(muxer.baseTimestamp, null);

    const first = pushAt(muxer, 0xffffff00);
    assert.equal(granuleOf(first), 72960n);
    const step = 0x40000000;
    for (let index = 1; index <= 4; index += 1) {
        const page = pushAt(muxer, 0xffffff00 + index * step, { sequence: index });
        assert.ok(page, 'packet ' + index + ' after the preset granule was dropped');
        assert.equal(granuleOf(page), BigInt(72000 + index * step + 960));
    }
});

test('Ogg muxer keeps its anchor unset until a packet is accepted', () => {
    const muxer = new OggOpusMuxer({ serial: 8 });
    muxer.headers();
    muxer.granule = 48000n;

    assert.equal(muxer.pushRtp(Buffer.alloc(8)), null, 'too short for RTP');
    assert.equal(muxer.pushRtp(rtp(Buffer.from([0x03]))), null, 'Opus packet with no duration');
    assert.equal(muxer.baseTimestamp, null);

    const oversized = Buffer.alloc(65025);
    oversized[0] = 0x98;
    assert.throws(() => muxer.pushRtp(rtp(oversized, { timestamp: 4000 })), /too large/);
    assert.equal(muxer.baseTimestamp, null, 'a packet that could not be written is not an anchor');
    assert.equal(muxer.granule, 48000n);

    const page = pushAt(muxer, 9000);
    assert.equal(granuleOf(page), 48960n);
    assert.equal(muxer.baseTimestamp, 9000);
});
