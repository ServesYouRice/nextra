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

test('normal size 0 retains extends-to-EOF error and recovers', () => {
    const parser = new FMP4Parser();
    const errors = [];
    const fragments = [];
    parser.on('error', (err) => errors.push(err));
    parser.on('fragment', (frag) => fragments.push(frag));

    const initSegment = Buffer.concat([
        box('ftyp', Buffer.alloc(4)),
        box('moov', trak(1, 'vide')),
    ]);
    parser.push(initSegment);

    const size0Box = Buffer.alloc(8);
    size0Box.writeUInt32BE(0, 0);
    size0Box.write('styp', 4, 4, 'ascii');

    parser.push(size0Box);

    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /extends to EOF/);

    parser.push(Buffer.concat([moofForTrack(1), box('mdat', Buffer.from([0x01]))]));
    assert.equal(fragments.length, 1);
    assert.equal(fragments[0].hasVideo, true);
});
test('table-test normal declared sizes 2 through 7 reject and recover', () => {
    for (let size = 2; size <= 7; size++) {
        const parser = new FMP4Parser();
        const errors = [];
        const fragments = [];
        parser.on('error', (err) => errors.push(err));
        parser.on('fragment', (frag) => fragments.push(frag));

        const initSegment = Buffer.concat([
            box('ftyp', Buffer.alloc(4)),
            box('moov', trak(1, 'vide')),
        ]);
        parser.push(initSegment);

        const badBox = Buffer.alloc(8);
        badBox.writeUInt32BE(size, 0);
        badBox.write('styp', 4, 4, 'ascii');

        parser.push(badBox);

        assert.equal(errors.length, 1, `Expected error for size ${size}`);
        assert.match(errors[0].message, new RegExp(String(size)));
        assert.match(errors[0].message, /8/);

        parser.push(Buffer.concat([moofForTrack(1), box('mdat', Buffer.from([0x01]))]));
        assert.equal(fragments.length, 1, `Expected recovery for size ${size}`);
        assert.equal(fragments[0].hasVideo, true);
    }
});

test('extended declared sizes 0 and 15 are rejected with actual values and recover', () => {
    for (const extendedSize of [0, 15]) {
        const parser = new FMP4Parser();
        const errors = [];
        const fragments = [];
        parser.on('error', (err) => errors.push(err));
        parser.on('fragment', (frag) => fragments.push(frag));

        const initSegment = Buffer.concat([
            box('ftyp', Buffer.alloc(4)),
            box('moov', trak(1, 'vide')),
        ]);
        parser.push(initSegment);

        const badExtendedBox = Buffer.alloc(16);
        badExtendedBox.writeUInt32BE(1, 0);
        badExtendedBox.write('styp', 4, 4, 'ascii');
        badExtendedBox.writeUInt32BE(0, 8);
        badExtendedBox.writeUInt32BE(extendedSize, 12);

        parser.push(badExtendedBox);

        assert.equal(errors.length, 1, `Expected error for extended size ${extendedSize}`);
        assert.match(errors[0].message, new RegExp(String(extendedSize)));
        assert.match(errors[0].message, /16/);

        parser.push(Buffer.concat([moofForTrack(1), box('mdat', Buffer.from([0x01]))]));
        assert.equal(fragments.length, 1, `Expected recovery for extended size ${extendedSize}`);
        assert.equal(fragments[0].hasVideo, true);
    }
});

test('extended size of exactly 16 is accepted as the lower valid boundary', () => {
    const parser = new FMP4Parser();
    const errors = [];
    const fragments = [];
    parser.on('error', (err) => errors.push(err));
    parser.on('fragment', (frag) => fragments.push(frag));

    const initSegment = Buffer.concat([
        box('ftyp', Buffer.alloc(4)),
        box('moov', trak(1, 'vide')),
    ]);
    parser.push(initSegment);

    const validExtendedStyp = Buffer.alloc(16);
    validExtendedStyp.writeUInt32BE(1, 0);
    validExtendedStyp.write('styp', 4, 4, 'ascii');
    validExtendedStyp.writeUInt32BE(0, 8);
    validExtendedStyp.writeUInt32BE(16, 12);

    parser.push(validExtendedStyp);
    assert.equal(errors.length, 0);

    parser.push(Buffer.concat([moofForTrack(1), box('mdat', Buffer.from([0x01]))]));
    assert.equal(errors.length, 0);
    assert.equal(fragments.length, 1);
    assert.equal(fragments[0].hasVideo, true);
});
test('normal and extended sizes above MAX_BOX_SIZE retain oversize errors and recover', () => {
    const MAX_BOX_SIZE = 128 * 1024 * 1024;

    // Normal oversize
    {
        const parser = new FMP4Parser();
        const errors = [];
        const fragments = [];
        parser.on('error', (err) => errors.push(err));
        parser.on('fragment', (frag) => fragments.push(frag));

        const initSegment = Buffer.concat([
            box('ftyp', Buffer.alloc(4)),
            box('moov', trak(1, 'vide')),
        ]);
        parser.push(initSegment);

        const oversizeNormal = Buffer.alloc(8);
        oversizeNormal.writeUInt32BE(MAX_BOX_SIZE + 1, 0);
        oversizeNormal.write('styp', 4, 4, 'ascii');

        parser.push(oversizeNormal);
        assert.equal(errors.length, 1);
        assert.match(errors[0].message, /exceeds limit/);

        parser.push(Buffer.concat([moofForTrack(1), box('mdat', Buffer.from([0x01]))]));
        assert.equal(fragments.length, 1);
    }

    // Extended oversize
    {
        const parser = new FMP4Parser();
        const errors = [];
        const fragments = [];
        parser.on('error', (err) => errors.push(err));
        parser.on('fragment', (frag) => fragments.push(frag));

        const initSegment = Buffer.concat([
            box('ftyp', Buffer.alloc(4)),
            box('moov', trak(1, 'vide')),
        ]);
        parser.push(initSegment);

        const oversizeExtended = Buffer.alloc(16);
        oversizeExtended.writeUInt32BE(1, 0);
        oversizeExtended.write('styp', 4, 4, 'ascii');
        oversizeExtended.writeUInt32BE(0, 8);
        oversizeExtended.writeUInt32BE(MAX_BOX_SIZE + 1, 12);

        parser.push(oversizeExtended);
        assert.equal(errors.length, 1);
        assert.match(errors[0].message, /exceeds limit/);

        parser.push(Buffer.concat([moofForTrack(1), box('mdat', Buffer.from([0x01]))]));
        assert.equal(fragments.length, 1);
    }
});

test('second moof before mdat emits incomplete fragment error and recovers', () => {
    const parser = new FMP4Parser();
    const errors = [];
    const fragments = [];
    parser.on('error', (err) => errors.push(err));
    parser.on('fragment', (frag) => fragments.push(frag));

    const initSegment = Buffer.concat([
        box('ftyp', Buffer.alloc(4)),
        box('moov', trak(1, 'vide')),
    ]);
    parser.push(initSegment);

    parser.push(moofForTrack(1));
    parser.push(moofForTrack(1));

    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /dropping incomplete fragment/);

    parser.push(box('mdat', Buffer.from([0x01])));
    assert.equal(fragments.length, 1);
    assert.equal(fragments[0].hasVideo, true);
});
test('mdat without moof emits missing-moof error and recovers on next fragment', () => {
    const parser = new FMP4Parser();
    const errors = [];
    const fragments = [];
    parser.on('error', (err) => errors.push(err));
    parser.on('fragment', (frag) => fragments.push(frag));

    const initSegment = Buffer.concat([
        box('ftyp', Buffer.alloc(4)),
        box('moov', trak(1, 'vide')),
    ]);
    parser.push(initSegment);

    parser.push(box('mdat', Buffer.from([0x01])));

    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /mdat received without preceding moof/);
    assert.equal(fragments.length, 0);

    parser.push(Buffer.concat([moofForTrack(1), box('mdat', Buffer.from([0x02]))]));
    assert.equal(fragments.length, 1);
    assert.equal(fragments[0].hasVideo, true);
});
