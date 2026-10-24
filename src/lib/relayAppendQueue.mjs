// @ts-check

// The append queue of WatchView's relay player (the browser host's
// MediaRecorder stream over Socket.IO).
//
// Relay chunks are one continuous byte stream: a chunk that never reaches the
// SourceBuffer corrupts everything after it. So a chunk stays at the head of
// the queue, and in its byte count, until the SourceBuffer has taken it: its
// append ended with 'updateend' and no 'error'. One append runs at a time.
//
// A QuotaExceededError from appendBuffer() frees the media more than 10 s
// behind the playhead and appends the same chunk again, once. Anything else
// that stops the stream from reaching the picture is a failure, reported once
// through onFailure, after which the queue takes nothing more:
// - more chunks or bytes queued than the limits (the viewer fell behind);
// - a SourceBuffer that is still full after its eviction, or has nothing to evict;
// - any other appendBuffer() exception;
// - the SourceBuffer's 'error' (the browser could not parse an append);
// - the MediaSource ending or closing ('sourceended', 'sourceclose', or a
//   readyState other than 'open' when an append is due).
// close() (the attempt's cleanup, before it tears the MediaSource down) removes
// the listeners and reports nothing, and while isActive() is false (a newer
// playback attempt owns the video element) every event is ignored.
//
// No React here, so the unit tests drive the same code with a fake SourceBuffer.

export const RELAY_FELL_BEHIND_MESSAGE = 'Relay playback fell behind and must be restarted.';
export const RELAY_UNREADABLE_MESSAGE = 'The browser could not read the relay stream, so relay playback must be restarted.';
export const RELAY_SOURCE_CLOSED_MESSAGE = 'The browser closed the relay stream, so relay playback must be restarted.';
export const RELAY_BUFFER_FULL_MESSAGE = 'The browser has no room left to buffer the relay stream, so relay playback must be restarted.';

/** @param {unknown} err */
export function relayAppendRefusedMessage(err) {
    const name = /** @type {{ name?: unknown }} */ (err)?.name;
    const reason = typeof name === 'string' && name ? ` (${name})` : '';
    return `The browser refused relay media${reason}, so relay playback must be restarted.`;
}

/** Seconds of media before the playhead that an eviction keeps. */
export const EVICTION_KEEP_SECONDS = 10;

/** @param {unknown} err */
export function isQuotaExceededError(err) {
    const { name, code } = /** @type {{ name?: unknown, code?: unknown }} */ (err ?? {});
    return name === 'QuotaExceededError' || code === 22;
}

/**
 * @typedef {object} RelaySourceBuffer
 * @property {boolean} updating
 * @property {(data: Uint8Array) => void} appendBuffer
 * @property {(start: number, end: number) => void} remove
 * @property {(type: string, listener: () => void) => void} addEventListener
 * @property {(type: string, listener: () => void) => void} removeEventListener
 */

/**
 * @typedef {object} RelayMediaSource
 * @property {string} readyState
 * @property {(type: string, listener: () => void) => void} addEventListener
 * @property {(type: string, listener: () => void) => void} removeEventListener
 */

/**
 * @param {object} options
 * @param {number} options.maxChunks
 * @param {number} options.maxBytes
 * @param {(failure: Error) => void} options.onFailure
 * @param {() => void} [options.onUpdateEnd] runs after every SourceBuffer
 *   operation that ended without a failure, before the next append starts
 * @param {() => boolean} [options.isActive] false once a newer attempt owns playback
 * @param {() => number} [options.getCurrentTime] the playhead, for evictions
 */
export function createRelayAppendQueue({
    maxChunks,
    maxBytes,
    onFailure,
    onUpdateEnd = () => { },
    isActive = () => true,
    getCurrentTime = () => 0,
}) {
    /** @type {Uint8Array[]} */
    let chunks = [];
    let bytes = 0;
    /** @type {RelaySourceBuffer | null} */
    let sourceBuffer = null;
    /** @type {RelayMediaSource | null} */
    let mediaSource = null;
    // The SourceBuffer operation this queue started and has not seen end: the
    // append of `chunk`, or an eviction (chunk null).
    /** @type {{ chunk: Uint8Array | null } | null} */
    let pending = null;
    // The chunk an eviction was made for; a second QuotaExceededError for it is final.
    /** @type {Uint8Array | null} */
    let evictedFor = null;
    // Failed or closed: the queue takes and reports nothing more.
    let done = false;
    /** @type {Array<() => void>} */
    const unlisten = [];

    const stop = () => {
        done = true;
        chunks = [];
        bytes = 0;
        pending = null;
        evictedFor = null;
        while (unlisten.length) /** @type {() => void} */ (unlisten.pop())();
    };

    /** @param {string} message @param {unknown} [cause] */
    const fail = (message, cause) => {
        if (done) return;
        stop();
        onFailure(cause === undefined ? new Error(message) : new Error(message, { cause }));
    };

    /** @param {Uint8Array} chunk */
    const removeChunk = (chunk) => {
        // A flush for a new recorder generation may have dropped it meanwhile.
        const index = chunks.indexOf(chunk);
        if (index < 0) return;
        chunks.splice(index, 1);
        bytes -= chunk.byteLength;
    };

    /** @param {RelaySourceBuffer} target @param {Uint8Array} chunk @param {unknown} err */
    const evictFor = (target, chunk, err) => {
        const end = getCurrentTime() - EVICTION_KEEP_SECONDS;
        if (evictedFor === chunk || !(end > 0)) {
            fail(RELAY_BUFFER_FULL_MESSAGE, err);
            return;
        }
        try {
            target.remove(0, end);
        } catch (removeErr) {
            fail(RELAY_BUFFER_FULL_MESSAGE, removeErr);
            return;
        }
        evictedFor = chunk;
        pending = { chunk: null };
    };

    const pump = () => {
        if (done || !sourceBuffer || !isActive()) return;
        if (pending || sourceBuffer.updating || !chunks.length) return;
        if (mediaSource && mediaSource.readyState !== 'open') {
            fail(RELAY_SOURCE_CLOSED_MESSAGE);
            return;
        }
        const chunk = chunks[0];
        try {
            sourceBuffer.appendBuffer(chunk);
        } catch (err) {
            if (isQuotaExceededError(err)) evictFor(sourceBuffer, chunk, err);
            else fail(relayAppendRefusedMessage(err), err);
            return;
        }
        pending = { chunk };
    };

    const handleUpdateEnd = () => {
        if (done || !isActive()) return;
        const finished = pending;
        pending = null;
        // Chromium fires updateend for an append that a closing MediaSource cut
        // short before it fires sourceclose; the SourceBuffer is gone by then.
        if (mediaSource && mediaSource.readyState === 'closed') {
            fail(RELAY_SOURCE_CLOSED_MESSAGE);
            return;
        }
        if (finished?.chunk) {
            removeChunk(finished.chunk);
            if (evictedFor === finished.chunk) evictedFor = null;
        }
        onUpdateEnd();
        pump();
    };

    const handleError = () => {
        if (done || !isActive()) return;
        fail(RELAY_UNREADABLE_MESSAGE);
    };

    const handleSourceGone = () => {
        if (done || !isActive()) return;
        fail(RELAY_SOURCE_CLOSED_MESSAGE);
    };

    /**
     * @param {{ addEventListener: (type: string, listener: () => void) => void, removeEventListener: (type: string, listener: () => void) => void }} target
     * @param {string} type
     * @param {() => void} listener
     */
    const listen = (target, type, listener) => {
        target.addEventListener(type, listener);
        unlisten.push(() => target.removeEventListener(type, listener));
    };

    return {
        /** Chunks queued, the one being appended included. */
        get length() {
            return chunks.length;
        },

        /** Bytes queued, the chunk being appended included. */
        get bytes() {
            return bytes;
        },

        /**
         * Queues a live chunk and appends it when its turn comes. False when the
         * queue takes nothing (failed, closed, or not current) or the chunk took it
         * past its limits, which fails it.
         * @param {Uint8Array} chunk
         */
        enqueue(chunk) {
            if (done || !isActive()) return false;
            chunks.push(chunk);
            bytes += chunk.byteLength;
            if (chunks.length > maxChunks || bytes > maxBytes) {
                fail(RELAY_FELL_BEHIND_MESSAGE);
                return false;
            }
            pump();
            return true;
        },

        /**
         * Puts chunks in front of the queue (a later viewer's bootstrap snapshot),
         * before the first append starts. The limits are checked at the next enqueue.
         * @param {Uint8Array[]} list
         */
        prepend(list) {
            if (done) return;
            chunks.unshift(...list);
            for (const chunk of list) bytes += chunk.byteLength;
        },

        /**
         * Drops every queued chunk (a new recorder generation starts over at its
         * init). An append still running ends on its own; its updateend removes nothing.
         */
        clear() {
            chunks = [];
            bytes = 0;
            evictedFor = null;
        },

        /**
         * Starts feeding this SourceBuffer and listens for its failures and its
         * MediaSource's. Call pump() to start.
         * @param {RelaySourceBuffer} nextSourceBuffer
         * @param {RelayMediaSource} nextMediaSource
         */
        attach(nextSourceBuffer, nextMediaSource) {
            if (done) return;
            sourceBuffer = nextSourceBuffer;
            mediaSource = nextMediaSource;
            listen(sourceBuffer, 'updateend', handleUpdateEnd);
            listen(sourceBuffer, 'error', handleError);
            listen(mediaSource, 'sourceended', handleSourceGone);
            listen(mediaSource, 'sourceclose', handleSourceGone);
        },

        /** Starts the next append if none is running. */
        pump,

        /** Stops for good without reporting anything (the attempt's cleanup). */
        close() {
            if (!done) stop();
        },
    };
}

/** @typedef {ReturnType<typeof createRelayAppendQueue>} RelayAppendQueue */
