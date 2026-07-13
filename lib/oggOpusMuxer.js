'use strict';

const crypto = require('crypto');
const { rtpPayloadOffset } = require('./h264Sprop');

const OGG_CRC_POLYNOMIAL = 0x04c11db7;

function oggCrc(buffer) {
    let crc = 0;
    for (const byte of buffer) {
        crc ^= byte << 24;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc & 0x80000000) !== 0
                ? ((crc << 1) ^ OGG_CRC_POLYNOMIAL) >>> 0
                : (crc << 1) >>> 0;
        }
    }
    return crc >>> 0;
}

function opusPacketDurationSamples(packet) {
    if (!Buffer.isBuffer(packet) || packet.length < 1) return 0;
    const config = packet[0] >> 3;
    let frameSamples;
    if (config < 12) frameSamples = [480, 960, 1920, 2880][config & 3];
    else if (config < 16) frameSamples = [480, 960][config & 1];
    else frameSamples = [120, 240, 480, 960][config & 3];

    const frameCode = packet[0] & 3;
    let frameCount = 1;
    if (frameCode === 1 || frameCode === 2) frameCount = 2;
    else if (frameCode === 3) {
        if (packet.length < 2) return 0;
        frameCount = packet[1] & 0x3f;
    }

    const duration = frameSamples * frameCount;
    return duration > 0 && duration <= 5760 ? duration : 0;
}

function extractOpusRtp(packet) {
    const offset = rtpPayloadOffset(packet);
    if (offset < 0 || offset >= packet.length) return null;
    let end = packet.length;
    if ((packet[0] & 0x20) !== 0) {
        const padding = packet[end - 1];
        if (padding < 1 || end - padding < offset) return null;
        end -= padding;
    }
    if (end <= offset) return null;
    return {
        payload: packet.subarray(offset, end),
        timestamp: packet.readUInt32BE(4),
        ssrc: packet.readUInt32BE(8),
    };
}

class OggOpusMuxer {
    constructor({ channels = 2, sampleRate = 48000, serial } = {}) {
        this.channels = channels;
        this.sampleRate = sampleRate;
        this.serial = serial === undefined ? crypto.randomBytes(4).readUInt32LE(0) : serial >>> 0;
        this.sequence = 0;
        this.granule = 0n;
        this.baseTimestamp = null;
        this.baseGranule = 0n;
        this.ssrc = null;
    }

    _page(packet, { headerType = 0, granule = 0n } = {}) {
        const segments = [];
        let remaining = packet.length;
        while (remaining >= 255) {
            segments.push(255);
            remaining -= 255;
        }
        segments.push(remaining);
        if (segments.length > 255) throw new Error('Opus packet is too large for one Ogg page.');

        const header = Buffer.alloc(27 + segments.length);
        header.write('OggS', 0, 'ascii');
        header[4] = 0;
        header[5] = headerType;
        header.writeBigUInt64LE(BigInt.asUintN(64, granule), 6);
        header.writeUInt32LE(this.serial, 14);
        header.writeUInt32LE(this.sequence++, 18);
        header.writeUInt32LE(0, 22);
        header[26] = segments.length;
        Buffer.from(segments).copy(header, 27);

        const page = Buffer.concat([header, packet]);
        page.writeUInt32LE(oggCrc(page), 22);
        return page;
    }

    headers() {
        const opusHead = Buffer.alloc(19);
        opusHead.write('OpusHead', 0, 'ascii');
        opusHead[8] = 1;
        opusHead[9] = this.channels;
        opusHead.writeUInt16LE(0, 10);
        opusHead.writeUInt32LE(this.sampleRate, 12);
        opusHead.writeInt16LE(0, 16);
        opusHead[18] = 0;

        const vendor = Buffer.from('Nextra', 'utf8');
        const opusTags = Buffer.alloc(8 + 4 + vendor.length + 4);
        opusTags.write('OpusTags', 0, 'ascii');
        opusTags.writeUInt32LE(vendor.length, 8);
        vendor.copy(opusTags, 12);
        opusTags.writeUInt32LE(0, 12 + vendor.length);

        return Buffer.concat([
            this._page(opusHead, { headerType: 2 }),
            this._page(opusTags),
        ]);
    }

    pushRtp(packet) {
        const parsed = extractOpusRtp(packet);
        if (!parsed) return null;
        const duration = opusPacketDurationSamples(parsed.payload);
        if (!duration) return null;

        if (this.baseTimestamp === null || this.ssrc !== parsed.ssrc) {
            this.baseTimestamp = parsed.timestamp;
            this.baseGranule = this.granule;
            this.ssrc = parsed.ssrc;
        }
        const timestampDelta = (parsed.timestamp - this.baseTimestamp) >>> 0;
        if (timestampDelta > 0x7fffffff) return null;
        const nextGranule = this.baseGranule + BigInt(timestampDelta + duration);
        if (nextGranule <= this.granule) return null;
        this.granule = nextGranule;
        return this._page(parsed.payload, { granule: this.granule });
    }
}

module.exports = {
    OggOpusMuxer,
    extractOpusRtp,
    oggCrc,
    opusPacketDurationSamples,
};
