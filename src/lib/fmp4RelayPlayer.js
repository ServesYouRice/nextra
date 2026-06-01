// src/lib/fmp4RelayPlayer.js - MSE player for fMP4 fallback relay (OBS Lane 1)
// Handles init segment bootstrapping, fragment append queue, generation resets,
// and SourceBuffer lifecycle for reliable fMP4 playback.

const MAX_QUEUE_SIZE = 120;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024; // 16MB
const BACK_BUFFER_SECONDS = 8;
const START_BUFFER_SECONDS = 1.25;
const RESUME_BUFFER_SECONDS = 0.75;
const LIVE_EDGE_MARGIN_SECONDS = 2.5;
const LIVE_EDGE_SEEK_THRESHOLD_SECONDS = 5.0;
const STALL_TIME_EPSILON_SECONDS = 0.05;
const MAX_STALLS_BEFORE_SEEK = 3;
const BUFFERING_DETECTION_GRACE_MS = 350;
const READY_STATE_CURRENT_DATA = 2;
const INIT_RETRY_INTERVAL_MS = 2000;
const INIT_WAIT_TIMEOUT_MS = 15000;
const MAX_INIT_TIMEOUT_RETRIES = 3;

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
    let initRetryTimer = null;
    let initTimeoutTimer = null;
    let bufferingTimer = null;
    let initTimeoutRetries = 0;
    let lastQueueDropWarnAt = 0;

    function setState(newState) {
        if (newState !== 'buffering') {
            clearBufferingTimer();
        }
        if (state === newState) return;
        state = newState;
        onStateChange?.(newState);
    }

    function handleError(msg, err) {
        clearInitWaiters();
        clearBufferingTimer();
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

    function getLiveBufferedRange() {
        if (!sourceBuffer) return null;
        try {
            const buffered = sourceBuffer.buffered;
            if (buffered.length === 0) return null;
            const index = buffered.length - 1;
            return {
                start: buffered.start(index),
                end: buffered.end(index),
            };
        } catch {
            return null;
        }
    }

    function getBufferAheadSeconds() {
        const range = getLiveBufferedRange();
        if (!range) return 0;
        const currentTime = Number.isFinite(videoElement.currentTime) ? videoElement.currentTime : range.start;
        if (currentTime <= range.start) {
            return range.end - range.start;
        }
        return Math.max(0, range.end - currentTime);
    }

    function maybeResumePlayback(minBufferSeconds) {
        const range = getLiveBufferedRange();
        if (!range) return false;

        const currentTime = Number.isFinite(videoElement.currentTime) ? videoElement.currentTime : range.start;
        const targetTime = Math.max(range.start, range.end - LIVE_EDGE_MARGIN_SECONDS);
        const bufferAhead = currentTime < range.start
            ? (range.end - range.start)
            : Math.max(0, range.end - currentTime);

        if (bufferAhead < minBufferSeconds && (range.end - range.start) < minBufferSeconds) {
            return false;
        }

        clearBufferingTimer();
        if (!Number.isFinite(videoElement.currentTime) || currentTime < range.start || currentTime > range.end) {
            videoElement.currentTime = targetTime;
        }
        const markPlayingIfReady = () => {
            if (!videoElement.paused && videoElement.readyState >= READY_STATE_CURRENT_DATA) {
                setState('playing');
            }
            startLiveSeekTimer();
        };

        const resumeMutedIfBlocked = (err) => {
            if (err?.name !== 'NotAllowedError' || videoElement.muted) {
                console.warn('[fmp4-player] Playback resume failed', err?.message || err);
                return;
            }

            console.warn('[fmp4-player] Playback resume was blocked while unmuted; retrying muted');
            videoElement.muted = true;
            const retryResult = videoElement.play();
            if (retryResult && typeof retryResult.then === 'function') {
                retryResult
                    .then(markPlayingIfReady)
                    .catch((retryErr) => {
                        console.warn('[fmp4-player] Muted playback retry failed', retryErr?.message || retryErr);
                    });
                return;
            }

            markPlayingIfReady();
        };

        const playResult = videoElement.play();
        if (playResult && typeof playResult.then === 'function') {
            playResult
                .then(markPlayingIfReady)
                .catch(resumeMutedIfBlocked);
        } else {
            markPlayingIfReady();
        }
        return true;
    }

    function clearBufferingTimer() {
        if (!bufferingTimer) return;
        clearTimeout(bufferingTimer);
        bufferingTimer = null;
    }

    function shouldEnterBuffering() {
        if (state !== 'playing') return false;
        if (videoElement.paused) return false;
        return (
            getBufferAheadSeconds() < RESUME_BUFFER_SECONDS
            || videoElement.readyState < READY_STATE_CURRENT_DATA
        );
    }

    function scheduleBufferingState() {
        if (state !== 'playing' || bufferingTimer) return;
        bufferingTimer = setTimeout(() => {
            bufferingTimer = null;
            if (shouldEnterBuffering()) {
                setState('buffering');
            }
        }, BUFFERING_DETECTION_GRACE_MS);
    }

    // ── Live-edge seeking & stall detection ──

    function seekToLiveEdge() {
        if (!videoElement || !sourceBuffer) return;
        try {
            const range = getLiveBufferedRange();
            if (!range) return;
            const liveEdge = range.end;
            const target = Math.max(range.start, liveEdge - LIVE_EDGE_MARGIN_SECONDS);
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
            const bufferAhead = getBufferAheadSeconds();

            if (state === 'playing' && bufferAhead < RESUME_BUFFER_SECONDS) {
                scheduleBufferingState();
            } else if (bufferAhead >= RESUME_BUFFER_SECONDS) {
                clearBufferingTimer();
            }

            // Stall detection: if currentTime hasn't changed, the video is stuck
            if (
                !videoElement.paused
                && Math.abs(videoElement.currentTime - lastPlayTime) < STALL_TIME_EPSILON_SECONDS
                && lastPlayTime >= 0
            ) {
                stallCount++;
                if (stallCount >= MAX_STALLS_BEFORE_SEEK) {
                    console.warn('[fmp4-player] Stall detected, seeking to live edge');
                    if (bufferAhead >= RESUME_BUFFER_SECONDS) {
                        seekToLiveEdge();
                    }
                    maybeResumePlayback(RESUME_BUFFER_SECONDS);
                    stallCount = 0;
                }
            } else {
                stallCount = 0;
            }
            lastPlayTime = videoElement.currentTime;

            // Periodic live-edge catch-up + buffer eviction
            if (bufferAhead > LIVE_EDGE_SEEK_THRESHOLD_SECONDS) {
                seekToLiveEdge();
            }
            if (state === 'buffering' && bufferAhead >= RESUME_BUFFER_SECONDS) {
                maybeResumePlayback(RESUME_BUFFER_SECONDS);
            }
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

    function clearInitRetryTimer() {
        if (!initRetryTimer) return;
        clearTimeout(initRetryTimer);
        initRetryTimer = null;
    }

    function clearInitTimeoutTimer() {
        if (!initTimeoutTimer) return;
        clearTimeout(initTimeoutTimer);
        initTimeoutTimer = null;
    }

    function clearInitWaiters() {
        clearInitRetryTimer();
        clearInitTimeoutTimer();
    }

    function armInitTimeout() {
        clearInitTimeoutTimer();
        initTimeoutTimer = setTimeout(() => {
            initTimeoutTimer = null;
            if (currentGeneration >= 0 || state === 'stopped') return;
            if (initTimeoutRetries < MAX_INIT_TIMEOUT_RETRIES) {
                initTimeoutRetries += 1;
                console.warn(`[fmp4-player] Relay init segment did not arrive in time; retrying bootstrap (${initTimeoutRetries}/${MAX_INIT_TIMEOUT_RETRIES})`);
                setState('buffering');
                armInitTimeout();
                socket.emit('fallback-consume-start', {}, (response) => {
                    if (response?.error) {
                        console.warn('[fmp4-player] fallback-consume-start retry failed:', response.error);
                    }
                    requestCurrentInit({ silentUnavailable: true, retryOnUnavailable: true });
                });
                return;
            }
            handleError('Relay init segment did not arrive in time');
        }, INIT_WAIT_TIMEOUT_MS);
    }

    function scheduleInitRetry() {
        if (initRetryTimer || state === 'stopped' || currentGeneration >= 0) return;
        initRetryTimer = setTimeout(() => {
            initRetryTimer = null;
            requestCurrentInit({ silentUnavailable: true, retryOnUnavailable: true });
        }, INIT_RETRY_INTERVAL_MS);
    }

    function requestCurrentInit({ silentUnavailable = false, retryOnUnavailable = true } = {}) {
        if (state === 'stopped') return;
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
                return;
            }

            if (!silentUnavailable) {
                console.log('[fmp4-player] Init segment not yet available, waiting...');
            }
            if (retryOnUnavailable) {
                scheduleInitRetry();
            }
        });
    }

    // ── Event handlers ──

    function handleMediaInit(data) {
        // data: { format, mimeType, codec, audioCodec, generation, tier, initSegment }
        if (!data.initSegment) {
            console.log('[fmp4-player] media-init without initSegment, requesting...');
            requestCurrentInit({ silentUnavailable: true, retryOnUnavailable: true });
            return;
        }

        clearInitWaiters();
        initTimeoutRetries = 0;

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
            const now = Date.now();
            if (now - lastQueueDropWarnAt > 1000 || consecutiveDrops >= MAX_CONSECUTIVE_DROPS) {
                lastQueueDropWarnAt = now;
                console.warn('[fmp4-player] Queue full, dropping fragment', data.sequence, `(${consecutiveDrops} consecutive)`);
            }
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
                        const minBufferSeconds = lastPlayTime < 0
                            ? START_BUFFER_SECONDS
                            : RESUME_BUFFER_SECONDS;
                        maybeResumePlayback(minBufferSeconds);
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
                    if (state === 'buffering' && getBufferAheadSeconds() >= RESUME_BUFFER_SECONDS) {
                        setState('playing');
                    }
                };
                const onPlaybackWaiting = () => {
                    scheduleBufferingState();
                };
                videoElement.addEventListener('loadeddata', onPlaybackReady);
                videoElement.addEventListener('playing', onPlaybackReady);
                videoElement.addEventListener('waiting', onPlaybackWaiting);
                videoElement.addEventListener('stalled', onPlaybackWaiting);
                cleanupFns.push(() => {
                    try { currentSourceBuffer.removeEventListener('updateend', onUpdateEnd); } catch { }
                    try { currentSourceBuffer.removeEventListener('error', onSourceBufferError); } catch { }
                    try { videoElement.removeEventListener('loadeddata', onPlaybackReady); } catch { }
                    try { videoElement.removeEventListener('playing', onPlaybackReady); } catch { }
                    try { videoElement.removeEventListener('waiting', onPlaybackWaiting); } catch { }
                    try { videoElement.removeEventListener('stalled', onPlaybackWaiting); } catch { }
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
        clearBufferingTimer();
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
        initTimeoutRetries = 0;
        setState('connecting');

        socket.on('media-init', handleMediaInit);
        socket.on('media-chunk', handleMediaChunk);

        cleanupFns.push(() => {
            socket.off('media-init', handleMediaInit);
            socket.off('media-chunk', handleMediaChunk);
        });

        // Request current init segment
        armInitTimeout();
        requestCurrentInit({ silentUnavailable: false, retryOnUnavailable: true });
    }

    function stop() {
        setState('stopped');
        clearInitWaiters();
        initTimeoutRetries = 0;
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
