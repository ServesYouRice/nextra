// src/lib/fmp4RelayPlayer.js - MSE player for fMP4 fallback relay (OBS Lane 1)
// Handles init segment bootstrapping, fragment append queue, generation changes,
// live-edge tracking, and SourceBuffer lifecycle for low-delay fMP4 playback.

import { RELAY_PLAYBACK_UNSUPPORTED_MESSAGE, canPlayRelayFormat, createRelayMediaSource } from './watchPlaybackMode.mjs';
import {
    TARGET_MIN_SECONDS,
    TARGET_RELAX_AFTER_MS,
    TARGET_START_SECONDS,
    decideLiveSync,
    targetAfterQuietPeriod,
    targetAfterStall,
    targetBeforeSwitch,
} from './relayLiveSync.mjs';

// Fragments are a few frames long, so a healthy queue holds a handful of them.
const MAX_QUEUE_SIZE = 600;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024; // 16MB
const BACK_BUFFER_SECONDS = 6;
// Least media to have buffered before starting, so the first frames don't stall.
const START_BUFFER_SECONDS = 0.25;
const LIVE_SYNC_INTERVAL_MS = 250;
const STALL_TIME_EPSILON_SECONDS = 0.02;
// Sync ticks without the playhead moving before playback is kicked.
const STALL_TICKS_BEFORE_KICK = 8;
const BUFFERING_DETECTION_GRACE_MS = 350;
// How long after a bitrate change a stall is put down to the change itself.
const SWITCH_SETTLE_MS = 3000;
// Filler arrives with every fragment while the server tests the link. A switch
// follows a test that went well within a second or two; this long after the
// last filler without one, the test is over and nothing is coming.
const FILLER_PAUSE_MS = 2500;
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
    // Persistent teardown (socket subscriptions) — registered in start(), cleared
    // only in stop(); must survive generation changes.
    let cleanupFns = [];
    // Per-MediaSource teardown (SourceBuffer + video-element listeners, object
    // URL) — registered in setupMediaSource, cleared in cleanupMediaSource on
    // every MediaSource rebuild so listeners/URLs don't accumulate.
    let mediaSourceCleanupFns = [];
    let consecutiveDrops = 0;
    const MAX_CONSECUTIVE_DROPS = 15;
    let liveSyncTimer = null;
    let lastPlayTime = -1;
    let stallTicks = 0;
    let lastSequence = 0;
    let initRetryTimer = null;
    let initTimeoutTimer = null;
    let bufferingTimer = null;
    let initTimeoutRetries = 0;
    let lastQueueDropWarnAt = 0;
    // The cushion of buffered media kept ahead of the playhead; see relayLiveSync.
    let targetSeconds = TARGET_START_SECONDS;
    let lastStallAt = 0;
    // When the server last changed bitrate under this player (never, so far).
    let lastSwitchAt = Number.NEGATIVE_INFINITY;
    let lastFillerAt = Number.NEGATIVE_INFINITY;
    // How much of the cushion is reserve held for a bitrate switch.
    let switchReserve = 0;
    let started = false;
    // Whether the SourceBuffer lays fragments end to end (see setupMediaSource).
    let sequenceMode = false;

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

    function enqueue(buffer) {
        appendQueue.push(buffer);
        queueBytes += buffer.byteLength;
    }

    function clearQueue() {
        appendQueue = [];
        queueBytes = 0;
    }

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
        // Reject late fragments from the overflowed generation until a fresh
        // init response explicitly establishes the next generation.
        currentGeneration = -1;
        lastSequence = 0;
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

    /** Seconds of media buffered past the playhead, in the live range. */
    function getBufferAheadSeconds() {
        const range = getLiveBufferedRange();
        if (!range) return 0;
        const currentTime = Number.isFinite(videoElement.currentTime) ? videoElement.currentTime : range.start;
        if (currentTime < range.start) return range.end - range.start;
        return Math.max(0, range.end - currentTime);
    }

    /** True when nothing playable is left between the playhead and `start`. */
    function hasPlayedOutBefore(start, currentTime) {
        try {
            const buffered = sourceBuffer.buffered;
            for (let i = 0; i < buffered.length; i++) {
                if (buffered.start(i) >= start) break;
                if (currentTime >= buffered.start(i) && currentTime < buffered.end(i) - 0.1) return false;
            }
        } catch { }
        return true;
    }

    function setPlaybackRate(rate) {
        if (videoElement.playbackRate !== rate) {
            try { videoElement.playbackRate = rate; } catch { }
        }
    }

    function seekToCushion(range, cushion = targetSeconds) {
        try { videoElement.currentTime = Math.max(range.start, range.end - cushion); } catch { }
    }

    /**
     * Move the playhead into the live range when it has run into a hole in
     * front of it. An encoder restart leaves one: the old stream's audio and
     * video do not end on the same instant, and the new stream's do not begin on
     * one. The hole is a frame or two wide, and Chrome waits in front of it for
     * media that will never come.
     */
    function hopToLiveRange(range = getLiveBufferedRange()) {
        if (!range) return false;
        const currentTime = videoElement.currentTime;
        if (!(currentTime < range.start) || !hasPlayedOutBefore(range.start, currentTime)) return false;
        seekToCushion(range);
        return true;
    }

    function play() {
        const markPlayingIfReady = () => {
            if (!videoElement.paused && videoElement.readyState >= READY_STATE_CURRENT_DATA) {
                setState('playing');
            }
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
    }

    /** Begin playback once the first media has buffered, a cushion behind live. */
    function maybeStartPlayback() {
        if (started) return;
        const range = getLiveBufferedRange();
        if (!range || range.end - range.start < START_BUFFER_SECONDS) return;
        started = true;
        clearBufferingTimer();
        seekToCushion(range);
        play();
        startLiveSyncTimer();
    }

    function clearBufferingTimer() {
        if (!bufferingTimer) return;
        clearTimeout(bufferingTimer);
        bufferingTimer = null;
    }

    function scheduleBufferingState() {
        if (state !== 'playing' || bufferingTimer) return;
        bufferingTimer = setTimeout(() => {
            bufferingTimer = null;
            if (state === 'playing' && !videoElement.paused
                && videoElement.readyState <= READY_STATE_CURRENT_DATA) {
                setState('buffering');
            }
        }, BUFFERING_DETECTION_GRACE_MS);
    }

    // ── Live sync ──

    function liveSync() {
        if (state !== 'playing' && state !== 'buffering') return;
        const range = getLiveBufferedRange();
        if (!range) return;
        const now = Date.now();

        // The playhead sits outside the live range: in front of a hole before it
        // (see hopToLiveRange), or past its end. Go to the live range.
        const currentTime = videoElement.currentTime;
        if (!hopToLiveRange(range) && currentTime > range.end + 0.05) seekToCushion(range);

        if (switchReserve > 0 && now - lastFillerAt > FILLER_PAUSE_MS) releaseSwitchReserve();

        const ahead = getBufferAheadSeconds();
        const { rate, seekBack } = decideLiveSync({ ahead, target: targetSeconds });
        if (seekBack !== null) seekToCushion(range, seekBack);
        setPlaybackRate(rate);

        // A connection that has behaved for a while earns a smaller cushion.
        if (lastStallAt && now - lastStallAt > TARGET_RELAX_AFTER_MS) {
            targetSeconds = targetAfterQuietPeriod(targetSeconds);
            lastStallAt = now;
        }

        // The playhead not moving with media buffered means playback is wedged
        // (a decoder hiccup, or autoplay that never started): kick it.
        if (!videoElement.paused && Math.abs(currentTime - lastPlayTime) < STALL_TIME_EPSILON_SECONDS
            && lastPlayTime >= 0 && ahead > START_BUFFER_SECONDS) {
            stallTicks += 1;
            if (stallTicks >= STALL_TICKS_BEFORE_KICK) {
                console.warn('[fmp4-player] Playback stuck with media buffered; resuming at the live edge');
                seekToCushion(range);
                play();
                stallTicks = 0;
            }
        } else {
            stallTicks = 0;
        }
        lastPlayTime = currentTime;

        if (videoElement.paused && started && ahead >= START_BUFFER_SECONDS) play();
        if (state === 'buffering' && !videoElement.paused && videoElement.readyState > READY_STATE_CURRENT_DATA) {
            setState('playing');
        }
        trimBuffer();
    }

    function startLiveSyncTimer() {
        if (liveSyncTimer) return;
        liveSyncTimer = setInterval(liveSync, LIVE_SYNC_INTERVAL_MS);
    }

    function stopLiveSyncTimer() {
        if (liveSyncTimer) {
            clearInterval(liveSyncTimer);
            liveSyncTimer = null;
        }
        lastPlayTime = -1;
        stallTicks = 0;
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
                    ? { ...response.init, initSegment: response.initSegment }
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

    function switchSourceBufferType(nextMimeType) {
        if (nextMimeType === mimeType) return true;
        if (typeof sourceBuffer.changeType !== 'function') return false;
        try {
            sourceBuffer.changeType(nextMimeType);
            return true;
        } catch {
            return false;
        }
    }

    function handleMediaInit(data) {
        // data: { format, mimeType, codec, audioCodec, generation, tier, initSegment }
        if (!data.initSegment) {
            console.log('[fmp4-player] media-init without initSegment, requesting...');
            requestCurrentInit({ silentUnavailable: true, retryOnUnavailable: true });
            return;
        }

        clearInitWaiters();
        initTimeoutRetries = 0;

        if (!canPlayRelayFormat(data.mimeType)) {
            mimeType = data.mimeType;
            handleError(RELAY_PLAYBACK_UNSUPPORTED_MESSAGE, new Error(`MediaSource rejected ${data.mimeType}`));
            return;
        }

        // The same init can arrive twice (pushed, and as the reply to a request).
        if (data.generation === currentGeneration && (sourceBuffer || mediaSource)) return;

        // A new generation is the same stream from a restarted encoder (a bitrate
        // change). In sequence mode its fragments simply continue the timeline,
        // so the picture carries on without the player being rebuilt.
        const canContinue = sourceBuffer && mediaSource?.readyState === 'open' && sequenceMode
            && switchSourceBufferType(data.mimeType);
        currentGeneration = data.generation;
        lastSequence = 0;
        mimeType = data.mimeType;
        if (canContinue) {
            // A bitrate change is the server answering the very stalls that grew
            // the cushion, so the cushion starts over with it.
            targetSeconds = TARGET_START_SECONDS;
            switchReserve = 0;
            lastStallAt = 0;
            lastSwitchAt = Date.now();
            clearQueue();
            enqueue(toUint8Array(data.initSegment));
            processQueue();
            return;
        }

        setupMediaSource(data.initSegment);
    }

    /**
     * The server is testing the link with filler (the bytes themselves are
     * thrown away), and a bitrate switch follows if the test goes well. Hold a
     * little more in reserve until that is over: the switch leaves a moment
     * with nothing new, and the test itself can slow delivery down.
     */
    function handleRelayFiller() {
        if (switchReserve === 0) {
            const raised = targetBeforeSwitch(targetSeconds);
            switchReserve = raised - targetSeconds;
            targetSeconds = raised;
        }
        lastFillerAt = Date.now();
    }

    /** The test is over and no switch came, or the switch has happened: the reserve is not needed any more. */
    function releaseSwitchReserve() {
        targetSeconds = Math.max(TARGET_MIN_SECONDS, targetSeconds - switchReserve);
        switchReserve = 0;
    }

    function handleMediaChunk(data) {
        // data: { format, generation, tier, sequence, keyframeStart, chunk }
        if (data.generation !== currentGeneration) return;
        if (typeof data.sequence === 'number' && data.sequence <= lastSequence) return;
        if (typeof data.sequence === 'number') {
            lastSequence = data.sequence;
            // The server times this against when it sent the fragment: it is how
            // it knows how far behind this viewer really is.
            socket.emit('relay-ack', { generation: data.generation, sequence: data.sequence });
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

        enqueue(buffer);
        processQueue();
    }

    // ── MediaSource setup ──

    function setupMediaSource(initSegment) {
        if (mediaSource) {
            cleanupMediaSource();
        }

        mediaSource = createRelayMediaSource(videoElement);
        const objectUrl = URL.createObjectURL(mediaSource);
        videoElement.src = objectUrl;

        const onSourceOpen = () => {
            try {
                const currentSourceBuffer = mediaSource.addSourceBuffer(mimeType);
                sourceBuffer = currentSourceBuffer;
                // Sequence mode lays fragments end to end as they arrive. The
                // server skips fragments for a viewer that falls behind and
                // restarts its encoder to change bitrate; either way the timeline
                // stays continuous instead of growing holes the playhead stops at.
                sequenceMode = false;
                try {
                    currentSourceBuffer.mode = 'sequence';
                    sequenceMode = currentSourceBuffer.mode === 'sequence';
                } catch { }

                const onUpdateEnd = () => {
                    if (sourceBuffer !== currentSourceBuffer) return;
                    isAppending = false;
                    processQueue();
                    maybeStartPlayback();
                };

                const onSourceBufferError = () => {
                    if (sourceBuffer !== currentSourceBuffer) return;
                    console.error('[fmp4-player] SourceBuffer error, attempting recovery');
                    resetAndRequestInit();
                };

                currentSourceBuffer.addEventListener('updateend', onUpdateEnd);
                currentSourceBuffer.addEventListener('error', onSourceBufferError);
                const onPlaybackReady = () => {
                    if (state === 'buffering' || state === 'connecting') setState('playing');
                };
                const onPlaybackWaiting = () => {
                    if (!started || state !== 'playing') return;
                    // Stopped in front of a hole, with media beyond it: not a stall.
                    if (hopToLiveRange()) return;
                    scheduleBufferingState();
                    // Running dry while the server's encoder restarts says
                    // nothing about the connection.
                    if (Date.now() - lastSwitchAt < SWITCH_SETTLE_MS) return;
                    // Playback ran dry: the cushion was too small for this
                    // connection. Keep a bigger one from here on.
                    targetSeconds = targetAfterStall(targetSeconds);
                    lastStallAt = Date.now();
                };
                videoElement.addEventListener('playing', onPlaybackReady);
                videoElement.addEventListener('waiting', onPlaybackWaiting);
                mediaSourceCleanupFns.push(() => {
                    try { currentSourceBuffer.removeEventListener('updateend', onUpdateEnd); } catch { }
                    try { currentSourceBuffer.removeEventListener('error', onSourceBufferError); } catch { }
                    try { videoElement.removeEventListener('playing', onPlaybackReady); } catch { }
                    try { videoElement.removeEventListener('waiting', onPlaybackWaiting); } catch { }
                });

                // Append init segment first
                setState('buffering');
                const initBuffer = toUint8Array(initSegment);
                appendQueue.unshift(initBuffer);
                queueBytes += initBuffer.byteLength;
                processQueue();
            } catch (err) {
                handleError('Failed to create SourceBuffer', err);
            }
        };

        mediaSource.addEventListener('sourceopen', onSourceOpen);
        mediaSourceCleanupFns.push(() => {
            mediaSource.removeEventListener('sourceopen', onSourceOpen);
            URL.revokeObjectURL(objectUrl);
        });
    }

    function cleanupMediaSource() {
        stopLiveSyncTimer();
        clearBufferingTimer();
        clearQueue();
        isAppending = false;
        started = false;
        sequenceMode = false;
        setPlaybackRate(1);

        // Run and clear per-MediaSource teardown (video-element listeners + object
        // URL) so a rebuild doesn't leave stale listeners firing on the shared
        // <video> or leak the previous blob URL.
        mediaSourceCleanupFns.forEach((fn) => { try { fn(); } catch { } });
        mediaSourceCleanupFns = [];

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
                if (mediaSource.readyState === 'open') {
                    mediaSource.endOfStream();
                }
            } catch { }
            mediaSource = null;
        }
    }

    // ── Public API ──

    function start() {
        initTimeoutRetries = 0;
        targetSeconds = TARGET_START_SECONDS;
        switchReserve = 0;
        lastStallAt = 0;
        setState('connecting');

        socket.on('media-init', handleMediaInit);
        socket.on('media-chunk', handleMediaChunk);
        socket.on('relay-filler', handleRelayFiller);

        cleanupFns.push(() => {
            socket.off('media-init', handleMediaInit);
            socket.off('media-chunk', handleMediaChunk);
            socket.off('relay-filler', handleRelayFiller);
        });

        // Request current init segment
        armInitTimeout();
        requestCurrentInit({ silentUnavailable: false, retryOnUnavailable: true });
    }

    function stop() {
        setState('stopped');
        clearInitWaiters();
        initTimeoutRetries = 0;
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
