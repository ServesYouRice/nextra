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
