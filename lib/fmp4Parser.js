// lib/fmp4Parser.js - Incremental fMP4 box parser for FFmpeg stdout
// Extracts init segment (ftyp+moov) and media fragments (moof+mdat) from a continuous byte stream.
'use strict';

const { EventEmitter } = require('events');

// MP4 box type constants (as 4-byte big-endian uint32)
const BOX_FTYP = 0x66747970; // 'ftyp'
const BOX_MOOV = 0x6d6f6f76; // 'moov'
const BOX_MOOF = 0x6d6f6f66; // 'moof'
const BOX_MDAT = 0x6d646174; // 'mdat'
const BOX_STYP = 0x73747970; // 'styp'
const BOX_TRAK = 0x7472616b; // 'trak'
const BOX_MDIA = 0x6d646961; // 'mdia'
const BOX_TRAF = 0x74726166; // 'traf'
const BOX_TKHD = 0x746b6864; // 'tkhd'
const BOX_HDLR = 0x68646c72; // 'hdlr'
const BOX_TFHD = 0x74666864; // 'tfhd'

class FMP4Parser extends EventEmitter {
    constructor() {
        super();
        this._buffer = Buffer.alloc(0);
        this._initSegment = null;
        this._initBoxes = [];
        this._pendingFragment = [];
        this._state = 'init'; // 'init' | 'streaming'
        this._sequence = 0;
        this._trackKinds = new Map();
    }

    /**
     * Feed data from FFmpeg stdout into the parser.
     * Emits 'init' when ftyp+moov is complete.
     * Emits 'fragment' for each complete moof+mdat pair.
     */
    push(chunk) {
        this._buffer = Buffer.concat([this._buffer, chunk]);
        this._parseBoxes();
    }

    _parseBoxes() {
        while (this._buffer.length >= 8) {
            // Read box header: 4 bytes size + 4 bytes type
            let boxSize = this._buffer.readUInt32BE(0);
            const boxType = this._buffer.readUInt32BE(4);

            // size === 0 means box extends to end of stream — can't handle in streaming
            if (boxSize === 0) {
                this.emit('error', new Error('MP4 box with size 0 (extends to EOF) not supported in streaming mode'));
                this._buffer = Buffer.alloc(0); // clear to avoid infinite error loop
                break;
            }

            // Guard against unreasonably large boxes (corrupt/adversarial input)
            const MAX_BOX_SIZE = 128 * 1024 * 1024; // 128 MB
            if (boxSize > MAX_BOX_SIZE) {
                this.emit('error', new Error(`MP4 box size ${boxSize} exceeds limit ${MAX_BOX_SIZE}`));
                this._buffer = Buffer.alloc(0);
                break;
            }

            // size === 1 means 64-bit extended size follows
            if (boxSize === 1) {
                if (this._buffer.length < 16) break; // need more data for extended header
                // Read 8-byte size (we only support up to Number.MAX_SAFE_INTEGER)
                const hi = this._buffer.readUInt32BE(8);
                const lo = this._buffer.readUInt32BE(12);
                boxSize = hi * 0x100000000 + lo;
            }

            // Wait for the full box
            if (this._buffer.length < boxSize) break;

            // Extract the complete box
            const boxData = this._buffer.slice(0, boxSize);
            this._buffer = this._buffer.slice(boxSize);

            if (this._sequence < 3 || this._state === 'init') {
                const typeStr = Buffer.from([(boxType >> 24) & 0xFF, (boxType >> 16) & 0xFF, (boxType >> 8) & 0xFF, boxType & 0xFF]).toString('ascii');
                console.log(`[fmp4-parser] Box: ${typeStr} size=${boxSize} state=${this._state}`);
            }
            this._handleBox(boxType, boxData);
        }
    }

    _handleBox(type, data) {
        if (this._state === 'init') {
            // Accumulate boxes until we have ftyp + moov
            this._initBoxes.push(data);

            if (type === BOX_MOOV) {
                // Init segment complete: concatenate all accumulated boxes
                this._initSegment = Buffer.concat(this._initBoxes);
                this._trackKinds = this._extractTrackKinds(this._initSegment);
                this._state = 'streaming';
                this.emit('init', { initSegment: this._initSegment });
            }
            // ftyp, free, skip, and other pre-moov boxes are just accumulated
        } else {
            // Streaming state: collect moof+mdat fragments
            if (type === BOX_STYP) {
                // styp is an optional segment type box, prepend to next fragment
                this._pendingFragment.push(data);
            } else if (type === BOX_MOOF) {
                // If we already have a moof without a matching mdat, that's unexpected
                const hasMoof = this._pendingFragment.some(b => b.readUInt32BE(4) === BOX_MOOF);
                if (hasMoof) {
                    // Drop the incomplete fragment and start fresh
                    this.emit('error', new Error('Received moof without preceding mdat, dropping incomplete fragment'));
                    this._pendingFragment = [];
                }
                this._pendingFragment.push(data);
            } else if (type === BOX_MDAT) {
                // Require a preceding moof
                const hasMoof = this._pendingFragment.some(b => b.length >= 8 && b.readUInt32BE(4) === BOX_MOOF);
                if (!hasMoof) {
                    this.emit('error', new Error('mdat received without preceding moof, dropping'));
                    this._pendingFragment = [];
                    return;
                }
                this._pendingFragment.push(data);

                // Fragment complete: concatenate all pending boxes
                const fragmentData = Buffer.concat(this._pendingFragment);
                this._pendingFragment = [];
                this._sequence++;
                const hasVideo = this._fragmentHasVideo(fragmentData);

                this.emit('fragment', {
                    sequence: this._sequence,
                    data: fragmentData,
                    hasVideo,
                    keyframeStart: hasVideo, // Best-effort: FFmpeg is configured to prefer keyframe fragmentation
                });
            } else if (type === BOX_MOOV) {
                // Second moov means stream restarted — treat as new init
                this._initBoxes = [data];
                this._initSegment = null;
                this._pendingFragment = [];
                // We need ftyp too, but FFmpeg may not re-emit it.
                // Treat moov alone as a valid re-init.
                this._initSegment = data;
                this._trackKinds = this._extractTrackKinds(this._initSegment);
                this.emit('init', { initSegment: this._initSegment });
            }
            // Ignore other box types in streaming mode (e.g., free, sidx)
        }
    }

    _readBoxHeader(buffer, offset, end = buffer.length) {
        if ((end - offset) < 8) return null;

        let size = buffer.readUInt32BE(offset);
        const type = buffer.readUInt32BE(offset + 4);
        let headerSize = 8;

        if (size === 1) {
            if ((end - offset) < 16) return null;
            const hi = buffer.readUInt32BE(offset + 8);
            const lo = buffer.readUInt32BE(offset + 12);
            size = hi * 0x100000000 + lo;
            headerSize = 16;
        } else if (size === 0) {
            size = end - offset;
        }

        if (size < headerSize || (offset + size) > end) return null;
        return {
            type,
            size,
            headerSize,
            start: offset,
            end: offset + size,
        };
    }

    _forEachChildBox(buffer, start, end, visitor) {
        let offset = start;
        while (offset < end) {
            const header = this._readBoxHeader(buffer, offset, end);
            if (!header) break;
            visitor(header);
            offset = header.end;
        }
    }

    _readTkhdTrackId(box) {
        if (box.length < 24) return null;
        const version = box.readUInt8(8);
        const trackIdOffset = version === 1 ? 28 : 20;
        if (box.length < trackIdOffset + 4) return null;
        return box.readUInt32BE(trackIdOffset);
    }

    _readHdlrType(box) {
        if (box.length < 20) return null;
        return box.subarray(16, 20).toString('ascii');
    }

    _readTfhdTrackId(box) {
        if (box.length < 16) return null;
        return box.readUInt32BE(12);
    }

    _extractTrackKinds(initSegment) {
        const trackKinds = new Map();

        this._forEachChildBox(initSegment, 0, initSegment.length, (rootBox) => {
            if (rootBox.type !== BOX_MOOV) return;

            this._forEachChildBox(initSegment, rootBox.start + rootBox.headerSize, rootBox.end, (trakBox) => {
                if (trakBox.type !== BOX_TRAK) return;

                let trackId = null;
                let handlerType = null;
                this._forEachChildBox(initSegment, trakBox.start + trakBox.headerSize, trakBox.end, (childBox) => {
                    const childData = initSegment.subarray(childBox.start, childBox.end);
                    if (childBox.type === BOX_TKHD) {
                        trackId = this._readTkhdTrackId(childData);
                        return;
                    }
                    if (childBox.type !== BOX_MDIA) return;

                    this._forEachChildBox(initSegment, childBox.start + childBox.headerSize, childBox.end, (mdiaChildBox) => {
                        if (mdiaChildBox.type !== BOX_HDLR) return;
                        handlerType = this._readHdlrType(initSegment.subarray(mdiaChildBox.start, mdiaChildBox.end));
                    });
                });

                if (trackId && handlerType) {
                    if (handlerType === 'vide') trackKinds.set(trackId, 'video');
                    if (handlerType === 'soun') trackKinds.set(trackId, 'audio');
                }
            });
        });

        return trackKinds;
    }

    _fragmentHasVideo(fragmentData) {
        let hasVideo = false;

        this._forEachChildBox(fragmentData, 0, fragmentData.length, (rootBox) => {
            if (rootBox.type !== BOX_MOOF || hasVideo) return;

            this._forEachChildBox(fragmentData, rootBox.start + rootBox.headerSize, rootBox.end, (moofChildBox) => {
                if (moofChildBox.type !== BOX_TRAF || hasVideo) return;

                this._forEachChildBox(fragmentData, moofChildBox.start + moofChildBox.headerSize, moofChildBox.end, (trafChildBox) => {
                    if (trafChildBox.type !== BOX_TFHD || hasVideo) return;
                    const trackId = this._readTfhdTrackId(fragmentData.subarray(trafChildBox.start, trafChildBox.end));
                    if (trackId && this._trackKinds.get(trackId) === 'video') {
                        hasVideo = true;
                    }
                });
            });
        });

        return hasVideo;
    }

    /**
     * Reset parser state (on generation change, worker restart, etc.)
     */
    reset() {
        this._buffer = Buffer.alloc(0);
        this._initSegment = null;
        this._initBoxes = [];
        this._pendingFragment = [];
        this._state = 'init';
        this._sequence = 0;
        this._trackKinds = new Map();
    }

    get initSegment() {
        return this._initSegment;
    }

    get sequence() {
        return this._sequence;
    }
}

module.exports = { FMP4Parser };
