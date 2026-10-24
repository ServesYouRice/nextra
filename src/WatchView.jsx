import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useSocket } from './context/SocketContext';
import { getDevice, resetDevice, socketRequest } from './lib/mediasoupClient';
import { createFmp4RelayPlayer } from './lib/fmp4RelayPlayer';
import {
    hasWebRtcReceiveCodec,
    isAv1PlaybackUnsupported,
    shouldPreferRelayPlayback,
    RELAY_PLAYBACK_UNSUPPORTED_MESSAGE,
    canPlayRelayFormat,
    createRelayMediaSource,
    isRelayPlaybackUnsupported,
    prepareSourceBufferForGeneration,
} from './lib/watchPlaybackMode.mjs';
import { summarizeConnectionQuality } from './lib/connectionQuality.mjs';
import { createLifecycleController } from './lib/lifecycleController.mjs';
import { useViewerSessionController } from './hooks/useViewerSessionController';
import UserErrorAlert from './components/UserErrorAlert';
import { getLocalStorageSafely, isMediaDebugEnabled } from './lib/mediaDebug.mjs';
import {
    assertAttemptCurrent,
    beginPlaybackAttempt,
    createRecoveryGuard,
    isAttemptCurrent,
    isSupersededAttemptError,
    SupersededAttemptError,
    waitForTransportConnected,
    withDeadline,
} from './lib/playbackAttempt.mjs';
import { createSubscriptionLedger, emitClaimedStart, releaseSubscription } from './lib/subscriptionLedger.mjs';
import { createRelayAppendQueue } from './lib/relayAppendQueue.mjs';
import { abandonStaleJoin, createViewerSession, isStaleViewerSessionError } from './lib/viewerSession.mjs';

const MAX_QUEUE_CHUNKS = 240;
const MAX_QUEUE_BYTES = 24 * 1024 * 1024;
const MEDIA_DEBUG_LOGS = isMediaDebugEnabled(window.location, getLocalStorageSafely(window));

function mediaDebugLog(...args) {
    if (MEDIA_DEBUG_LOGS) {
        console.log(...args);
    }
}

function toUint8ArraySync(data) {
    if (!data) return null;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (Array.isArray(data)) {
        return Uint8Array.from(data);
    }
    if (data?.data instanceof ArrayBuffer) return new Uint8Array(data.data);
    if (ArrayBuffer.isView(data?.data)) {
        return new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength);
    }
    if (Array.isArray(data?.data)) {
        return Uint8Array.from(data.data);
    }
    return null;
}

function normalizeRoomCode(value) {
    return String(value || '').trim().toUpperCase().replace(/-/g, '');
}

// Viewers usually receive a full watch link; accept a pasted URL as well as a
// bare code by pulling the code out of a `#watch/CODE` fragment when present.
function extractRoomCode(value) {
    const text = String(value || '');
    const urlMatch = text.match(/#\/?watch\/([A-Za-z0-9-]+)/i);
    const source = urlMatch ? urlMatch[1] : text;
    return source.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function formatRoomCode(code) {
    return code.length > 3 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

// What a recovery resumes: the viewer's playback before the first recovery of a
// chain reset it (see createRecoveryGuard).
function readResumeIntent(watchingRef, playbackModeRef, fallbackModeRef) {
    return {
        wasWatching: watchingRef.current,
        previousPlaybackMode: playbackModeRef.current,
        wasFallbackMode: fallbackModeRef.current,
    };
}

// The same failure an ack-based socketRequest gives for an unsuccessful answer.
function ackFailure(event, response) {
    if (!response) return new Error(`Request "${event}" failed (empty response)`);
    const error = new Error(response.error || response.message || 'Unknown error');
    Object.assign(error, response);
    return error;
}


export default function WatchView({ initialCode = '' }) {
    const socket = useSocket();
    const [codeInput, setCodeInput] = useState(initialCode);
    const [joined, setJoined] = useState(false);
    const [joinedRoomCode, setJoinedRoomCode] = useState(normalizeRoomCode(initialCode));
    const [watching, setWatching] = useState(false);
    const [error, setError] = useState('');
    const [codeError, setCodeError] = useState(false);
    const [hostDisconnected, setHostDisconnected] = useState(false);
    const [hostReconnectingReason, setHostReconnectingReason] = useState('');
    const [mediaControlStatus, setMediaControlStatus] = useState('');
    const [hasProducer, setHasProducer] = useState(false);
    const [allowMediaControl, setAllowMediaControl] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [joining, setJoining] = useState(false);
    const [passphrase, setPassphrase] = useState('');
    const [passphraseRequired, setPassphraseRequired] = useState(false);
    const [watchLoading, setWatchLoading] = useState(false);
    const [playbackMode, setPlaybackMode] = useState('');
    const [hasTurnServer, setHasTurnServer] = useState(false);
    const [roomHasTurnServer, setRoomHasTurnServer] = useState(false);
    const [ingestMode, setIngestMode] = useState('browser');
    const [relayAllowed, setRelayAllowed] = useState(true);
    const [obsVideoCodec, setObsVideoCodec] = useState(null);
    const [fallbackMode, setFallbackMode] = useState(false); // true when using fMP4 fallback
    const [fallbackState, setFallbackState] = useState(null); // 'connecting'|'buffering'|'playing'|'error'|'stopped'
    const [fallbackCodec, setFallbackCodec] = useState(null);
    const [codecUnsupported, setCodecUnsupported] = useState(false);
    const [whipReconnecting, setWhipReconnecting] = useState(false);
    const [connectionQuality, setConnectionQuality] = useState(null);
    const [isFullscreen, setIsFullscreen] = useState(false);

    const videoRef = useRef(null);
    const passphraseInputRef = useRef(null);
    const deviceRef = useRef(null);
    const recvTransportRef = useRef(null);
    const consumersRef = useRef([]);
    const objectUrlRef = useRef(null);
    const mediaSourceRef = useRef(null);
    const sourceBufferRef = useRef(null);
    const userPausedRef = useRef(false);
    const relayCleanupRef = useRef(null);
    const relaySubscribedRef = useRef(false);
    // The ledger claim of the relay-consume-start whose subscription cleanupPlayback releases.
    const relayClaimRef = useRef(null);
    const relayUnsupportedWarnedRef = useRef(false);
    const mediaStreamRef = useRef(null);
    const fmp4PlayerRef = useRef(null);
    const isEnteringFallbackRef = useRef(false);
    const activePlaybackAttemptRef = useRef(0);
    const joinedRef = useRef(false);
    const joinedRoomCodeRef = useRef(normalizeRoomCode(initialCode));
    const watchingRef = useRef(false);
    const playbackModeRef = useRef('');
    const fallbackModeRef = useRef(false);
    // Which subscription start this viewer sent last, per kind, with its socket.id.
    const [subscriptionLedger] = useState(createSubscriptionLedger);
    // transport-failed and reconnect recoveries run one at a time.
    const [recoveryGuard] = useState(createRecoveryGuard);
    // Which room join is the viewer's current session. Leave Room and the other
    // resets that end the session move it on at once, so a join or rejoin still
    // on its way commits nothing and starts no playback (see viewerSession.mjs).
    const [viewerSession] = useState(createViewerSession);
    const joiningRef = useRef(false);
    const terminalRoomEndedRef = useRef(false);
    // Latches a rejected fallback-consume-start so the auto-enter effect stops
    // retrying. The rejection clears fallbackMode, which would otherwise satisfy
    // the effect's guard again and spin as fast as the socket can round-trip.
    const fallbackStartRejectedRef = useRef(false);

    useEffect(() => {
        if (passphraseRequired) passphraseInputRef.current?.focus();
    }, [passphraseRequired]);

    useEffect(() => {
        const syncFullscreen = () => {
            const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
            setIsFullscreen(fullscreenElement === videoRef.current);
        };
        document.addEventListener('fullscreenchange', syncFullscreen);
        document.addEventListener('webkitfullscreenchange', syncFullscreen);
        return () => {
            document.removeEventListener('fullscreenchange', syncFullscreen);
            document.removeEventListener('webkitfullscreenchange', syncFullscreen);
        };
    }, []);

    const cleanupPlayback = useViewerSessionController({
        socket,
        setPlaybackMode,
        subscriptionLedger,
        refs: {
            activePlaybackAttemptRef,
            fmp4PlayerRef,
            relaySubscribedRef,
            relayClaimRef,
            relayCleanupRef,
            consumersRef,
            recvTransportRef,
            objectUrlRef,
            videoRef,
            mediaStreamRef,
            mediaSourceRef,
            sourceBufferRef,
            userPausedRef,
            relayUnsupportedWarnedRef,
        },
    });

    const syncMutedState = useCallback((muted) => {
        if (videoRef.current) {
            videoRef.current.muted = muted;
        }
        setIsMuted(muted);
    }, []);

    // isCurrent tells a superseded attempt's autoplay retry to leave the shared
    // video element alone.
    const playVideoElement = useCallback(async (stream, isCurrent = () => true) => {
        if (!videoRef.current) throw new Error('Video element not found');

        if (stream) {
            if (videoRef.current.srcObject !== stream) {
                videoRef.current.srcObject = stream;
            }
        }

        if (videoRef.current.volume === 0) {
            videoRef.current.volume = 1;
        }

        try {
            await videoRef.current.play();
        } catch (err) {
            if (err?.name === 'NotAllowedError' && isCurrent() && videoRef.current) {
                syncMutedState(true);
                try {
                    await videoRef.current.play();
                } catch {
                    // Playback may still require an explicit user action.
                }
            }
        }
    }, [syncMutedState]);

    // Each await is followed by an attempt check: a superseded attempt closes the
    // consumer it made and throws SupersededAttemptError instead of writing
    // consumersRef, mediaStreamRef or the video element.
    const consumeProducer = useCallback(async (producerId, attemptId) => {
        const device = deviceRef.current;
        const recvTransport = recvTransportRef.current;
        if (!device || !device.loaded || !recvTransport) return;
        assertAttemptCurrent(attemptId, activePlaybackAttemptRef);

        console.log(`[Nextra] Consuming remote producer ${producerId}...`);
        const response = await socketRequest(socket, 'consume', {
            transportId: recvTransport.id,
            producerId,
            rtpCapabilities: device.rtpCapabilities,
        });
        assertAttemptCurrent(attemptId, activePlaybackAttemptRef);
        const consumerParams = response.params || response;

        const consumer = await recvTransport.consume({
            id: consumerParams.id,
            producerId: consumerParams.producerId,
            kind: consumerParams.kind,
            rtpParameters: consumerParams.rtpParameters,
        });
        const closeIfSuperseded = () => {
            if (isAttemptCurrent(attemptId, activePlaybackAttemptRef)) return;
            try { consumer.close(); } catch { }
            throw new SupersededAttemptError();
        };
        closeIfSuperseded();

        try {
            await socketRequest(socket, 'consumer-resume', { consumerId: consumer.id });
        } catch (err) {
            try { consumer.close(); } catch { }
            throw err;
        }
        closeIfSuperseded();

        // Replace the prior consumer/track of the same kind atomically. OBS may
        // reconnect with a new producer before the old close event arrives.
        const replaced = consumersRef.current.filter((item) => item.kind === consumer.kind);
        replaced.forEach((item) => {
            try { item.close(); } catch { }
            try { item.track?.stop(); } catch { }
        });
        consumersRef.current = consumersRef.current.filter((item) => item.kind !== consumer.kind);
        consumersRef.current.push(consumer);

        const existingTracks = mediaStreamRef.current
            ? mediaStreamRef.current.getTracks().filter((track) => track.kind !== consumer.kind && track.readyState !== 'ended')
            : [];
        const newStream = new MediaStream([...existingTracks, consumer.track]);
        mediaStreamRef.current = newStream;
        if (!videoRef.current) throw new Error('Video element not found');
        // Do not await here: play() on a MediaStream stays pending until media
        // arrives, and with an unreachable connection that is never. The start
        // path's ICE wait must not sit behind it. playVideoElement handles an
        // autoplay denial (muted retry) on its own.
        void playVideoElement(newStream, () => isAttemptCurrent(attemptId, activePlaybackAttemptRef)).catch(() => { });
    }, [socket, playVideoElement]);

    const isTunnelOrigin = /\.trycloudflare\.com$/i.test(window.location.hostname)
        || /\.cloudflare/i.test(window.location.hostname);
    const effectiveTurnAvailability = roomHasTurnServer || hasTurnServer;
    const preferRelayFirst = shouldPreferRelayPlayback({
        isTunnelOrigin,
        hasTurnServer: effectiveTurnAvailability,
        relayAllowed,
    });

    useEffect(() => {
        const onServerConfig = (data = {}) => {
            if (typeof data.hasTurnServer === 'boolean') {
                setHasTurnServer(data.hasTurnServer);
            }
        };

        socket.on('server-config', onServerConfig);
        socket.emit('request-server-config');
        return () => socket.off('server-config', onServerConfig);
    }, [socket]);

    useEffect(() => {
        joinedRef.current = joined;
    }, [joined]);

    useEffect(() => {
        watchingRef.current = watching;
    }, [watching]);

    useEffect(() => {
        playbackModeRef.current = playbackMode;
    }, [playbackMode]);

    useEffect(() => {
        if (!watching || playbackMode !== 'mediasoup') {
            const reset = setTimeout(() => setConnectionQuality(null), 0);
            return () => clearTimeout(reset);
        }
        let active = true;
        const lifecycle = createLifecycleController();
        const sample = async () => {
            try {
                const report = await recvTransportRef.current?.getStats();
                if (!active || !report) return;
                const values = typeof report.values === 'function' ? report.values() : report;
                setConnectionQuality(summarizeConnectionQuality(values));
            } catch {
                if (active) setConnectionQuality(null);
            }
        };
        void sample();
        const interval = setInterval(sample, 5000);
        lifecycle.own('stats-interval', () => clearInterval(interval));
        lifecycle.own('stats-sampler', () => { active = false; });
        return () => lifecycle.close();
    }, [watching, playbackMode]);

    useEffect(() => {
        fallbackModeRef.current = fallbackMode;
    }, [fallbackMode]);

    // `attempt` is the attempt this start runs as when withDeadline began it for
    // the caller; otherwise the start begins its own.
    const startMediasoupPlayback = useCallback(async ({
        forceProbe = false,
        relayAllowedOverride,
        turnAvailableOverride,
        attempt = beginPlaybackAttempt(activePlaybackAttemptRef),
    } = {}) => {
        const canUseRelay = typeof relayAllowedOverride === 'boolean'
            ? relayAllowedOverride
            : relayAllowed;
        const turnAvailable = typeof turnAvailableOverride === 'boolean'
            ? turnAvailableOverride
            : effectiveTurnAvailability;

        const device = deviceRef.current;
        if (!device || !device.loaded) {
            throw new Error('Viewer is not ready yet. Rejoin room and try again.');
        }

        try {
            const { params, iceServers } = await socketRequest(socket, 'create-recv-transport');
            if (!attempt.isCurrent()) {
                // The server made this transport for an attempt nobody owns now, and no
                // ref holds it; close it by id (the server ignores an id it no longer has).
                if (params?.id && socket.connected) socket.emit('close-viewer-transport', { transportId: params.id });
                throw new SupersededAttemptError();
            }
            const recvTransport = device.createRecvTransport({
                ...params,
                iceServers,
            });
            attempt.own(() => recvTransport.close());
            recvTransportRef.current = recvTransport;

            recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                try {
                    await socketRequest(socket, 'connect-transport', {
                        transportId: recvTransport.id,
                        dtlsParameters,
                    });
                    callback();
                } catch (err) {
                    errback(err);
                }
            });

            const { producers = [] } = await socketRequest(socket, 'get-producers');
            attempt.assertCurrent();
            if (!producers.length) {
                throw new Error('Host stream is not ready yet. Try again in a moment.');
            }

            for (const producer of producers) {
                await consumeProducer(producer.producerId, attempt.id);
                attempt.assertCurrent();
            }

            // Wait for the ICE/DTLS connection to actually establish, with a timeout.
            // Tunnel viewers get a very short timeout (2s) — mediasoup WebRTC cannot
            // work through a Cloudflare tunnel (no UDP), so fail fast and fall back
            // to relay playback instead of wasting time on unreachable candidates.
            const shouldFailFastForTunnel = isTunnelOrigin && !turnAvailable && !forceProbe;
            const iceTimeoutMs = shouldFailFastForTunnel ? 2000 : 8000;
            await waitForTransportConnected(recvTransport, {
                timeoutMs: iceTimeoutMs,
                timeoutMessage: shouldFailFastForTunnel
                    ? canUseRelay
                        ? 'WebRTC cannot work through a Cloudflare tunnel (UDP is blocked). A TURN server is required, or use Relay mode instead.'
                        : 'WebRTC cannot work through a Cloudflare tunnel (UDP is blocked). A TURN server is required for this room.'
                    : 'WebRTC connection timed out (ICE could not connect). Try refreshing or check firewall settings.',
                onStateChange: (state) => console.log(`[Nextra] ICE connection state: ${state}`),
            });

            attempt.assertCurrent();

            setPlaybackMode('mediasoup');
            setWatching(true);
            setHostDisconnected(false);
            setHasProducer(true);
        } catch (err) {
            // A superseded attempt closes its own transport and reports only that it
            // was superseded; the refs belong to whoever superseded it.
            throw attempt.settleFailure(err);
        }
    }, [socket, consumeProducer, isTunnelOrigin, effectiveTurnAvailability, relayAllowed]);

    // Every await below is followed by an attempt check before the next shared
    // write. The attempt owns its relay claim from the emit of
    // relay-consume-start until it commits the claim to relayClaimRef (after the
    // acknowledgement, while still current); from then on cleanupPlayback's
    // relay-subscription owner releases it. A superseded attempt revokes its own
    // object URL, never touches the video element or the shared refs, and
    // stops the subscription only if it still owns a claim the ledger lets it
    // release.
    //
    // A relay failure (the append queue falling behind, an append the
    // SourceBuffer refuses or cannot parse, the MediaSource ending or closing, a
    // recorder generation it cannot follow) goes through failRelayGeneration.
    // Before playback is established the start rejects with that failure, so
    // its caller can fall back or report it; afterwards playback ends there, the
    // viewer sees why and gets Watch Stream back.
    const startRelayPlayback = useCallback(async () => {
        const attempt = beginPlaybackAttempt(activePlaybackAttemptRef);
        if (!videoRef.current) throw new Error('Video element not found');

        let mimeType = 'video/webm;codecs=vp8,opus';
        let initResultData;
        let liveInitPayload = null;
        let selectedGeneration = null;
        // This attempt's SourceBuffer, once made.
        let relaySourceBuffer = null;
        let resolveLiveInit = null;
        let firstBufferedSettled = false;
        let resolveFirstBuffered = null;
        let rejectFirstBuffered = null;
        // The relay claim while this attempt, not cleanupPlayback, answers for it.
        let ownedClaim = null;
        // The claim this attempt committed to relayClaimRef.
        let committedClaim = null;

        const firstBufferedPromise = new Promise((resolve, reject) => {
            resolveFirstBuffered = resolve;
            rejectFirstBuffered = reject;
        });
        // Cleanup can settle it before anything awaits it.
        firstBufferedPromise.catch(() => { });

        // Rejects the attempt's own waits (live media-init, sourceopen) as soon as
        // the attempt is cleaned up, instead of leaving them to their timers.
        let rejectCleanedUp = null;
        const cleanedUp = new Promise((_, reject) => { rejectCleanedUp = reject; });
        cleanedUp.catch(() => { });
        const untilCleanedUp = (promise) => {
            // Its own timer may still reject it after the race is over.
            promise.catch(() => { });
            return Promise.race([promise, cleanedUp]);
        };

        const settleFirstBuffered = (err = null) => {
            if (firstBufferedSettled) return;
            firstBufferedSettled = true;
            if (err) rejectFirstBuffered?.(err);
            else resolveFirstBuffered?.();
        };

        let enqueueCount = 0;
        let failRelayGeneration = null;
        let relayCleanupDone = false;
        // Set once the viewer is watching this relay; a failure before that is
        // the start's to report, after it failRelayGeneration ends playback.
        let relayEstablished = false;
        // The failure that ended this attempt.
        let relayFailure = null;
        // The listeners below write the queue and the video element; a cleaned-up
        // or superseded attempt leaves them to the newer owner.
        const ownsPlayback = () => !relayCleanupDone && attempt.isCurrent();
        // After an await: a superseded attempt stops as such, a failed one with its failure.
        const assertRelayRunning = () => {
            attempt.assertCurrent();
            if (relayFailure) throw relayFailure;
        };
        // This attempt's chunks, each kept until the SourceBuffer has taken it.
        const appendQueue = createRelayAppendQueue({
            maxChunks: MAX_QUEUE_CHUNKS,
            maxBytes: MAX_QUEUE_BYTES,
            isActive: ownsPlayback,
            getCurrentTime: () => videoRef.current?.currentTime ?? 0,
            onUpdateEnd: () => {
                const video = videoRef.current;
                if (!video || !relaySourceBuffer || relaySourceBuffer.buffered.length === 0) return;
                settleFirstBuffered();
                const bufferedEnd = relaySourceBuffer.buffered.end(relaySourceBuffer.buffered.length - 1);
                if (!userPausedRef.current && bufferedEnd - video.currentTime > 2.5) {
                    video.currentTime = bufferedEnd - 0.35;
                }
                if (video.paused && !userPausedRef.current) {
                    video.play().catch(() => { });
                }
            },
            onFailure: (failure) => failRelayGeneration?.(failure),
        });
        const enqueueChunk = (buf) => {
            if (!ownsPlayback()) return;
            const uint = toUint8ArraySync(buf);
            if (!uint?.byteLength) {
                if (!relayUnsupportedWarnedRef.current) {
                    relayUnsupportedWarnedRef.current = true;
                    console.warn('[Nextra] Ignoring unsupported relay chunk payload. buf type:', typeof buf, buf?.constructor?.name);
                }
                return;
            }
            enqueueCount += 1;
            if (enqueueCount <= 3) {
                mediaDebugLog(`[Nextra] enqueueChunk #${enqueueCount}: ${uint.byteLength} bytes, queue=${appendQueue.length}`);
            }
            // Past MAX_QUEUE_CHUNKS or MAX_QUEUE_BYTES the queue fails this attempt.
            appendQueue.enqueue(uint);
        };

        let chunkArrivalCount = 0;
        const onChunk = (payload = {}) => {
            if (payload.generation !== selectedGeneration) return;
            const data = payload.chunk;
            chunkArrivalCount += 1;
            if (chunkArrivalCount <= 3 || chunkArrivalCount % 20 === 0) {
                mediaDebugLog(`[Nextra] media-chunk #${chunkArrivalCount} arrived, type=${typeof data}, constructor=${data?.constructor?.name}, size=${data?.size ?? data?.byteLength ?? '?'}`);
            }
            if (data instanceof Blob) {
                // Not reached with this client (binaryType is arraybuffer); if it ever
                // is, a media-init that arrives meanwhile moves the generation on.
                const chunkGeneration = payload.generation;
                data.arrayBuffer()
                    .then((buffer) => {
                        if (chunkGeneration === selectedGeneration) enqueueChunk(buffer);
                    })
                    .catch((err) => {
                        console.warn('[Nextra] Failed to convert relay blob chunk:', err?.message || err);
                    });
            } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || data?.data) {
                enqueueChunk(data);
            } else {
                console.warn('[Nextra] media-chunk: unrecognized data format', typeof data, data?.constructor?.name);
            }
        };

        const onMediaInit = (payload = {}) => {
            if (!ownsPlayback()) return;
            if (!payload?.mimeType || !Number.isSafeInteger(payload.generation) || payload.generation <= 0) return;
            // A new recorder session started — discard any stale chunks from
            // the previous session so the fresh init segment is appended first.
            if (appendQueue.length > 0) {
                mediaDebugLog(`[Nextra] media-init received, flushing ${appendQueue.length} stale chunks`);
            }
            appendQueue.clear();
            // Playing already: the SourceBuffer must start over at the new init.
            if (relaySourceBuffer && !prepareSourceBufferForGeneration(relaySourceBuffer, mediaSourceRef.current, {
                fromMimeType: mimeType,
                toMimeType: payload.mimeType,
            })) {
                failRelayGeneration?.(new Error(canPlayRelayFormat(payload.mimeType)
                    ? 'Relay playback could not follow the new stream and must be restarted.'
                    : RELAY_PLAYBACK_UNSUPPORTED_MESSAGE));
                return;
            }
            selectedGeneration = payload.generation;
            liveInitPayload = payload;
            mimeType = payload.mimeType;
            if (resolveLiveInit) {
                resolveLiveInit(payload);
                resolveLiveInit = null;
            }
        };

        socket.on('media-init', onMediaInit);
        socket.on('media-chunk', onChunk);

        let safetyInterval = null;
        // Without a failure (cleanupPlayback, the start's catch) the attempt's
        // waits end with the generic cleanup errors; a failure ends them with itself.
        const cleanupRelayAttempt = (failure = null) => {
            if (relayCleanupDone) return;
            relayCleanupDone = true;
            socket.off('media-init', onMediaInit);
            socket.off('media-chunk', onChunk);
            if (safetyInterval) {
                clearInterval(safetyInterval);
                safetyInterval = null;
            }
            // Before the MediaSource is torn down, so its sourceclose reports nothing.
            appendQueue.close();
            settleFirstBuffered(failure || new Error('Relay playback was cleaned up before media buffered.'));
            rejectCleanedUp(failure || new Error('Relay playback was cleaned up.'));
        };
        // Stops this attempt's subscription, through the ledger, if this attempt
        // still answers for it: the claim it owns, or the one it committed while
        // relayClaimRef still holds it.
        const releaseOwnRelayClaim = () => {
            if (ownedClaim) {
                releaseSubscription(subscriptionLedger, 'relay', ownedClaim, socket, 'relay-consume-stop');
                ownedClaim = null;
            } else if (committedClaim && relayClaimRef.current === committedClaim) {
                relayClaimRef.current = null;
                relaySubscribedRef.current = false;
                releaseSubscription(subscriptionLedger, 'relay', committedClaim, socket, 'relay-consume-stop');
            }
        };
        failRelayGeneration = (failure) => {
            if (relayCleanupDone) return;
            relayFailure = failure;
            // First, so the start's first-buffered wait ends with this failure and
            // not with the cleanup's generic one.
            settleFirstBuffered(failure);
            cleanupRelayAttempt(failure);
            // A superseded attempt reports nothing; its claim is released in its catch.
            if (!attempt.isCurrent()) return;
            console.warn('[Nextra] Relay playback failed:', failure.message, failure.cause ?? '');
            releaseOwnRelayClaim();
            // Still starting: startRelayPlayback rejects with the failure, and its
            // caller (handleWatch's fallback, a recovery) decides what the viewer sees.
            if (!relayEstablished) return;
            // Playing: tear the relay down and say why; Watch Stream starts it again.
            cleanupPlayback();
            setWatching(false);
            setPlaybackMode('');
            setError(failure.message);
        };
        relayCleanupRef.current = cleanupRelayAttempt;

        try {
            console.log('[Nextra] relay-consume-start…');
            // The claim is recorded in the same synchronous block as the emit; a
            // disconnected socket refuses (the start would go out on the next connection).
            const relayRequest = emitClaimedStart(subscriptionLedger, 'relay', attempt.id, socket, 'relay-consume-start');
            ownedClaim = relayRequest.claim;
            const relayStart = await relayRequest.acknowledged;
            if (!relayStart?.success) {
                // The server refused: this start subscribed nothing, so there is nothing to stop.
                subscriptionLedger.release('relay', ownedClaim);
                ownedClaim = null;
                throw ackFailure('relay-consume-start', relayStart);
            }
            assertRelayRunning();
            console.log('[Nextra] relay-consume-start OK');
            committedClaim = ownedClaim;
            ownedClaim = null;
            relayClaimRef.current = committedClaim;
            relaySubscribedRef.current = true;

            if (relayStart.relayViewerCount > 1 && relayStart.bootstrapComplete === false) {
                throw new Error('Relay playback has been active too long for a safe late join. Rejoin after the current relay viewers leave.');
            }

            try {
                initResultData = await socketRequest(socket, 'get-media-init');
            } catch {
                initResultData = null;
            }
            assertRelayRunning();
            if (initResultData) {
                mediaDebugLog('[Nextra] get-media-init OK:', initResultData?.init?.mimeType || 'no mime');
                if (initResultData.init?.mimeType) {
                    mimeType = initResultData.init.mimeType;
                    selectedGeneration = initResultData.init.generation;
                }
            } else {
                mediaDebugLog('[Nextra] get-media-init not cached yet, waiting for live media-init...');
            }

            // When the relay recorder is prewarmed (tunnel with no TURN), a
            // recorder restart happens when we join.  We MUST wait for the live
            // media-init event before creating the MediaSource — that event
            // flushes stale chunks from the old recorder so the first thing
            // appended to the SourceBuffer is the fresh WebM init segment.
            // Even when get-media-init already returned a mimeType, we still
            // need the live event to synchronise the queue.
            const needsLiveInit = !initResultData?.init?.mimeType
                || !Number.isSafeInteger(initResultData?.init?.generation)
                || (isTunnelOrigin && relayStart.relayViewerCount === 1);

            if (needsLiveInit) {
                const liveInit = liveInitPayload || await untilCleanedUp(new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        cleanupWait();
                        reject(new Error('Relay stream is not ready yet. Try again in a moment.'));
                    }, 7000);

                    const cleanupWait = () => {
                        clearTimeout(timeout);
                        resolveLiveInit = null;
                    };

                    resolveLiveInit = (payload) => {
                        cleanupWait();
                        resolve(payload);
                    };
                }));
                assertRelayRunning();

                if (liveInit?.mimeType) {
                    mimeType = liveInit.mimeType;
                }
                mediaDebugLog('[Nextra] Got live media-init:', mimeType);
            }

            mediaDebugLog('[Nextra] Setting up MediaSource with mime:', mimeType);
            if (!canPlayRelayFormat(mimeType)) {
                throw new Error(RELAY_PLAYBACK_UNSUPPORTED_MESSAGE);
            }

            const mediaSource = createRelayMediaSource(videoRef.current);
            const objectUrl = URL.createObjectURL(mediaSource);
            attempt.own(() => URL.revokeObjectURL(objectUrl));
            mediaSourceRef.current = mediaSource;
            objectUrlRef.current = objectUrl;
            videoRef.current.src = objectUrl;
            videoRef.current.srcObject = null;

            await untilCleanedUp(new Promise((resolve, reject) => {
                mediaSource.addEventListener('sourceopen', resolve, { once: true });
                setTimeout(() => reject(new Error('MediaSource did not open')), 5000);
            }));
            assertRelayRunning();

            const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
            sourceBufferRef.current = sourceBuffer;
            relaySourceBuffer = sourceBuffer;
            try {
                if (sourceBuffer.mode === 'segments') {
                    sourceBuffer.mode = 'sequence';
                }
            } catch (err) {
                console.warn('[Nextra] Could not switch SourceBuffer to sequence mode:', err.message);
            }

            // From here on the SourceBuffer's 'error' and the MediaSource's
            // 'sourceended'/'sourceclose' fail this attempt (see relayAppendQueue.mjs).
            appendQueue.attach(sourceBuffer, mediaSource);

            // The relay-start acknowledgement is ordered before subsequent live
            // chunks. Prepend its bounded snapshot so a later viewer sees the
            // active WebM generation from byte zero without restarting it.
            if (relayStart.relayViewerCount > 1 && relayStart.bootstrapChunks?.length) {
                appendQueue.prepend(relayStart.bootstrapChunks
                    .map(toUint8ArraySync)
                    .filter((chunk) => chunk?.byteLength));
            }

            safetyInterval = setInterval(() => appendQueue.pump(), 200);

            mediaDebugLog('[Nextra] MediaSource ready, waiting for first buffered media...');
            appendQueue.pump();
            // Do not await here: with MSE the play() promise can stay pending
            // until enough media is buffered, which races the outer watch timeout.
            void playVideoElement(null, attempt.isCurrent).catch(() => { });
            await Promise.race([
                firstBufferedPromise,
                new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Relay connected but no playable media buffered.')), 18000);
                }),
            ]);
            // The updateend that buffered the first media can fail the next append
            // before this runs.
            assertRelayRunning();

            relayEstablished = true;
            setPlaybackMode('relay');
            setWatching(true);
            setHostDisconnected(false);
        } catch (err) {
            cleanupRelayAttempt();
            if (relayCleanupRef.current === cleanupRelayAttempt) {
                relayCleanupRef.current = null;
            }
            // A claim this attempt still owns was never committed: stop it now if the
            // ledger allows (no newer start, same connected socket.id). A committed
            // claim is cleanupPlayback's to release.
            if (ownedClaim) {
                releaseSubscription(subscriptionLedger, 'relay', ownedClaim, socket, 'relay-consume-stop');
                ownedClaim = null;
            }
            throw attempt.settleFailure(err);
        }
    }, [socket, playVideoElement, isTunnelOrigin, subscriptionLedger, cleanupPlayback]);

    useEffect(() => {
        if (!joined) return undefined;
        const interval = setInterval(() => socket.emit('heartbeat'), 30000);
        return () => clearInterval(interval);
    }, [joined, socket]);

    useEffect(() => {
        const onRoomEnded = ({ reason } = {}) => {
            terminalRoomEndedRef.current = true;
            // A join still on its way must not bring the ended room back, and no
            // queued recovery may resume it.
            viewerSession.invalidate();
            recoveryGuard.clearFollowUp();
            setHostReconnectingReason('');
            cleanupPlayback();
            setWatching(false);
            setWatchLoading(false);
            setFallbackMode(false);
            setFallbackState(null);
            setWhipReconnecting(false);
            setHostDisconnected(true);
            setError(reason || 'This room ended. Leave it and join a new room to continue.');
        };

        const onHostDisconnected = ({ reason, recoverable } = {}) => {
            if (recoverable) {
                setHostReconnectingReason(reason || 'Host reconnecting...');
                return;
            }
            onRoomEnded({ reason });
        };

        const onHostReconnected = () => {
            terminalRoomEndedRef.current = false;
            fallbackStartRejectedRef.current = false;
            setHostReconnectingReason('');
            setHostDisconnected(false);
            setError('');
        };

        const onNewProducer = async ({ producerId } = {}) => {
            setHasProducer(true);
            setHostDisconnected(false);

            if (!watching || playbackMode !== 'mediasoup') return;

            // The playback that is current now; a newer one after an await is not ours to feed.
            const attemptId = activePlaybackAttemptRef.current;
            try {
                if (producerId) {
                    await consumeProducer(producerId, attemptId);
                } else {
                    const { producers = [] } = await socketRequest(socket, 'get-producers');
                    for (const producer of producers) {
                        await consumeProducer(producer.producerId, attemptId);
                    }
                }
            } catch (err) {
                if (isSupersededAttemptError(err)) return;
                console.warn('[Nextra] Failed to consume new producer:', err.message);
            }
        };

        const onProducerClosed = ({ consumerId }) => {
            console.log('Producer closed for consumer:', consumerId);
            const closed = consumersRef.current.find((consumer) => consumer.id === consumerId);
            if (!closed) return;
            try { closed.close(); } catch { }
            try { closed.track?.stop(); } catch { }
            consumersRef.current = consumersRef.current.filter((consumer) => consumer.id !== consumerId);
            if (mediaStreamRef.current) {
                const remainingTracks = mediaStreamRef.current.getTracks().filter((track) => track !== closed.track && track.readyState !== 'ended');
                mediaStreamRef.current = new MediaStream(remainingTracks);
                if (videoRef.current) videoRef.current.srcObject = mediaStreamRef.current;
            }
        };
        const onWhipStatus = ({ reconnecting }) => setWhipReconnecting(!!reconnecting);
        const onFallbackError = ({ message }) => {
            console.error('[WatchView] Fallback worker failed:', message);
            setFallbackState('error');
        };
        socket.on('host-disconnected', onHostDisconnected);
        socket.on('host-reconnected', onHostReconnected);
        socket.on('new-producer', onNewProducer);
        socket.on('producer-closed', onProducerClosed);
        socket.on('whip-status', onWhipStatus);
        socket.on('fallback-error', onFallbackError);
        socket.on('room-ended', onRoomEnded);
        socket.on('server-restarting', onRoomEnded);

        return () => {
            socket.off('host-disconnected', onHostDisconnected);
            socket.off('host-reconnected', onHostReconnected);
            socket.off('new-producer', onNewProducer);
            socket.off('producer-closed', onProducerClosed);
            socket.off('whip-status', onWhipStatus);
            socket.off('fallback-error', onFallbackError);
            socket.off('room-ended', onRoomEnded);
            socket.off('server-restarting', onRoomEnded);
        };
    }, [socket, watching, playbackMode, consumeProducer, cleanupPlayback, recoveryGuard, viewerSession]);

    useEffect(() => {
        const recoverTransport = async (reason, { wasWatching, previousPlaybackMode }) => {
            cleanupPlayback();
            setWatching(false);
            setHostDisconnected(false);
            setHostReconnectingReason('');
            setPlaybackMode('');
            setFallbackMode(false);
            setFallbackState(null);
            setError(reason || 'Stream connection interrupted. Reconnecting...');

            if (!wasWatching) return;

            setWatchLoading(true);
            try {
                if (previousPlaybackMode === 'relay') {
                    await startRelayPlayback();
                } else {
                    try {
                        await withDeadline(activePlaybackAttemptRef, (attempt) => startMediasoupPlayback({
                            relayAllowedOverride: relayAllowed,
                            turnAvailableOverride: roomHasTurnServer || hasTurnServer,
                            attempt,
                        }));
                    } catch (err) {
                        if (isSupersededAttemptError(err) || relayAllowed === false) throw err;
                        console.warn('[Nextra] Recovered WebRTC transport failed; trying relay:', err.message);
                        cleanupPlayback();
                        await startRelayPlayback();
                    }
                }
                setError('');
            } catch (err) {
                // Whoever superseded the attempt owns the session now.
                if (isSupersededAttemptError(err)) return;
                console.warn('[Nextra] Failed to recover viewer transport:', err.message);
                cleanupPlayback();
                setWatching(false);
                setPlaybackMode('');
                setFallbackMode(false);
                setFallbackState(null);
                setError(err.message || 'Stream connection was interrupted. Click Watch Stream to reconnect.');
            } finally {
                setWatchLoading(false);
            }
        };

        const onTransportFailed = ({ reason, recoverable } = {}) => {
            if (recoverable && joinedRef.current) {
                // A transport failure reported while a recovery runs is dropped: that
                // recovery replaces the transport anyway.
                void recoveryGuard.run('transport-failed', (intent) => recoverTransport(reason, intent), {
                    captureIntent: () => readResumeIntent(watchingRef, playbackModeRef, fallbackModeRef),
                });
                return;
            }

            // The session ends here: a join still on its way must not restore it.
            viewerSession.invalidate();
            recoveryGuard.clearFollowUp();
            cleanupPlayback();
            resetDevice();
            joinedRoomCodeRef.current = '';
            setJoinedRoomCode('');
            setJoined(false);
            setWatching(false);
            setWatchLoading(false);
            setHasProducer(false);
            setHostDisconnected(false);
            setHostReconnectingReason('');
            setPlaybackMode('');
            setIsMuted(false);
            setRoomHasTurnServer(false);
            setIngestMode('browser');
            setRelayAllowed(true);
            setObsVideoCodec(null);
            setFallbackMode(false);
            setFallbackState(null);
            setFallbackCodec(null);
            setCodecUnsupported(false);
            setWhipReconnecting(false);
            setError(reason || 'Stream connection failed. Please rejoin the room.');
        };

        socket.on('transport-failed', onTransportFailed);
        return () => socket.off('transport-failed', onTransportFailed);
    }, [
        socket,
        cleanupPlayback,
        hasTurnServer,
        recoveryGuard,
        relayAllowed,
        roomHasTurnServer,
        startMediasoupPlayback,
        startRelayPlayback,
        viewerSession,
    ]);

    // Joins the room as the viewer session `session` (see viewerSession.mjs) and
    // loads the mediasoup device. The session is checked after every await and
    // before anything is committed to a ref or to state: once it has ended (Leave
    // Room, a room that ended, a newer join) the join commits nothing and throws
    // a StaleViewerSessionError, after undoing its join-room on the server where
    // that is safe (abandonStaleJoin).
    const joinRoomAndLoadDevice = useCallback(async (roomCode, session) => {
        const cleanCode = normalizeRoomCode(roomCode);
        // From the moment join-room is sent the server may hold this viewer in the room.
        let mayBeInRoom = true;
        try {
            let response;
            try {
                response = await socketRequest(socket, 'join-room', { code: cleanCode, passphrase });
            } catch (err) {
                // An answer that refuses the join, or a request that never left, put no viewer in the room.
                if (err?.phase === 'server' || err?.phase === 'connect') mayBeInRoom = false;
                throw err;
            }
            session.assertCurrent();
            const { rtpCapabilities } = await socketRequest(socket, 'get-rtp-capabilities');
            session.assertCurrent();
            const device = await getDevice();
            session.assertCurrent();
            if (!device.loaded) {
                await device.load({ routerRtpCapabilities: rtpCapabilities });
                session.assertCurrent();
            }

            // Nothing below awaits: the session cannot end between the last check and the commit.
            deviceRef.current = device;
            const av1ReceiveSupported = hasWebRtcReceiveCodec(device.rtpCapabilities, 'video/AV1');
            const av1Unsupported = isAv1PlaybackUnsupported({
                obsVideoCodec: response.obsVideoCodec,
                receiveCapabilitiesLoaded: device.loaded,
                av1ReceiveSupported,
            });
            if (av1Unsupported) {
                console.warn('[WatchView] WebRTC receive capabilities do not include video/AV1');
            }
            setCodecUnsupported(av1Unsupported);

            joinedRoomCodeRef.current = cleanCode;
            setJoinedRoomCode(cleanCode);
            terminalRoomEndedRef.current = false;
            fallbackStartRejectedRef.current = false;
            setJoined(true);
            setHasProducer(response.hasProducer || false);
            setAllowMediaControl(response.allowMediaControl === true);
            if (response.ingestMode) setIngestMode(response.ingestMode);
            if (typeof response.relayAllowed === 'boolean') setRelayAllowed(response.relayAllowed);
            if (typeof response.hasRoomTurnServer === 'boolean') setRoomHasTurnServer(response.hasRoomTurnServer);
            if (typeof response.obsVideoCodec === 'string') setObsVideoCodec(response.obsVideoCodec);
            if (response.fallbackCodec) setFallbackCodec(response.fallbackCodec);
            setWhipReconnecting(!!response.whipReconnecting);
            return response;
        } catch (err) {
            // Whatever went wrong, a join whose session has ended reports only that.
            if (session.isCurrent()) throw err;
            // The device module keeps what a stale join loaded; the session's end
            // reset it (unless a newer join is using it).
            if (!session.hasNewerJoin()) resetDevice();
            throw abandonStaleJoin(session, {
                mayBeInRoom,
                leaveRoom: () => { if (socket.connected) socket.emit('leave-room', {}, () => { }); },
            });
        }
    }, [socket, passphrase]);

    const handleJoin = useCallback(async () => {
        terminalRoomEndedRef.current = false;
        if (joiningRef.current) return;
        setError('');
        setCodeError(false);
        setHostDisconnected(false);
        setHostReconnectingReason('');
        setIngestMode('browser');
        setRelayAllowed(true);
        setObsVideoCodec(null);
        setRoomHasTurnServer(false);
        setFallbackMode(false);
        setFallbackState(null);
        setFallbackCodec(null);
        setCodecUnsupported(false);
        setWhipReconnecting(false);

        const code = normalizeRoomCode(codeInput);
        if (code.length !== 6) {
            setCodeError(true);
            setError(code ? 'Enter the full 6-character room code.' : 'Please enter a room code.');
            return;
        }

        // Guard against double-submit (button double-click or Enter+click): a second
        // join-room while the first is in flight previously surfaced a misleading
        // "Already in a room" error. joinRoomAndLoadDevice is async (join + device
        // load); joiningRef (checked at the top of this callback) latches it
        // synchronously, while the joining state drives the disabled/label UI.
        joiningRef.current = true;
        setJoining(true);
        // After the double-submit guard: a second click must not end the join in flight.
        const session = viewerSession.begin();
        try {
            await joinRoomAndLoadDevice(code, session);
        } catch (err) {
            // The session ended while the join ran (a room that ended, a transport
            // failure, the view unmounting): whatever ended it has reset the view.
            if (isStaleViewerSessionError(err) || !session.isCurrent()) return;
            viewerSession.invalidate();
            try {
                await socketRequest(socket, 'leave-room', {}, { timeoutMs: 3000, maxAttempts: 1 });
            } catch { }
            joinedRoomCodeRef.current = '';
            setJoinedRoomCode('');
            setJoined(false);
            if (err.requiresPassphrase) {
                setPassphraseRequired(true);
                setError('');
            } else {
                setError(err);
            }
        } finally {
            joiningRef.current = false;
            setJoining(false);
        }
    }, [codeInput, joinRoomAndLoadDevice, socket, viewerSession]);

    const enterFallbackMode = useCallback(() => {
        if (fmp4PlayerRef.current || isEnteringFallbackRef.current) return;
        isEnteringFallbackRef.current = true;
        setError('');
        setFallbackMode(true);
        setFallbackState('connecting');

        socket.emit('fallback-consume-start', {}, (response) => {
            isEnteringFallbackRef.current = false;

            if (response?.error) {
                console.error('[WatchView] Fallback start error:', response.error);
                fallbackStartRejectedRef.current = true;
                setFallbackMode(false);
                setFallbackState(null);
                setError(response.error);
                return;
            }

            fallbackStartRejectedRef.current = false;

            cleanupPlayback(); // Tear down WebRTC only after the server knows this viewer is switching
            setPlaybackMode('');
            setWatching(false);

            // Provide closure state validity
            if (!videoRef.current) {
                setFallbackMode(false);
                setFallbackState(null);
                return;
            }

            const roomCode = joinedRoomCodeRef.current || normalizeRoomCode(codeInput);
            const player = createFmp4RelayPlayer({
                videoElement: videoRef.current,
                socket,
                roomCode,
                onStateChange: (state) => {
                    setFallbackState(state);
                    // A stale connection error contradicts visibly-playing video.
                    if (state === 'playing') setError('');
                },
                onError: (msg, err) => {
                    console.error('[WatchView] Fallback error:', msg, err);
                    if (isRelayPlaybackUnsupported(msg)) setError(msg);
                },
            });

            fmp4PlayerRef.current = player;
            player.start();
        });
    }, [socket, codeInput, cleanupPlayback]);

    // Auto-enter fallback mode for OBS rooms only when media is actually ready.
    useEffect(() => {
        if (joined && ingestMode === 'obs' && !fallbackMode && !fmp4PlayerRef.current
            && preferRelayFirst && hasProducer && !whipReconnecting && !watching && !watchLoading
            && !terminalRoomEndedRef.current && !fallbackStartRejectedRef.current) {
            enterFallbackMode();
        }
    }, [joined, ingestMode, fallbackMode, enterFallbackMode, preferRelayFirst, hasProducer, whipReconnecting, watching, watchLoading]);

    const exitFallbackMode = useCallback(() => {
        if (fmp4PlayerRef.current) {
            fmp4PlayerRef.current.stop();
            fmp4PlayerRef.current = null;
        }
        isEnteringFallbackRef.current = false;
        socket.emit('fallback-consume-stop');
        setFallbackMode(false);
        setFallbackState(null);
        cleanupPlayback(); // Ensure everything from relay is gone before returning
    }, [socket, cleanupPlayback]);


    const handleTryMediasoup = useCallback(async () => {
        setError('');
        setWatchLoading(true);
        exitFallbackMode();
        
        try {
            // Unlike handleWatch, nothing else bounds this start.
            await withDeadline(activePlaybackAttemptRef, (attempt) => startMediasoupPlayback({
                forceProbe: true,
                attempt,
            }));
        } catch (err) {
            // Superseded by a cleanup or a newer start, which own the session now.
            if (isSupersededAttemptError(err)) return;
            console.warn('[Nextra] Mediasoup override failed:', err.message);
            setError(err.message || 'WebRTC connection failed.');
            cleanupPlayback();
            setWatching(false);
            setPlaybackMode('');
        } finally {
            setWatchLoading(false);
        }
    }, [startMediasoupPlayback, cleanupPlayback, exitFallbackMode]);


    const handleWatch = useCallback(async () => {
        setError('');
        setWatchLoading(true);
        cleanupPlayback();

        // Safety net: never stay in "Connecting..." state for more than 40s total.
        // A browser that cannot play the relay at all is the real cause for a
        // tunnel viewer whose WebRTC fallback then stalls, so keep that message.
        let watchTimedOut = false;
        let relayUnsupportedError = null;
        const watchTimeout = setTimeout(() => {
            watchTimedOut = true;
            cleanupPlayback();
            setWatching(false);
            setWatchLoading(false);
            setError(relayUnsupportedError?.message || 'Connection timed out. Check your network or try again.');
        }, 40000);

        if (preferRelayFirst) {
            try {
                console.log('[Nextra] Starting relay playback first for public tunnel viewer.');
                await startRelayPlayback();
                if (watchTimedOut) return;
                console.log('[Nextra] Relay playback connected.');
            } catch (primaryErr) {
                // A superseded attempt leaves the session to whoever superseded it.
                if (watchTimedOut || isSupersededAttemptError(primaryErr)) return;
                console.warn('[Nextra] Relay-first playback failed; trying WebRTC fallback:', primaryErr.message);
                if (isRelayPlaybackUnsupported(primaryErr)) relayUnsupportedError = primaryErr;
                cleanupPlayback();

                try {
                    console.log('[Nextra] Trying mediasoup fallback.');
                    await startMediasoupPlayback();
                    if (watchTimedOut) return;
                    console.log('[Nextra] Mediasoup fallback connected.');
                } catch (fallbackErr) {
                    if (watchTimedOut || isSupersededAttemptError(fallbackErr)) return;
                    cleanupPlayback();
                    setWatching(false);
                    console.error('[Nextra] Secondary playback attempt failed:', fallbackErr.message);
                    setError(relayUnsupportedError?.message || fallbackErr.message || primaryErr.message || 'Failed to start watching.');
                }
            } finally {
                clearTimeout(watchTimeout);
                if (!watchTimedOut) {
                    setWatchLoading(false);
                }
            }
            return;
        }

        try {
            console.log('[Nextra] Starting mediasoup playback…');
            await startMediasoupPlayback();
            if (watchTimedOut) return;
            console.log('[Nextra] Mediasoup playback connected.');
        } catch (primaryErr) {
            if (watchTimedOut || isSupersededAttemptError(primaryErr)) return;
            if (!relayAllowed) {
                cleanupPlayback();
                setWatching(false);
                setError(primaryErr.message || 'Failed to start watching.');
                return;
            }
            console.warn('[Nextra] Primary playback failed; trying relay fallback:', primaryErr.message);
            cleanupPlayback();

            try {
                console.log('[Nextra] Starting relay playback…');
                await startRelayPlayback();
                if (watchTimedOut) return;
                console.log('[Nextra] Relay playback connected.');
            } catch (fallbackErr) {
                if (watchTimedOut || isSupersededAttemptError(fallbackErr)) return;
                cleanupPlayback();
                setWatching(false);
                console.error('[Nextra] Relay fallback also failed:', fallbackErr.message);
                setError(fallbackErr.message || primaryErr.message || 'Failed to start watching.');
            }
        } finally {
            clearTimeout(watchTimeout);
            if (!watchTimedOut) {
                setWatchLoading(false);
            }
        }
    }, [cleanupPlayback, preferRelayFirst, relayAllowed, startMediasoupPlayback, startRelayPlayback]);

    const handleToggleMedia = useCallback(async () => {
        setMediaControlStatus('');
        try {
            await socketRequest(socket, 'toggle_media');
            setMediaControlStatus('Media command sent.');
        } catch (err) {
            setMediaControlStatus(err.message);
        }
        setTimeout(() => setMediaControlStatus(''), 3500);
    }, [socket]);

    const handleLeave = useCallback(async () => {
        // Before the first await: a join or rejoin still on its way (a reconnect
        // can be rejoining while this view stays usable) must find its session
        // over when it finishes, not restore the room this leaves, and no queued
        // recovery may resume it either.
        viewerSession.invalidate();
        recoveryGuard.clearFollowUp();
        try {
            await socketRequest(socket, 'leave-room', {}, { timeoutMs: 5000, maxAttempts: 1 });
        } catch (err) {
            console.warn('[Nextra] leave-room failed:', err.message);
        }

        cleanupPlayback();
        terminalRoomEndedRef.current = false;
        resetDevice();
        joinedRoomCodeRef.current = '';
        setJoinedRoomCode('');
        setJoined(false);
        setWatching(false);
        // A rejoin that this leave outlived sets it and, being stale, never clears it.
        setWatchLoading(false);
        setHasProducer(false);
        setHostDisconnected(false);
        setHostReconnectingReason('');
        setError('');
        setPlaybackMode('');
        setIsMuted(false);
        setRoomHasTurnServer(false);
        setIngestMode('browser');
        setRelayAllowed(true);
        setObsVideoCodec(null);
        setFallbackMode(false);
        setFallbackState(null);
        setFallbackCodec(null);
        setCodecUnsupported(false);
        setWhipReconnecting(false);
    }, [cleanupPlayback, recoveryGuard, socket, viewerSession]);

    useEffect(() => {
        const rejoinAfterReconnect = async ({ wasWatching, previousPlaybackMode, wasFallbackMode }) => {
            if (!joinedRef.current || terminalRoomEndedRef.current) return;
            // The session was ended (Leave Room is waiting for its answer, ...):
            // there is nothing left to rejoin.
            if (!viewerSession.active) return;
            const roomCode = joinedRoomCodeRef.current || normalizeRoomCode(codeInput);
            if (!roomCode) return;

            console.warn('[Nextra] Socket reconnected while in a room - rejoining viewer session.');
            const session = viewerSession.begin();

            cleanupPlayback();
            resetDevice();
            setWatching(false);
            setHostDisconnected(false);
            setHostReconnectingReason('');
            setPlaybackMode('');
            setFallbackMode(false);
            setFallbackState(null);
            setWhipReconnecting(false);
            if (wasWatching || wasFallbackMode) {
                setWatchLoading(true);
                setError('Connection interrupted. Reconnecting...');
            }

            try {
                // Throws a StaleViewerSessionError, with nothing committed, when the
                // session ended meanwhile; then there is nothing to resume.
                const response = await joinRoomAndLoadDevice(roomCode, session);
                setError('');

                if ((wasWatching || wasFallbackMode) && response.hasProducer) {
                    try {
                        if (wasFallbackMode) {
                            enterFallbackMode();
                        } else if (previousPlaybackMode === 'relay') {
                            await startRelayPlayback();
                        } else {
                            try {
                                await withDeadline(activePlaybackAttemptRef, (attempt) => startMediasoupPlayback({
                                    relayAllowedOverride: response.relayAllowed,
                                    turnAvailableOverride: !!response.hasRoomTurnServer || hasTurnServer,
                                    attempt,
                                }));
                            } catch (err) {
                                // A session that ended meanwhile starts no relay either.
                                if (isSupersededAttemptError(err) || !session.isCurrent() || response.relayAllowed === false) throw err;
                                console.warn('[Nextra] Reconnected WebRTC playback failed; trying relay:', err.message);
                                cleanupPlayback();
                                await startRelayPlayback();
                            }
                        }
                    } catch (err) {
                        // Whoever superseded the attempt, or ended the session, owns the view now.
                        if (isSupersededAttemptError(err) || !session.isCurrent()) return;
                        console.warn('[Nextra] Rejoined room but could not resume playback:', err.message);
                        cleanupPlayback();
                        setWatching(false);
                        setPlaybackMode('');
                        setFallbackMode(false);
                        setFallbackState(null);
                        setError(err.message || 'Reconnected. Click Watch Stream to resume playback.');
                    }
                }
            } catch (err) {
                // The session ended while the join ran (Leave Room, a room that
                // ended, ...): whatever ended it has reset the view, and a newer
                // join may be using it now.
                if (isStaleViewerSessionError(err) || !session.isCurrent()) return;
                console.warn('[Nextra] Failed to rejoin viewer session after reconnect:', err.message);
                viewerSession.invalidate();
                cleanupPlayback();
                resetDevice();
                joinedRoomCodeRef.current = '';
                setJoinedRoomCode('');
                setJoined(false);
                setWatching(false);
                setWatchLoading(false);
                setHasProducer(false);
                setHostDisconnected(false);
                setHostReconnectingReason('');
                setPlaybackMode('');
                setIsMuted(false);
                setRoomHasTurnServer(false);
                setIngestMode('browser');
                setRelayAllowed(true);
                setObsVideoCodec(null);
                setFallbackMode(false);
                setFallbackState(null);
                setFallbackCodec(null);
                setCodecUnsupported(false);
                setWhipReconnecting(false);
                setError('Connection was lost. Please rejoin the room.');
            } finally {
                // A session that ended meanwhile cleared this itself.
                if (session.isCurrent()) setWatchLoading(false);
            }
        };

        const onReconnect = () => {
            // A reconnect during a recovery is not dropped: the new socket.id must
            // rejoin the room. It runs once, after the recovery in progress.
            void recoveryGuard.run('reconnect', rejoinAfterReconnect, {
                followUp: true,
                captureIntent: () => readResumeIntent(watchingRef, playbackModeRef, fallbackModeRef),
            });
        };

        socket.on('connect', onReconnect);
        return () => socket.off('connect', onReconnect);
    }, [
        socket,
        codeInput,
        cleanupPlayback,
        enterFallbackMode,
        hasTurnServer,
        joinRoomAndLoadDevice,
        recoveryGuard,
        startMediasoupPlayback,
        startRelayPlayback,
        viewerSession,
    ]);

    useEffect(() => () => {
        // Closed, not just ended: the socket belongs to whichever view comes next,
        // so a join still on its way must not send a leave for it afterwards.
        viewerSession.close();
        if (fmp4PlayerRef.current) {
            fmp4PlayerRef.current.stop();
            fmp4PlayerRef.current = null;
        }
        socket.emit('leave-room');
        cleanupPlayback();
        resetDevice();
    }, [cleanupPlayback, socket, viewerSession]);

    const playbackStatus = fallbackMode
        ? `Relay Mode (${fallbackCodec || 'unknown'}) - ${fallbackState || 'initializing'}`
        : watching && playbackMode === 'relay'
            ? 'Compatibility relay mode active (higher latency).'
            : watching
                ? ingestMode === 'obs'
                    ? 'OBS WebRTC mode active (lowest latency).'
                    : 'WebRTC mode active (lowest latency).'
                : '';
    return (
        <div className="view-container">
            <div className="view-header">
                <h1>Watch</h1>
                <p className="subtitle">Join a room to watch a stream</p>
            </div>

            <UserErrorAlert error={error} id="watchError" />

            {!joined ? (
                <div className="join-form">
                    <div className="join-field">
                        <label className="input-label" htmlFor="roomCode">Room code</label>
                        <div className="input-group">
                            <input
                                id="roomCode"
                                type="text"
                                className="input-code"
                                placeholder="XXX-XXX"
                                value={codeInput}
                                onChange={(evt) => {
                                    setCodeError(false);
                                    setPassphraseRequired(false);
                                    setPassphrase('');
                                    setCodeInput(formatRoomCode(extractRoomCode(evt.target.value)));
                                }}
                                onKeyDown={(evt) => evt.key === 'Enter' && !joining && handleJoin()}
                                autoFocus
                                aria-describedby={error ? 'joinHint watchError' : 'joinHint'}
                                aria-invalid={codeError || undefined}
                                aria-busy={joining || undefined}
                                disabled={joining}
                            />
                            <button
                                className="btn btn-primary"
                                onClick={handleJoin}
                                disabled={joining}
                                aria-busy={joining || undefined}
                            >
                                {joining ? 'Joining...' : 'Join Room'}
                            </button>
                        </div>
                    </div>
                    {passphraseRequired && (
                        <div className="join-field">
                            <p className="alert alert-info" role="status">
                                This room requires a passphrase. The room code has been kept; enter the passphrase to continue.
                            </p>
                            <label className="input-label" htmlFor="roomPassphrase">Room passphrase</label>
                            <input
                                ref={passphraseInputRef}
                                id="roomPassphrase"
                                type="password"
                                className="input-code"
                                value={passphrase}
                                onChange={(evt) => setPassphrase(evt.target.value)}
                                onKeyDown={(evt) => evt.key === 'Enter' && !joining && handleJoin()}
                                autoComplete="current-password"
                                disabled={joining}
                                aria-busy={joining || undefined}
                            />
                        </div>
                    )}
                    <p className="join-hint" id="joinHint" role="status">
                        {(() => {
                            const codeLength = normalizeRoomCode(codeInput).length;
                            return codeLength > 0 && codeLength < 6
                                ? `${codeLength}/6 characters`
                                : 'Enter the 6-character room code, or paste the watch link you were sent.';
                        })()}
                    </p>
                </div>
            ) : (
                <>
                    <div className="video-container watch-video">
                        <video
                            ref={videoRef}
                            className="video-player"
                            controls
                            autoPlay
                            playsInline
                            muted={isMuted}
                            onPlay={() => { userPausedRef.current = false; }}
                            onPause={() => { userPausedRef.current = true; }}
                            onVolumeChange={(evt) => setIsMuted(evt.target.muted)}
                        />

                        {!watching && !hostDisconnected && !fallbackMode && (
                            <div className="video-overlay">
                                {hasProducer ? (
                                    <button
                                        className="btn btn-primary btn-large pulse"
                                        onClick={handleWatch}
                                        disabled={watchLoading}
                                    >
                                        {watchLoading ? 'Connecting...' : 'Watch Stream'}
                                    </button>
                                ) : (
                                    <>
                                        <p>Waiting for host to start sharing...</p>
                                        <p className="video-overlay-sub">
                                            You&apos;re in room {formatRoomCode(joinedRoomCode)}.
                                            A <strong>Watch Stream</strong> button appears here once the host&apos;s media starts.
                                        </p>
                                    </>
                                )}
                            </div>
                        )}

                        {hostReconnectingReason && !hostDisconnected && (
                            <div className="video-overlay">
                                <p>{hostReconnectingReason}</p>
                            </div>
                        )}

                        {hostDisconnected && (
                            <div className="video-overlay">
                                <p className="host-ended">
                                    This room has ended
                                </p>
                            </div>
                        )}
                    </div>

                    {whipReconnecting && (
                        <div className="alert alert-warning" role="status">
                            OBS disconnected — waiting for reconnection...
                        </div>
                    )}

                    {ingestMode === 'obs' && obsVideoCodec === 'av1' && codecUnsupported && (
                        <div className="alert alert-error" role="alert">
                            This browser&apos;s WebRTC receive capabilities do not include video/AV1. This AV1 room has no relay fallback.
                        </div>
                    )}

                    <div className="controls">
                        {(watching || fallbackMode) && (
                            <button
                                className={`btn ${isMuted ? 'btn-primary' : 'btn-secondary'}`}
                                onClick={() => {
                                    if (!videoRef.current) return;
                                    syncMutedState(!videoRef.current.muted);
                                }}
                            >
                                {isMuted ? 'Unmute Audio' : 'Mute Audio'}
                            </button>
                        )}

                        {(watching || fallbackMode) && allowMediaControl && (
                            <button className="btn btn-secondary" onClick={handleToggleMedia}>
                                Play/Pause Host Media
                            </button>
                        )}

                        {(watching || fallbackMode) && (
                            <button
                                className="btn btn-primary"
                                type="button"
                                aria-pressed={isFullscreen}
                                onClick={async () => {
                                    const player = videoRef.current;
                                    if (!player) return;
                                    try {
                                        if (isFullscreen) {
                                            if (document.exitFullscreen) await document.exitFullscreen();
                                            else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
                                        } else if (player.requestFullscreen) await player.requestFullscreen();
                                        else if (player.webkitRequestFullscreen) await player.webkitRequestFullscreen();
                                        else if (player.msRequestFullscreen) await player.msRequestFullscreen();
                                    } catch (err) {
                                        setError(err);
                                    }
                                }}
                            >
                                {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                            </button>
                        )}

                        {watching && !fallbackMode && playbackMode === 'mediasoup' && ingestMode === 'obs' && relayAllowed && !codecUnsupported && (
                            <button className="btn btn-secondary" onClick={enterFallbackMode}>
                                Switch to Relay Mode
                            </button>
                        )}
                        {fallbackMode && (
                            <button className="btn btn-primary" onClick={handleTryMediasoup} disabled={watchLoading}>
                                Try WebRTC
                            </button>
                        )}

                        <button className="btn btn-outline" onClick={handleLeave}>
                            Leave Room
                        </button>

                    </div>

                    {playbackStatus && <div className="media-status" role="status">{playbackStatus}</div>}

                    {connectionQuality && (
                        <details className="connection-quality">
                            <summary>Connection quality: {connectionQuality.quality}</summary>
                            <span>RTT {connectionQuality.rttMs == null ? 'n/a' : `${connectionQuality.rttMs.toFixed(0)} ms`}</span>
                            <span>Jitter {connectionQuality.jitterMs == null ? 'n/a' : `${connectionQuality.jitterMs.toFixed(1)} ms`}</span>
                            <span>Packets lost {connectionQuality.packetsLost}</span>
                        </details>
                    )}

                    {mediaControlStatus && (
                        <div className="media-status" role="status">{mediaControlStatus}</div>
                    )}
                </>
            )}
        </div>
    );
}
