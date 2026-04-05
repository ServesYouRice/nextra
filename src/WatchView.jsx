import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useSocket } from './context/SocketContext';
import { getDevice, resetDevice, socketRequest } from './lib/mediasoupClient';
import { createFmp4RelayPlayer } from './lib/fmp4RelayPlayer';

const MAX_QUEUE_CHUNKS = 240;
const MAX_QUEUE_BYTES = 24 * 1024 * 1024;

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


export default function WatchView({ initialCode = '' }) {
    const socket = useSocket();
    const [codeInput, setCodeInput] = useState(initialCode);
    const [joined, setJoined] = useState(false);
    const [watching, setWatching] = useState(false);
    const [error, setError] = useState('');
    const [hostDisconnected, setHostDisconnected] = useState(false);
    const [hostReconnectingReason, setHostReconnectingReason] = useState('');
    const [mediaControlStatus, setMediaControlStatus] = useState('');
    const [hasProducer, setHasProducer] = useState(false);
    const [allowMediaControl, setAllowMediaControl] = useState(true);
    const [isMuted, setIsMuted] = useState(false);
    const [watchLoading, setWatchLoading] = useState(false);
    const [playbackMode, setPlaybackMode] = useState('');
    const [hasTurnServer, setHasTurnServer] = useState(false);
    const [ingestMode, setIngestMode] = useState('browser');
    const [fallbackMode, setFallbackMode] = useState(false); // true when using fMP4 fallback
    const [fallbackState, setFallbackState] = useState(null); // 'connecting'|'buffering'|'playing'|'error'|'stopped'
    const [fallbackCodec, setFallbackCodec] = useState(null);
    const [codecUnsupported, setCodecUnsupported] = useState(false);
    const [whipReconnecting, setWhipReconnecting] = useState(false);

    const videoRef = useRef(null);
    const deviceRef = useRef(null);
    const recvTransportRef = useRef(null);
    const consumersRef = useRef([]);
    const objectUrlRef = useRef(null);
    const mediaSourceRef = useRef(null);
    const sourceBufferRef = useRef(null);
    const chunkQueueRef = useRef([]);
    const queuedBytesRef = useRef(0);
    const userPausedRef = useRef(false);
    const relayCleanupRef = useRef(null);
    const relaySubscribedRef = useRef(false);
    const relayUnsupportedWarnedRef = useRef(false);
    const mediaStreamRef = useRef(null);
    const fmp4PlayerRef = useRef(null);
    const isEnteringFallbackRef = useRef(false);
    const activePlaybackAttemptRef = useRef(0);

    const cleanupPlayback = useCallback(() => {
        activePlaybackAttemptRef.current += 1;

        if (fmp4PlayerRef.current) {
            fmp4PlayerRef.current.stop();
            fmp4PlayerRef.current = null;
        }

        if (relaySubscribedRef.current) {
            relaySubscribedRef.current = false;
            socket.emit('relay-consume-stop');
        }

        if (relayCleanupRef.current) {
            try { relayCleanupRef.current(); } catch { }
            relayCleanupRef.current = null;
        }

        consumersRef.current.forEach((consumer) => {
            try { consumer.close(); } catch { }
        });
        consumersRef.current = [];

        if (recvTransportRef.current) {
            const transportId = recvTransportRef.current.id;
            try {
                socket.emit('close-viewer-transport', { transportId });
            } catch { }
            try { recvTransportRef.current.close(); } catch { }
            recvTransportRef.current = null;
        }

        if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
        }

        if (videoRef.current) {
            videoRef.current.src = '';
            videoRef.current.srcObject = null;
        }

        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach((track) => {
                try { track.stop(); } catch { }
            });
            mediaStreamRef.current = null;
        }

        mediaSourceRef.current = null;
        sourceBufferRef.current = null;
        chunkQueueRef.current = [];
        queuedBytesRef.current = 0;
        userPausedRef.current = false;
        relayUnsupportedWarnedRef.current = false;
        setPlaybackMode('');
    }, [socket]);

    const syncMutedState = useCallback((muted) => {
        if (videoRef.current) {
            videoRef.current.muted = muted;
        }
        setIsMuted(muted);
    }, []);

    const playVideoElement = useCallback(async (stream) => {
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
            if (err?.name === 'NotAllowedError') {
                syncMutedState(true);
                try {
                    await videoRef.current.play();
                } catch {
                    // Playback may still require an explicit user action.
                }
            }
        }
    }, [syncMutedState]);

    const consumeProducer = useCallback(async (producerId, attemptId) => {
        const device = deviceRef.current;
        if (!device || !device.loaded || !recvTransportRef.current) return;

        console.log(`[Nextra] Consuming remote producer ${producerId}...`);
        const response = await socketRequest(socket, 'consume', {
            transportId: recvTransportRef.current.id,
            producerId,
            rtpCapabilities: device.rtpCapabilities,
        });
        const consumerParams = response.params || response;

        if (activePlaybackAttemptRef.current !== attemptId) return;

        const consumer = await recvTransportRef.current.consume({
            id: consumerParams.id,
            producerId: consumerParams.producerId,
            kind: consumerParams.kind,
            rtpParameters: consumerParams.rtpParameters,
        });

        if (activePlaybackAttemptRef.current !== attemptId) return;

        consumersRef.current.push(consumer);

        const existingTracks = mediaStreamRef.current ? mediaStreamRef.current.getTracks() : [];
        const newStream = new MediaStream([...existingTracks, consumer.track]);
        mediaStreamRef.current = newStream;

        try {
            await socketRequest(socket, 'consumer-resume', { consumerId: consumer.id });
        } catch (err) {
            try { consumer.close(); } catch { }
            consumersRef.current = consumersRef.current.filter((c) => c.id !== consumer.id);
            throw err;
        }
        await playVideoElement(newStream);
    }, [socket, playVideoElement]);

    const isTunnelOrigin = /\.trycloudflare\.com$/i.test(window.location.hostname)
        || /\.cloudflare/i.test(window.location.hostname);
    const preferRelayFirst = isTunnelOrigin && !hasTurnServer;

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

    const startMediasoupPlayback = useCallback(async ({ forceProbe = false } = {}) => {
        const attemptId = ++activePlaybackAttemptRef.current;
        const device = deviceRef.current;
        if (!device || !device.loaded) {
            throw new Error('Viewer is not ready yet. Rejoin room and try again.');
        }

        const { params, iceServers } = await socketRequest(socket, 'create-recv-transport');
        const recvTransport = device.createRecvTransport({
            ...params,
            iceServers,
        });
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
        if (!producers.length) {
            throw new Error('Host stream is not ready yet. Try again in a moment.');
        }

        if (activePlaybackAttemptRef.current !== attemptId) return;

        for (const producer of producers) {
            await consumeProducer(producer.producerId, attemptId);
        }

        // Wait for the ICE/DTLS connection to actually establish, with a timeout.
        // Tunnel viewers get a very short timeout (2s) — mediasoup WebRTC cannot
        // work through a Cloudflare tunnel (no UDP), so fail fast and fall back
        // to relay playback instead of wasting time on unreachable candidates.
        const shouldFailFastForTunnel = isTunnelOrigin && !hasTurnServer && !forceProbe;
        const iceTimeoutMs = shouldFailFastForTunnel ? 2000 : 8000;
        const connectionState = recvTransport.connectionState;
        if (connectionState !== 'connected') {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    cleanup();
                    reject(new Error(
                        shouldFailFastForTunnel
                            ? 'WebRTC cannot work through a Cloudflare tunnel (UDP is blocked). A TURN server is required, or use Relay mode instead.'
                            : 'WebRTC connection timed out (ICE could not connect). Try refreshing or check firewall settings.'
                    ));
                }, iceTimeoutMs);

                const cleanup = () => {
                    clearTimeout(timeout);
                    recvTransport.off('connectionstatechange', onStateChange);
                };

                const onStateChange = (state) => {
                    console.log(`[Nextra] ICE connection state: ${state}`);
                    if (state === 'connected') {
                        cleanup();
                        resolve();
                    } else if (state === 'failed' || state === 'closed') {
                        cleanup();
                        reject(new Error(`WebRTC connection ${state}.`));
                    }
                };

                recvTransport.on('connectionstatechange', onStateChange);
            });
        }

        if (activePlaybackAttemptRef.current !== attemptId) return;

        setPlaybackMode('mediasoup');
        setWatching(true);
        setHostDisconnected(false);
        setHasProducer(true);
    }, [socket, consumeProducer, isTunnelOrigin, hasTurnServer]);

    const startRelayPlayback = useCallback(async () => {
        const attemptId = ++activePlaybackAttemptRef.current;
        if (!videoRef.current) throw new Error('Video element not found');

        console.log('[Nextra] relay-consume-start…');
        await socketRequest(socket, 'relay-consume-start');
        console.log('[Nextra] relay-consume-start OK');
        relaySubscribedRef.current = true;

        chunkQueueRef.current = [];
        queuedBytesRef.current = 0;
        let appendingLock = false;
        let mimeType = 'video/webm;codecs=vp8,opus';
        let initResultData = null;
        let liveInitPayload = null;
        let resolveLiveInit = null;
        let firstBufferedSettled = false;
        let resolveFirstBuffered = null;
        let rejectFirstBuffered = null;

        const firstBufferedPromise = new Promise((resolve, reject) => {
            resolveFirstBuffered = resolve;
            rejectFirstBuffered = reject;
        });

        const settleFirstBuffered = (err = null) => {
            if (firstBufferedSettled) return;
            firstBufferedSettled = true;
            if (err) rejectFirstBuffered?.(err);
            else resolveFirstBuffered?.();
        };

        let enqueueCount = 0;
        const enqueueChunk = (buf) => {
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
                console.log(`[Nextra] enqueueChunk #${enqueueCount}: ${uint.byteLength} bytes, queue=${chunkQueueRef.current.length}`);
            }

            chunkQueueRef.current.push(uint);
            queuedBytesRef.current += uint.byteLength;

            while (
                chunkQueueRef.current.length > MAX_QUEUE_CHUNKS
                || queuedBytesRef.current > MAX_QUEUE_BYTES
            ) {
                const dropped = chunkQueueRef.current.shift();
                if (!dropped) break;
                queuedBytesRef.current -= dropped.byteLength;
            }

            if (
                sourceBufferRef.current
                && mediaSourceRef.current?.readyState === 'open'
                && !appendingLock
                && !sourceBufferRef.current.updating
            ) {
                processQueue();
            }
        };

        let chunkArrivalCount = 0;
        const onChunk = (data) => {
            chunkArrivalCount += 1;
            if (chunkArrivalCount <= 3 || chunkArrivalCount % 20 === 0) {
                console.log(`[Nextra] media-chunk #${chunkArrivalCount} arrived, type=${typeof data}, constructor=${data?.constructor?.name}, size=${data?.size ?? data?.byteLength ?? '?'}`);
            }
            if (data instanceof Blob) {
                data.arrayBuffer()
                    .then(enqueueChunk)
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
            if (!payload?.mimeType) return;
            // A new recorder session started — discard any stale chunks from
            // the previous session so the fresh init segment is appended first.
            if (chunkQueueRef.current.length > 0) {
                console.log(`[Nextra] media-init received, flushing ${chunkQueueRef.current.length} stale chunks`);
                chunkQueueRef.current.length = 0;
                queuedBytesRef.current = 0;
            }
            liveInitPayload = payload;
            mimeType = payload.mimeType;
            if (resolveLiveInit) {
                resolveLiveInit(payload);
                resolveLiveInit = null;
            }
        };

        const processQueue = () => {
            if (appendingLock || !sourceBufferRef.current || sourceBufferRef.current.updating) return;
            if (!chunkQueueRef.current.length) return;
            if (mediaSourceRef.current?.readyState !== 'open') return;

            try {
                appendingLock = true;
                const nextChunk = chunkQueueRef.current.shift();
                if (!nextChunk) {
                    appendingLock = false;
                    return;
                }

                queuedBytesRef.current = Math.max(0, queuedBytesRef.current - nextChunk.byteLength);
                sourceBufferRef.current.appendBuffer(nextChunk);
            } catch (appendErr) {
                console.warn('[Nextra] appendBuffer error:', appendErr.message);
                appendingLock = false;
            }
        };

        socket.on('media-init', onMediaInit);
        socket.on('media-chunk', onChunk);

        let safetyInterval = null;
        let relayCleanupDone = false;
        const cleanupRelayAttempt = () => {
            if (relayCleanupDone) return;
            relayCleanupDone = true;
            socket.off('media-init', onMediaInit);
            socket.off('media-chunk', onChunk);
            if (safetyInterval) {
                clearInterval(safetyInterval);
                safetyInterval = null;
            }
            settleFirstBuffered(new Error('Relay playback was cleaned up before media buffered.'));
        };
        relayCleanupRef.current = cleanupRelayAttempt;

        try {
            try {
                initResultData = await socketRequest(socket, 'get-media-init');
                console.log('[Nextra] get-media-init OK:', initResultData?.init?.mimeType || 'no mime');
                if (initResultData.init?.mimeType) {
                    mimeType = initResultData.init.mimeType;
                }
            } catch {
                console.log('[Nextra] get-media-init not cached yet, waiting for live media-init…');
            }

            // When the relay recorder is prewarmed (tunnel with no TURN), a
            // recorder restart happens when we join.  We MUST wait for the live
            // media-init event before creating the MediaSource — that event
            // flushes stale chunks from the old recorder so the first thing
            // appended to the SourceBuffer is the fresh WebM init segment.
            // Even when get-media-init already returned a mimeType, we still
            // need the live event to synchronise the queue.
            const needsLiveInit = !initResultData?.init?.mimeType || isTunnelOrigin;

            if (needsLiveInit) {
                const liveInit = liveInitPayload || await new Promise((resolve, reject) => {
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
                });

                if (liveInit?.mimeType) {
                    mimeType = liveInit.mimeType;
                }
                console.log('[Nextra] Got live media-init:', mimeType);
            }

            console.log('[Nextra] Setting up MediaSource with mime:', mimeType);
            const mseMimeSupported = window.MediaSource && MediaSource.isTypeSupported(mimeType);
            if (!mseMimeSupported) {
                throw new Error('Your browser does not support live WebM streaming. Use Chrome, Edge, or Firefox.');
            }

            const mediaSource = new MediaSource();
            mediaSourceRef.current = mediaSource;
            const objectUrl = URL.createObjectURL(mediaSource);
            objectUrlRef.current = objectUrl;
            videoRef.current.src = objectUrl;
            videoRef.current.srcObject = null;

            await new Promise((resolve, reject) => {
                mediaSource.addEventListener('sourceopen', resolve, { once: true });
                setTimeout(() => reject(new Error('MediaSource did not open')), 5000);
            });

            const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
            sourceBufferRef.current = sourceBuffer;
            try {
                if (sourceBuffer.mode === 'segments') {
                    sourceBuffer.mode = 'sequence';
                }
            } catch (err) {
                console.warn('[Nextra] Could not switch SourceBuffer to sequence mode:', err.message);
            }

            sourceBuffer.addEventListener('error', (e) => {
                console.error('[Nextra] SourceBuffer error event:', e);
                appendingLock = false;
            });

            sourceBuffer.addEventListener('updateend', () => {
                appendingLock = false;

                if (videoRef.current && sourceBuffer.buffered.length > 0) {
                    settleFirstBuffered();
                    const bufferedEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
                    const currentTime = videoRef.current.currentTime;

                    if (!userPausedRef.current && bufferedEnd - currentTime > 2.5) {
                        videoRef.current.currentTime = bufferedEnd - 0.35;
                    }

                    if (videoRef.current.paused && !userPausedRef.current) {
                        videoRef.current.play().catch(() => { });
                    }
                }

                processQueue();
            });

            // Don't use the cached initChunk from get-media-init — when the relay
            // recorder is prewarmed, it's from the start of the session and
            // incompatible with live chunks arriving minutes later. Instead, let
            // processQueue append the first chunk from the (re)started recorder,
            // which contains a fresh WebM init segment + current keyframe.

            safetyInterval = setInterval(() => {
                if (
                    mediaSourceRef.current?.readyState === 'open'
                    && !appendingLock
                    && !sourceBufferRef.current?.updating
                    && chunkQueueRef.current.length > 0
                ) {
                    processQueue();
                }
            }, 200);

            console.log('[Nextra] MediaSource ready, waiting for first buffered media…');
            processQueue();
            // Do not await here: with MSE the play() promise can stay pending
            // until enough media is buffered, which races the outer watch timeout.
            void playVideoElement(null);
            await Promise.race([
                firstBufferedPromise,
                new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Relay connected but no playable media buffered.')), 18000);
                }),
            ]);

            if (activePlaybackAttemptRef.current !== attemptId) return;

            setPlaybackMode('relay');
            setWatching(true);
            setHostDisconnected(false);
        } catch (err) {
            cleanupRelayAttempt();
            if (relayCleanupRef.current === cleanupRelayAttempt) {
                relayCleanupRef.current = null;
            }
            throw err;
        }
    }, [socket, playVideoElement, isTunnelOrigin]);

    useEffect(() => {
        if (!joined) return undefined;
        const interval = setInterval(() => socket.emit('heartbeat'), 30000);
        return () => clearInterval(interval);
    }, [joined, socket]);

    useEffect(() => {
        const onHostDisconnected = ({ reason, recoverable } = {}) => {
            if (recoverable) {
                setHostReconnectingReason(reason || 'Host reconnecting...');
                return;
            }

            setHostReconnectingReason('');
            cleanupPlayback();
            setHostDisconnected(true);
            setWatching(false);
        };

        const onHostReconnected = () => {
            setHostReconnectingReason('');
            setHostDisconnected(false);
        };

        const onNewProducer = async ({ producerId } = {}) => {
            setHasProducer(true);
            setHostDisconnected(false);

            if (!watching || playbackMode !== 'mediasoup') return;

            try {
                if (producerId) {
                    await consumeProducer(producerId, activePlaybackAttemptRef.current);
                } else {
                    const { producers = [] } = await socketRequest(socket, 'get-producers');
                    for (const producer of producers) {
                        await consumeProducer(producer.producerId, activePlaybackAttemptRef.current);
                    }
                }
            } catch (err) {
                console.warn('[Nextra] Failed to consume new producer:', err.message);
            }
        };

        const onProducerClosed = ({ consumerId }) => {
            console.log('Producer closed for consumer:', consumerId);
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

        return () => {
            socket.off('host-disconnected', onHostDisconnected);
            socket.off('host-reconnected', onHostReconnected);
            socket.off('new-producer', onNewProducer);
            socket.off('producer-closed', onProducerClosed);
            socket.off('whip-status', onWhipStatus);
            socket.off('fallback-error', onFallbackError);
        };
    }, [socket, watching, playbackMode, consumeProducer, cleanupPlayback]);

    useEffect(() => {
        const onTransportFailed = ({ reason } = {}) => {
            cleanupPlayback();
            resetDevice();
            setJoined(false);
            setWatching(false);
            setHasProducer(false);
            setHostDisconnected(false);
            setHostReconnectingReason('');
            setPlaybackMode('');
            setIsMuted(false);
            setIngestMode('browser');
            setFallbackMode(false);
            setFallbackState(null);
            setFallbackCodec(null);
            setCodecUnsupported(false);
            setWhipReconnecting(false);
            setError(reason || 'Stream connection failed. Please rejoin the room.');
        };

        socket.on('transport-failed', onTransportFailed);
        return () => socket.off('transport-failed', onTransportFailed);
    }, [socket, cleanupPlayback]);

    const handleJoin = useCallback(async () => {
        setError('');
        setHostDisconnected(false);
        setHostReconnectingReason('');
        setIngestMode('browser');
        setFallbackMode(false);
        setFallbackState(null);
        setFallbackCodec(null);
        setCodecUnsupported(false);
        setWhipReconnecting(false);

        const code = codeInput.trim().toUpperCase().replace(/-/g, '');
        if (!code) {
            setError('Please enter a room code.');
            return;
        }

        try {
            const response = await socketRequest(socket, 'join-room', { code });
            setJoined(true);
            setHasProducer(response.hasProducer || false);
            setAllowMediaControl(response.allowMediaControl !== false);

            if (response.ingestMode) setIngestMode(response.ingestMode);
            if (response.fallbackCodec) setFallbackCodec(response.fallbackCodec);

            // AV1 compatibility check
            if (response.fallbackCodec === 'av1') {
                const av1Supported = typeof MediaSource !== 'undefined' &&
                    MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"');
                if (!av1Supported) {
                    console.warn('[WatchView] AV1 MSE playback not supported in this browser');
                    setCodecUnsupported(true);
                }
            }

            const { rtpCapabilities } = await socketRequest(socket, 'get-rtp-capabilities');
            const device = await getDevice();
            if (!device.loaded) {
                await device.load({ routerRtpCapabilities: rtpCapabilities });
            }
            deviceRef.current = device;
        } catch (err) {
            setError(err.message);
        }
    }, [socket, codeInput]);

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
                setFallbackMode(false);
                setFallbackState(null);
                setError(response.error);
                return;
            }

            cleanupPlayback(); // Tear down WebRTC only after the server knows this viewer is switching
            setPlaybackMode('');
            setWatching(false);

            // Provide closure state validity
            if (!videoRef.current) {
                setFallbackMode(false);
                setFallbackState(null);
                return;
            }

            const roomCode = codeInput.trim().toUpperCase().replace(/-/g, '');
            const player = createFmp4RelayPlayer({
                videoElement: videoRef.current,
                socket,
                roomCode,
                onStateChange: (state) => setFallbackState(state),
                onError: (msg, err) => console.error('[WatchView] Fallback error:', msg, err),
            });

            fmp4PlayerRef.current = player;
            player.start();
        });
    }, [socket, codeInput, cleanupPlayback]);

    // Auto-enter fallback mode for OBS rooms only when media is actually ready.
    useEffect(() => {
        if (joined && ingestMode === 'obs' && !fallbackMode && !fmp4PlayerRef.current
            && preferRelayFirst && hasProducer && !whipReconnecting && !watching && !watchLoading) {
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
            await startMediasoupPlayback({ forceProbe: true });
        } catch (err) {
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
        let watchTimedOut = false;
        const watchTimeout = setTimeout(() => {
            watchTimedOut = true;
            cleanupPlayback();
            setWatching(false);
            setWatchLoading(false);
            setError('Connection timed out. Check your network or try again.');
        }, 40000);

        if (preferRelayFirst) {
            try {
                console.log('[Nextra] Starting relay playback first for public tunnel viewer.');
                await startRelayPlayback();
                if (watchTimedOut) return;
                console.log('[Nextra] Relay playback connected.');
            } catch (primaryErr) {
                if (watchTimedOut) return;
                console.warn('[Nextra] Relay-first playback failed; trying WebRTC fallback:', primaryErr.message);
                cleanupPlayback();

                try {
                    console.log('[Nextra] Trying mediasoup fallback.');
                    await startMediasoupPlayback();
                    if (watchTimedOut) return;
                    console.log('[Nextra] Mediasoup fallback connected.');
                } catch (fallbackErr) {
                    if (watchTimedOut) return;
                    cleanupPlayback();
                    setWatching(false);
                    console.error('[Nextra] Secondary playback attempt failed:', fallbackErr.message);
                    setError(fallbackErr.message || primaryErr.message || 'Failed to start watching.');
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
            if (watchTimedOut) return;
            console.warn('[Nextra] Primary playback failed; trying relay fallback:', primaryErr.message);
            cleanupPlayback();

            try {
                console.log('[Nextra] Starting relay playback…');
                await startRelayPlayback();
                if (watchTimedOut) return;
                console.log('[Nextra] Relay playback connected.');
            } catch (fallbackErr) {
                if (watchTimedOut) return;
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
    }, [cleanupPlayback, preferRelayFirst, startMediasoupPlayback, startRelayPlayback]);

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
        try {
            await socketRequest(socket, 'leave-room', {}, { timeoutMs: 5000, maxAttempts: 1 });
        } catch (err) {
            console.warn('[Nextra] leave-room failed:', err.message);
        }

        cleanupPlayback();
        resetDevice();
        setJoined(false);
        setWatching(false);
        setHasProducer(false);
        setHostDisconnected(false);
        setHostReconnectingReason('');
        setError('');
        setPlaybackMode('');
        setIsMuted(false);
        setIngestMode('browser');
        setFallbackMode(false);
        setFallbackState(null);
        setFallbackCodec(null);
        setCodecUnsupported(false);
        setWhipReconnecting(false);
    }, [cleanupPlayback, socket]);

    // Detect socket reconnection while viewer thinks they're in a room.
    // After reconnect the server has no record of this socket ID, so all
    // subsequent requests would silently fail — reset to the join screen.
    useEffect(() => {
        const onReconnect = () => {
            if (!joined) return;
            console.warn('[Nextra] Socket reconnected while in a room — resetting viewer state.');
            cleanupPlayback();
            resetDevice();
            setJoined(false);
            setWatching(false);
            setHasProducer(false);
            setHostDisconnected(false);
            setHostReconnectingReason('');
            setPlaybackMode('');
            setIsMuted(false);
            setIngestMode('browser');
            setFallbackMode(false);
            setFallbackState(null);
            setFallbackCodec(null);
            setCodecUnsupported(false);
            setWhipReconnecting(false);
            setError('Connection was lost. Please rejoin the room.');
        };

        socket.on('connect', onReconnect);
        return () => socket.off('connect', onReconnect);
    }, [socket, joined, cleanupPlayback]);

    useEffect(() => () => {
        if (fmp4PlayerRef.current) {
            fmp4PlayerRef.current.stop();
            fmp4PlayerRef.current = null;
        }
        socket.emit('leave-room');
        cleanupPlayback();
        resetDevice();
    }, [cleanupPlayback, socket]);

    const playbackStatus = fallbackMode
        ? `Relay Mode (${fallbackCodec || 'unknown'}) - ${fallbackState || 'initializing'}`
        : watching && playbackMode === 'relay'
            ? 'Compatibility relay mode active (higher latency).'
            : watching
                ? ingestMode === 'obs'
                    ? 'OBS WebRTC mode active (lowest latency).'
                    : 'WebRTC mode active (lowest latency).'
                : '';
    const renderLegacyStatusBlocks = false;

    return (
        <div className="view-container">
            <div className="view-header">
                <h1>Watch</h1>
                <p className="subtitle">Join a room to watch a stream</p>
            </div>

            {error && <div className="alert alert-error">{error}</div>}

            {!joined ? (
                <div className="join-form">
                    <div className="input-group">
                        <input
                            type="text"
                            className="input-code"
                            placeholder="XXX-XXX"
                            value={codeInput}
                            onChange={(evt) => {
                                let raw = evt.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
                                raw = raw.slice(0, 6);
                                if (raw.length > 3) raw = `${raw.slice(0, 3)}-${raw.slice(3)}`;
                                setCodeInput(raw);
                            }}
                            onKeyDown={(evt) => evt.key === 'Enter' && handleJoin()}
                            maxLength={7}
                            autoFocus
                        />
                        <button className="btn btn-primary" onClick={handleJoin}>
                            Join Room
                        </button>
                    </div>
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
                                    <p>Waiting for host to start sharing...</p>
                                )}
                            </div>
                        )}

                        {hostReconnectingReason && !hostDisconnected && (
                            <div className="video-overlay">
                                <p style={{ fontSize: '1.1rem' }}>{hostReconnectingReason}</p>
                            </div>
                        )}

                        {hostDisconnected && (
                            <div className="video-overlay">
                                <p className="host-ended" style={{ fontSize: '1.2rem' }}>
                                    Host has ended the stream
                                </p>
                            </div>
                        )}
                    </div>

                    {whipReconnecting && (
                        <div style={{ padding: '0.5rem 1rem', background: '#2a2a00', borderRadius: '4px', fontSize: '0.85rem', color: '#ffcc00', marginTop: '0.5rem' }}>
                            OBS disconnected — waiting for reconnection...
                        </div>
                    )}

                    {ingestMode === 'obs' && codecUnsupported && (
                        <div style={{ padding: '0.75rem 1rem', background: '#3a1a1a', border: '1px solid #662222', borderRadius: '4px', fontSize: '0.85rem', color: '#ff8888', marginTop: '0.5rem' }}>
                            Your browser does not support AV1 playback. The host is streaming in AV1. Fallback playback is not available in this browser.
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
                                title="Fullscreen"
                                onClick={() => {
                                    const player = videoRef.current;
                                    if (!player) return;
                                    if (player.requestFullscreen) player.requestFullscreen();
                                    else if (player.webkitRequestFullscreen) player.webkitRequestFullscreen();
                                    else if (player.msRequestFullscreen) player.msRequestFullscreen();
                                }}
                            >
                                Fullscreen
                            </button>
                        )}

                        {watching && !fallbackMode && playbackMode === 'mediasoup' && ingestMode === 'obs' && !codecUnsupported && (
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

                    {renderLegacyStatusBlocks && fallbackMode && (
                            <div className="media-status">
                                <span>Relay Mode ({fallbackCodec || 'unknown'}) — {fallbackState || 'initializing'}</span>
                            </div>
                        )}

                    {renderLegacyStatusBlocks && watching && playbackMode === 'relay' && (
                        <div className="media-status">Compatibility relay mode active (higher latency).</div>
                    )}

                    {renderLegacyStatusBlocks && watching && !fallbackMode && playbackMode === 'mediasoup' && (
                        <div className="media-status">
                            {ingestMode === 'obs' ? 'OBS WebRTC mode active (lowest latency).' : 'WebRTC mode active (lowest latency).'}
                        </div>
                    )}

                    {playbackStatus && <div className="media-status">{playbackStatus}</div>}

                    {mediaControlStatus && (
                        <div className="media-status">{mediaControlStatus}</div>
                    )}
                </>
            )}
        </div>
    );
}
