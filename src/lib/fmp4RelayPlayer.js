// src/lib/fmp4RelayPlayer.js - MSE player for fMP4 fallback relay (OBS Lane 1)
// Handles init segment bootstrapping, fragment append queue, generation resets,
// and SourceBuffer lifecycle for reliable fMP4 playback.

const MAX_QUEUE_SIZE = 120;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024; // 16MB
const BACK_BUFFER_SECONDS = 2;
const LIVE_EDGE_MARGIN_SECONDS = 1.0;
const LIVE_EDGE_SEEK_THRESHOLD_SECONDS = 1.4;
const READY_STATE_CURRENT_DATA = 2;

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
    let liveSeekTimer = null;
    let lastPlayTime = -1;
    let stallCount = 0;
    let lastSequence = 0;

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

    function toUint8Array(value) {
        if (value instanceof Uint8Array) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
        if (ArrayBuffer.isView(value)) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
        if (value instanceof ArrayBuffer) {
            return new Uint8Array(value);
        }
        return new Uint8Array(value);
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
                    ? {
                        ...response.init,
                        initSegment: response.initSegment,
                        bootstrapFragment: response.bootstrapFragment,
                        bootstrapSequence: response.bootstrapSequence,
                    }
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
                const removeEnd = videoElement.currentTime - BACK_BUFFER_SECONDS;
                if (removeEnd > buffered.start(0)) {
                    sourceBuffer.remove(buffered.start(0), removeEnd);
                }
            }
        } catch { }
    }

    // ── Live-edge seeking & stall detection ──

    function seekToLiveEdge() {
        if (!videoElement || !sourceBuffer) return;
        try {
            const buffered = sourceBuffer.buffered;
            if (buffered.length === 0) return;
            const liveEdge = buffered.end(buffered.length - 1);
            const target = Math.max(0, liveEdge - LIVE_EDGE_MARGIN_SECONDS);
            if ((liveEdge - videoElement.currentTime) > LIVE_EDGE_SEEK_THRESHOLD_SECONDS) {
                videoElement.currentTime = target;
            }
        } catch {
            // Ignore seek errors
        }
    }

    function evictOldBuffer() {
        if (!sourceBuffer || sourceBuffer.updating) return;
        try {
            const buffered = sourceBuffer.buffered;
            if (buffered.length > 0 && videoElement.currentTime > 0) {
                const removeEnd = videoElement.currentTime - BACK_BUFFER_SECONDS;
                if (removeEnd > buffered.start(0)) {
                    sourceBuffer.remove(buffered.start(0), removeEnd);
                }
            }
        } catch { }
    }

    function startLiveSeekTimer() {
        if (liveSeekTimer) return;
        liveSeekTimer = setInterval(() => {
            if (state !== 'playing' && state !== 'buffering') return;

            // Stall detection: if currentTime hasn't changed, the video is stuck
            if (videoElement.currentTime === lastPlayTime && lastPlayTime >= 0) {
                stallCount++;
                if (stallCount >= 2) {
                    console.warn('[fmp4-player] Stall detected, seeking to live edge');
                    seekToLiveEdge();
                    videoElement.muted = true;
                    videoElement.play().catch(() => {});
                    stallCount = 0;
                }
            } else {
                stallCount = 0;
            }
            lastPlayTime = videoElement.currentTime;

            // Periodic live-edge catch-up + buffer eviction
            seekToLiveEdge();
            evictOldBuffer();
        }, 1000);
    }

    function stopLiveSeekTimer() {
        if (liveSeekTimer) {
            clearInterval(liveSeekTimer);
            liveSeekTimer = null;
        }
        lastPlayTime = -1;
        stallCount = 0;
    }

    // ── Event handlers ──

    function handleMediaInit(data) {
        // data: { format, mimeType, codec, audioCodec, generation, tier, initSegment }
        if (!data.initSegment) {
            console.log('[fmp4-player] media-init without initSegment, requesting...');
            socket.emit('get-media-init', { roomCode, format: 'fmp4' }, (response) => {
                if (response && response.success && response.initSegment) {
                    handleMediaInit({
                        ...response.init,
                        initSegment: response.initSegment,
                        bootstrapFragment: response.bootstrapFragment,
                        bootstrapSequence: response.bootstrapSequence,
                    });
                }
            });
            return;
        }

        if (data.generation !== currentGeneration) {
            cleanupMediaSource();
            currentGeneration = data.generation;
            lastSequence = 0;
        }

        mimeType = data.mimeType;

        if (!MediaSource.isTypeSupported(mimeType)) {
            handleError(`Browser does not support MIME type: ${mimeType}`);
            return;
        }

        if (typeof data.bootstrapSequence === 'number' && data.bootstrapSequence > 0) {
            lastSequence = data.bootstrapSequence;
        }

        setupMediaSource(data.initSegment, data.bootstrapFragment || null);
    }

    function handleMediaChunk(data) {
        // data: { format, generation, tier, sequence, keyframeStart, chunk }
        if (data.generation !== currentGeneration) return;
        if (typeof data.sequence === 'number' && data.sequence <= lastSequence) return;
        if (typeof data.sequence === 'number') {
            lastSequence = data.sequence;
        }

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

        const buffer = toUint8Array(data.chunk);
        if (buffer.byteLength === 0) return;

        appendQueue.push(buffer);
        queueBytes += buffer.byteLength;
        processQueue();

        if (data.sequence % 15 === 0) {
            trimBuffer();
        }
    }

    // ── MediaSource setup ──

    function setupMediaSource(initSegment, bootstrapFragment = null) {
        if (mediaSource) {
            cleanupMediaSource();
        }

        mediaSource = new MediaSource();
        const objectUrl = URL.createObjectURL(mediaSource);
        videoElement.src = objectUrl;

        const onSourceOpen = () => {
            try {
                const currentSourceBuffer = mediaSource.addSourceBuffer(mimeType);
                sourceBuffer = currentSourceBuffer;
                currentSourceBuffer.mode = 'segments';

                const onUpdateEnd = () => {
                    if (sourceBuffer !== currentSourceBuffer) return;
                    isAppending = false;
                    processQueue();

                    if (state === 'buffering' && currentSourceBuffer.buffered.length > 0) {
                        // Mute first to guarantee autoplay works (browser policy)
                        videoElement.muted = true;
                        seekToLiveEdge();
                        videoElement.play().catch(() => {});
                        if (videoElement.readyState >= READY_STATE_CURRENT_DATA) {
                            setState('playing');
                        }
                        startLiveSeekTimer();
                    }
                };

                const onSourceBufferError = () => {
                    if (sourceBuffer !== currentSourceBuffer) return;
                    console.error('[fmp4-player] SourceBuffer error, attempting recovery');
                    resetAndRequestInit();
                };

                currentSourceBuffer.addEventListener('updateend', onUpdateEnd);
                currentSourceBuffer.addEventListener('error', onSourceBufferError);
                const onPlaybackReady = () => {
                    if (state === 'buffering') {
                        setState('playing');
                    }
                };
                videoElement.addEventListener('loadeddata', onPlaybackReady);
                videoElement.addEventListener('playing', onPlaybackReady);
                cleanupFns.push(() => {
                    try { currentSourceBuffer.removeEventListener('updateend', onUpdateEnd); } catch { }
                    try { currentSourceBuffer.removeEventListener('error', onSourceBufferError); } catch { }
                    try { videoElement.removeEventListener('loadeddata', onPlaybackReady); } catch { }
                    try { videoElement.removeEventListener('playing', onPlaybackReady); } catch { }
                });

                // Append init segment first
                setState('buffering');
                const initBuffer = toUint8Array(initSegment);
                appendQueue.unshift(initBuffer);
                queueBytes += initBuffer.byteLength;
                if (bootstrapFragment) {
                    const bootstrapBuffer = toUint8Array(bootstrapFragment);
                    appendQueue.push(bootstrapBuffer);
                    queueBytes += bootstrapBuffer.byteLength;
                }
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
        stopLiveSeekTimer();
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
            } catch { }
            sourceBuffer = null;
        }

        if (mediaSource) {
            try {
                // Only call endOfStream if nothing is updating
                if (mediaSource.readyState === 'open' && (!sourceBuffer || !sourceBuffer.updating)) {
                    mediaSource.endOfStream();
                }
            } catch { }
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
            } catch { }
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
                    ? {
                        ...response.init,
                        initSegment: response.initSegment,
                        bootstrapFragment: response.bootstrapFragment,
                        bootstrapSequence: response.bootstrapSequence,
                    }
                    : response
                );
            } else {
                console.log('[fmp4-player] Init segment not yet available, waiting...');
            }
        });
    }

    function stop() {
        setState('stopped');
        stopLiveSeekTimer();
        cleanupFns.forEach(fn => { try { fn(); } catch { } });
        cleanupFns = [];
        cleanupMediaSource();
        currentGeneration = -1;
        lastSequence = 0;
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
