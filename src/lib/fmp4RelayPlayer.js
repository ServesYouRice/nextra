// src/lib/fmp4RelayPlayer.js - MSE player for fMP4 fallback relay (OBS Lane 1)
// Handles init segment bootstrapping, fragment append queue, generation resets,
// and SourceBuffer lifecycle for reliable fMP4 playback.

const MAX_QUEUE_SIZE = 120;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024; // 16MB

/**
 * Create an fMP4 relay player that manages MSE playback from Socket.IO media events.
 *
 * @param {object} opts
 * @param {HTMLVideoElement} opts.videoElement
 * @param {object} opts.socket - Socket.IO client instance
 * @param {string} opts.roomCode
 * @param {function} [opts.onStateChange] - ('connecting'|'buffering'|'playing'|'error'|'stopped')
 * @param {function} [opts.onError] - (message, err)
 * @returns {{ start, stop, getState }}
 */
export function createFmp4RelayPlayer(opts) {
    const { videoElement, socket, roomCode, onStateChange, onError } = opts;

    let mediaSource = null;
    let sourceBuffer = null;
    let currentGeneration = -1;
    let appendQueue = [];
    let isAppending = false;
    let state = 'stopped';
    let mimeType = null;
    let queueBytes = 0;
    let cleanupFns = [];
    let consecutiveDrops = 0;
    const MAX_CONSECUTIVE_DROPS = 15;

    function setState(newState) {
        if (state === newState) return;
        state = newState;
        onStateChange?.(newState);
    }

    function handleError(msg, err) {
        console.error(`[fmp4-player] ${msg}`, err || '');
        onError?.(msg, err);
        setState('error');
    }

    // ── Append queue ──

    function processQueue() {
        if (isAppending || !sourceBuffer || appendQueue.length === 0) return;
        if (sourceBuffer.updating) return;

        isAppending = true;
        const item = appendQueue.shift();
        queueBytes -= item.byteLength;

        try {
            sourceBuffer.appendBuffer(item);
        } catch (err) {
            isAppending = false;
            if (err.name === 'QuotaExceededError') {
                trimBuffer();
                appendQueue.unshift(item);
                queueBytes += item.byteLength;
                setTimeout(processQueue, 100);
            } else {
                handleError('SourceBuffer append failed', err);
            }
        }
    }

    function resetAndRequestInit() {
        // Full cleanup (handles abort + endOfStream + null-out)
        cleanupMediaSource();
        setState('buffering');
        socket.emit('get-media-init', { roomCode, format: 'fmp4' }, (response) => {
            if (response && response.success && response.initSegment) {
                handleMediaInit(response.init
                    ? { ...response.init, initSegment: response.initSegment }
                    : response
                );
            } else {
                handleError('Failed to recover — init segment unavailable');
            }
        });
    }

    function trimBuffer() {
        if (!sourceBuffer || sourceBuffer.updating) return;
        try {
            const buffered = sourceBuffer.buffered;
            if (buffered.length > 0 && videoElement.currentTime > 0) {
                const removeEnd = videoElement.currentTime - 5;
                if (removeEnd > buffered.start(0)) {
                    sourceBuffer.remove(buffered.start(0), removeEnd);
                }
            }
        } catch (e) {
            // Ignore trim errors
        }
    }

    // ── Event handlers ──

    function handleMediaInit(data) {
        // data: { format, mimeType, codec, audioCodec, generation, tier, initSegment }
        if (data.generation !== currentGeneration) {
            // Use full cleanup so mediaSource is also torn down before setupMediaSource recreates it.
            // This avoids the double-endOfStream that occurs when setupMediaSource calls
            // cleanupMediaSource() on a mediaSource whose sourceBuffer was already removed.
            cleanupMediaSource();
            currentGeneration = data.generation;
        }

        mimeType = data.mimeType;

        if (!MediaSource.isTypeSupported(mimeType)) {
            handleError(`Browser does not support MIME type: ${mimeType}`);
            return;
        }

        setupMediaSource(data.initSegment);
    }

    function handleMediaChunk(data) {
        // data: { format, generation, tier, sequence, keyframeStart, chunk }
        if (data.generation !== currentGeneration) return;

        if (appendQueue.length >= MAX_QUEUE_SIZE || queueBytes >= MAX_QUEUE_BYTES) {
            consecutiveDrops++;
            console.warn('[fmp4-player] Queue full, dropping fragment', data.sequence, `(${consecutiveDrops} consecutive)`);
            if (consecutiveDrops >= MAX_CONSECUTIVE_DROPS) {
                consecutiveDrops = 0;
                resetAndRequestInit();
            }
            return;
        }
        consecutiveDrops = 0;

        const buffer = data.chunk instanceof ArrayBuffer
            ? new Uint8Array(data.chunk)
            : new Uint8Array(data.chunk.buffer || data.chunk);

        appendQueue.push(buffer);
        queueBytes += buffer.byteLength;
        processQueue();

        if (data.sequence % 30 === 0) {
            trimBuffer();
        }
    }

    // ── MediaSource setup ──

    function setupMediaSource(initSegment) {
        if (mediaSource) {
            cleanupMediaSource();
        }

        mediaSource = new MediaSource();
        const objectUrl = URL.createObjectURL(mediaSource);
        videoElement.src = objectUrl;

        const onSourceOpen = () => {
            try {
                sourceBuffer = mediaSource.addSourceBuffer(mimeType);
                sourceBuffer.mode = 'segments';

                sourceBuffer.addEventListener('updateend', () => {
                    isAppending = false;
                    processQueue();

                    if (state === 'buffering' && sourceBuffer.buffered.length > 0) {
                        setState('playing');
                        videoElement.play().catch(() => {});
                    }
                });

                sourceBuffer.addEventListener('error', () => {
                    console.error('[fmp4-player] SourceBuffer error, attempting recovery');
                    resetAndRequestInit();
                });

                // Append init segment first
                setState('buffering');
                const initBuffer = initSegment instanceof ArrayBuffer
                    ? new Uint8Array(initSegment)
                    : new Uint8Array(initSegment.buffer || initSegment);
                appendQueue.unshift(initBuffer);
                queueBytes += initBuffer.byteLength;
                processQueue();
            } catch (err) {
                handleError('Failed to create SourceBuffer', err);
            }
        };

        mediaSource.addEventListener('sourceopen', onSourceOpen);
        cleanupFns.push(() => {
            mediaSource.removeEventListener('sourceopen', onSourceOpen);
            URL.revokeObjectURL(objectUrl);
        });
    }

    function cleanupMediaSource() {
        appendQueue = [];
        queueBytes = 0;
        isAppending = false;

        if (sourceBuffer) {
            try {
                if (mediaSource && mediaSource.readyState === 'open') {
                    // Abort any in-progress append before removal (prevents InvalidStateError)
                    if (sourceBuffer.updating) sourceBuffer.abort();
                    mediaSource.removeSourceBuffer(sourceBuffer);
                }
            } catch (e) { }
            sourceBuffer = null;
        }

        if (mediaSource) {
            try {
                // Only call endOfStream if nothing is updating
                if (mediaSource.readyState === 'open' && (!sourceBuffer || !sourceBuffer.updating)) {
                    mediaSource.endOfStream();
                }
            } catch (e) { }
            mediaSource = null;
        }
    }

    // Reset only the sourceBuffer, leaving mediaSource intact.
    // Used internally during generation change before setupMediaSource rebuilds it.
    function _resetSourceBufferOnly() {
        appendQueue = [];
        queueBytes = 0;
        isAppending = false;

        if (sourceBuffer && mediaSource && mediaSource.readyState === 'open') {
            try {
                if (sourceBuffer.updating) sourceBuffer.abort();
                mediaSource.removeSourceBuffer(sourceBuffer);
            } catch (e) { }
        }
        sourceBuffer = null;
    }

    // ── Public API ──

    function start() {
        setState('connecting');

        socket.on('media-init', handleMediaInit);
        socket.on('media-chunk', handleMediaChunk);

        cleanupFns.push(() => {
            socket.off('media-init', handleMediaInit);
            socket.off('media-chunk', handleMediaChunk);
        });

        // Request current init segment
        socket.emit('get-media-init', { roomCode, format: 'fmp4' }, (response) => {
            if (response && response.success && response.initSegment) {
                handleMediaInit(response.init
                    ? { ...response.init, initSegment: response.initSegment }
                    : response
                );
            } else {
                console.log('[fmp4-player] Init segment not yet available, waiting...');
            }
        });
    }

    function stop() {
        setState('stopped');
        cleanupFns.forEach(fn => { try { fn(); } catch (e) { } });
        cleanupFns = [];
        cleanupMediaSource();
        currentGeneration = -1;
        videoElement.src = '';
        videoElement.load();
    }

    function getState() {
        return {
            state,
            generation: currentGeneration,
            queueLength: appendQueue.length,
            queueBytes,
            mimeType,
        };
    }

    return { start, stop, getState };
}
