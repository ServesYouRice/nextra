const test = require('node:test');
const assert = require('node:assert/strict');

const { FMP4Parser } = require('../lib/fmp4Parser');

function box(type, payload = Buffer.alloc(0)) {
    const size = 8 + payload.length;
    const out = Buffer.alloc(size);
    out.writeUInt32BE(size, 0);
    out.write(type, 4, 4, 'ascii');
    payload.copy(out, 8);
    return out;
}

function fullBox(type, payload = Buffer.alloc(0), version = 0, flags = 0) {
    const header = Buffer.alloc(4);
    header.writeUInt8(version, 0);
    header.writeUIntBE(flags, 1, 3);
    return box(type, Buffer.concat([header, payload]));
}

function tkhd(trackId) {
    const payload = Buffer.alloc(16);
    payload.writeUInt32BE(trackId, 8);
    return fullBox('tkhd', payload);
}

function hdlr(handlerType) {
    const payload = Buffer.alloc(8);
    payload.write(handlerType, 4, 4, 'ascii');
    return fullBox('hdlr', payload);
}

function tfhd(trackId) {
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(trackId, 0);
    return fullBox('tfhd', payload);
}

function trak(trackId, handlerType) {
    return box('trak', Buffer.concat([
        tkhd(trackId),
        box('mdia', hdlr(handlerType)),
    ]));
}

function moofForTrack(trackId) {
    return box('moof', box('traf', tfhd(trackId)));
}

test('fMP4 parser marks fragments as video-bearing only for video tracks', () => {
    const parser = new FMP4Parser();
    const fragments = [];

    parser.on('fragment', (fragment) => fragments.push(fragment));

    const initSegment = Buffer.concat([
        box('ftyp', Buffer.alloc(4)),
        box('moov', Buffer.concat([
            trak(1, 'vide'),
            trak(2, 'soun'),
        ])),
    ]);

    parser.push(initSegment);
    parser.push(Buffer.concat([moofForTrack(2), box('mdat', Buffer.from([0x01]))]));
    parser.push(Buffer.concat([moofForTrack(1), box('mdat', Buffer.from([0x02]))]));

    assert.equal(fragments.length, 2);
    assert.equal(fragments[0].hasVideo, false);
    assert.equal(fragments[1].hasVideo, true);
});
