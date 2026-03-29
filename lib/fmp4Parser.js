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

class FMP4Parser extends EventEmitter {
    constructor() {
        super();
        this._buffer = Buffer.alloc(0);
        this._initSegment = null;
        this._initBoxes = [];
        this._pendingFragment = [];
        this._state = 'init'; // 'init' | 'streaming'
        this._sequence = 0;
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

            let headerSize = 8;

            // size === 1 means 64-bit extended size follows
            if (boxSize === 1) {
                if (this._buffer.length < 16) break; // need more data for extended header
                // Read 8-byte size (we only support up to Number.MAX_SAFE_INTEGER)
                const hi = this._buffer.readUInt32BE(8);
                const lo = this._buffer.readUInt32BE(12);
                boxSize = hi * 0x100000000 + lo;
                headerSize = 16;
            }

            // Wait for the full box
            if (this._buffer.length < boxSize) break;

            // Extract the complete box
            const boxData = this._buffer.slice(0, boxSize);
            this._buffer = this._buffer.slice(boxSize);

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

                this.emit('fragment', {
                    sequence: this._sequence,
                    data: fragmentData,
                    keyframeStart: true, // Lane 1: assume every fragment starts with a keyframe
                });
            } else if (type === BOX_MOOV) {
                // Second moov means stream restarted — treat as new init
                this._initBoxes = [data];
                this._initSegment = null;
                this._pendingFragment = [];
                // We need ftyp too, but FFmpeg may not re-emit it.
                // Treat moov alone as a valid re-init.
                this._initSegment = data;
                this.emit('init', { initSegment: this._initSegment });
            }
            // Ignore other box types in streaming mode (e.g., free, sidx)
        }
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
    }

    get initSegment() {
        return this._initSegment;
    }

    get sequence() {
        return this._sequence;
    }
}

module.exports = { FMP4Parser };
