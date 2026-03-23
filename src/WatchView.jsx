import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useSocket } from './context/SocketContext';
import { getDevice, resetDevice, socketRequest } from './lib/mediasoupClient';

const MAX_QUEUE_CHUNKS = 240;
const MAX_QUEUE_BYTES = 24 * 1024 * 1024;


function getSpatialLayerForPreference(preference) {
    switch (preference) {
        case 'low':
            return 0;
        case 'balanced':
            return 1;
        case 'high':
        case 'auto':
        default:
            return 2;
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

async function toUint8Array(data) {
    if (data instanceof Blob) {
        return new Uint8Array(await data.arrayBuffer());
    }
    return toUint8ArraySync(data);
}

function areUint8ArraysEqual(left, right) {
    if (!left || !right || left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
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
    const [viewerLayerPreference, setViewerLayerPreference] = useState('high');

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
    const consumedProducerIdsRef = useRef(new Set());
    const videoConsumerIdsRef = useRef(new Set());
    const producerToConsumerIdRef = useRef(new Map());

    const cleanupPlayback = useCallback(() => {
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
        consumedProducerIdsRef.current.clear();
        videoConsumerIdsRef.current.clear();
        producerToConsumerIdRef.current.clear();

        if (recvTransportRef.current) {
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

    const applyLayerPreference = useCallback(async (consumerId, preference = viewerLayerPreference) => {
        if (!consumerId) return;
        const spatialLayer = getSpatialLayerForPreference(preference);
        await socketRequest(socket, 'set-consumer-layers', { consumerId, spatialLayer }, { timeoutMs: 8000, maxAttempts: 1 });
    }, [socket, viewerLayerPreference]);

    const consumeProducer = useCallback(async (producerId) => {
        if (!producerId) return;
        if (consumedProducerIdsRef.current.has(producerId)) return;

        const device = deviceRef.current;
        const recvTransport = recvTransportRef.current;
        if (!device || !device.loaded || !recvTransport) {
            throw new Error('Receive transport not ready.');
        }

        const { params } = await socketRequest(socket, 'consume', {
            producerId,
            rtpCapabilities: device.rtpCapabilities,
        });

        const consumer = await recvTransport.consume({
            id: params.id,
            producerId: params.producerId,
            kind: params.kind,
            rtpParameters: params.rtpParameters,
        });

        consumersRef.current.push(consumer);
        producerToConsumerIdRef.current.set(producerId, consumer.id);
        if (consumer.kind === 'video') {
            videoConsumerIdsRef.current.add(consumer.id);
        }

        const existingTracks = mediaStreamRef.current ? mediaStreamRef.current.getTracks() : [];
        const newStream = new MediaStream([...existingTracks, consumer.track]);
        mediaStreamRef.current = newStream;

        consumer.on('transportclose', () => {
            consumedProducerIdsRef.current.delete(producerId);
            producerToConsumerIdRef.current.delete(producerId);
            videoConsumerIdsRef.current.delete(consumer.id);
        });
        consumer.on('producerclose', () => {
            consumedProducerIdsRef.current.delete(producerId);
            producerToConsumerIdRef.current.delete(producerId);
            videoConsumerIdsRef.current.delete(consumer.id);
        });

        try {
            await socketRequest(socket, 'consumer-resume', { consumerId: consumer.id });
        } catch (err) {
            // Cleanup partial state so a retry can re-attempt this producer.
            producerToConsumerIdRef.current.delete(producerId);
            videoConsumerIdsRef.current.delete(consumer.id);
            try { consumer.close(); } catch { }
            consumersRef.current = consumersRef.current.filter((c) => c.id !== consumer.id);
            throw err;
        }

        // Only mark consumed AFTER the full chain succeeds.
        consumedProducerIdsRef.current.add(producerId);

        if (consumer.kind === 'video') {
            try {
                await applyLayerPreference(consumer.id);
            } catch (err) {
                console.warn('[Nextra] Failed to apply viewer layer preference:', err.message);
            }
        }
        await playVideoElement(newStream);
    }, [socket, playVideoElement, applyLayerPreference]);

    const isTunnelOrigin = /\.trycloudflare\.com$/i.test(window.location.hostname)
        || /\.cloudflare/i.test(window.location.hostname);

    const startMediasoupPlayback = useCallback(async () => {
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

        for (const producer of producers) {
            await consumeProducer(producer.producerId);
        }

        // Wait for the ICE/DTLS connection to actually establish, with a timeout.
        // Tunnel viewers get a short timeout (4s) — if TURN is configured, ICE
        // connects in 1-2s via TCP relay. If not, fail fast and fall back to
        // relay playback instead of hanging for 15s on unreachable UDP candidates.
        const iceTimeoutMs = isTunnelOrigin ? 4000 : 15000;
        const connectionState = recvTransport.connectionState;
        if (connectionState !== 'connected') {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    cleanup();
                    reject(new Error(
                        isTunnelOrigin
                            ? 'WebRTC could not connect through tunnel (no TURN server configured).'
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

        setPlaybackMode('mediasoup');
        setWatching(true);
        setHostDisconnected(false);
        setHasProducer(true);
    }, [socket, consumeProducer, isTunnelOrigin]);

    const startRelayPlayback = useCallback(async () => {
        if (!videoRef.current) throw new Error('Video element not found');

        await socketRequest(socket, 'relay-consume-start');
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

        const enqueueChunk = (buf) => {
            const uint = toUint8ArraySync(buf);
            if (!uint?.byteLength) {
                if (!relayUnsupportedWarnedRef.current) {
                    relayUnsupportedWarnedRef.current = true;
                    console.warn('[Nextra] Ignoring unsupported relay chunk payload.');
                }
                return;
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

        const onChunk = (data) => {
            if (data instanceof Blob) {
                data.arrayBuffer().then(enqueueChunk);
            } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || data?.data) {
                enqueueChunk(data);
            }
        };

        const onMediaInit = (payload = {}) => {
            if (!payload?.mimeType) return;
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

        try {
            initResultData = await socketRequest(socket, 'get-media-init');
            if (initResultData.init?.mimeType) {
                mimeType = initResultData.init.mimeType;
            }
        } catch {
            // Relay can start before init metadata is cached; wait for live media-init below.
        }

        if (!initResultData?.init?.mimeType) {
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
        }

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

        if (initResultData?.initChunk && mediaSource.readyState === 'open') {
            const initBuffer = await toUint8Array(initResultData.initChunk);

            if (initBuffer?.byteLength) {
                const queuedFirstChunk = chunkQueueRef.current[0];
                if (areUint8ArraysEqual(queuedFirstChunk, initBuffer)) {
                    chunkQueueRef.current.shift();
                    queuedBytesRef.current = Math.max(0, queuedBytesRef.current - queuedFirstChunk.byteLength);
                }

                appendingLock = true;
                try {
                    await new Promise((resolve) => {
                        sourceBuffer.addEventListener('updateend', resolve, { once: true });
                        sourceBuffer.appendBuffer(initBuffer);
                    });
                } finally {
                    appendingLock = false;
                }

                if (sourceBuffer.buffered.length > 0) {
                    settleFirstBuffered();
                }
            }
        }

        const safetyInterval = setInterval(() => {
            if (
                mediaSourceRef.current?.readyState === 'open'
                && !appendingLock
                && !sourceBufferRef.current?.updating
                && chunkQueueRef.current.length > 0
            ) {
                processQueue();
            }
        }, 200);

        relayCleanupRef.current = () => {
            socket.off('media-init', onMediaInit);
            socket.off('media-chunk', onChunk);
            clearInterval(safetyInterval);
            settleFirstBuffered(new Error('Relay playback was cleaned up before media buffered.'));
        };

        processQueue();
        await playVideoElement(null);
        await Promise.race([
            firstBufferedPromise,
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Relay connected but no playable media buffered.')), 12000);
            }),
        ]);

        setPlaybackMode('relay');
        setWatching(true);
        setHostDisconnected(false);
    }, [socket, playVideoElement]);

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
                    await consumeProducer(producerId);
                } else {
                    const { producers = [] } = await socketRequest(socket, 'get-producers');
                    for (const producer of producers) {
                        await consumeProducer(producer.producerId);
                    }
                }
            } catch (err) {
                console.warn('[Nextra] Failed to consume new producer:', err.message);
            }
        };

        const onProducerClosed = ({ consumerId }) => {
            console.log('Producer closed for consumer:', consumerId);
        };

        socket.on('host-disconnected', onHostDisconnected);
        socket.on('host-reconnected', onHostReconnected);
        socket.on('new-producer', onNewProducer);
        socket.on('producer-closed', onProducerClosed);

        return () => {
            socket.off('host-disconnected', onHostDisconnected);
            socket.off('host-reconnected', onHostReconnected);
            socket.off('new-producer', onNewProducer);
            socket.off('producer-closed', onProducerClosed);
        };
    }, [socket, watching, playbackMode, consumeProducer, cleanupPlayback]);

    useEffect(() => {
        if (!watching || playbackMode !== 'mediasoup') return;
        if (!videoConsumerIdsRef.current.size) return;

        const consumerIds = Array.from(videoConsumerIdsRef.current);
        consumerIds.forEach((consumerId) => {
            applyLayerPreference(consumerId, viewerLayerPreference).catch((err) => {
                console.warn('[Nextra] Could not update layer preference:', err.message);
            });
        });
    }, [watching, playbackMode, viewerLayerPreference, applyLayerPreference]);

    const handleJoin = useCallback(async () => {
        setError('');
        setHostDisconnected(false);
        setHostReconnectingReason('');

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

    const handleWatch = useCallback(async () => {
        setError('');
        setWatchLoading(true);
        cleanupPlayback();

        // Safety net: never stay in "Connecting..." state for more than 25s total.
        let watchTimedOut = false;
        const watchTimeout = setTimeout(() => {
            watchTimedOut = true;
            cleanupPlayback();
            setWatching(false);
            setWatchLoading(false);
            setError('Connection timed out. Check your network or try again.');
        }, 25000);

        try {
            await startMediasoupPlayback();
        } catch (primaryErr) {
            if (watchTimedOut) return;
            console.warn('[Nextra] Primary playback failed; trying relay fallback:', primaryErr.message);
            cleanupPlayback();

            try {
                await startRelayPlayback();
            } catch (fallbackErr) {
                if (watchTimedOut) return;
                cleanupPlayback();
                setWatching(false);
                console.error('[Nextra] Watch failed:', fallbackErr);
                setError(fallbackErr.message || primaryErr.message || 'Failed to start watching.');
            }
        } finally {
            clearTimeout(watchTimeout);
            if (!watchTimedOut) {
                setWatchLoading(false);
            }
        }
    }, [cleanupPlayback, startMediasoupPlayback, startRelayPlayback]);

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
        setViewerLayerPreference('auto');
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
            setViewerLayerPreference('auto');
            setError('Connection was lost. Please rejoin the room.');
        };

        socket.on('connect', onReconnect);
        return () => socket.off('connect', onReconnect);
    }, [socket, joined, cleanupPlayback]);

    useEffect(() => () => {
        socket.emit('leave-room');
        cleanupPlayback();
        resetDevice();
    }, [cleanupPlayback, socket]);

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

                        {!watching && !hostDisconnected && (
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

                    <div className="controls">
                        {watching && (
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

                        {watching && allowMediaControl && (
                            <button className="btn btn-secondary" onClick={handleToggleMedia}>
                                Play/Pause Host Media
                            </button>
                        )}

                        {watching && (
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

                        {watching && playbackMode === 'mediasoup' && (
                            <select
                                className="input-code"
                                style={{ maxWidth: '220px', height: '44px' }}
                                value={viewerLayerPreference}
                                onChange={(evt) => setViewerLayerPreference(evt.target.value)}
                                title="Viewer quality preference"
                            >
                                <option value="auto">Quality: Auto</option>
                                <option value="high">Quality: High</option>
                                <option value="balanced">Quality: Balanced</option>
                                <option value="low">Quality: Low</option>
                            </select>
                        )}

                        <button className="btn btn-outline" onClick={handleLeave}>
                            Leave Room
                        </button>
                    </div>

                    {watching && playbackMode === 'relay' && (
                        <div className="media-status">Compatibility relay mode active (higher latency).</div>
                    )}

                    {mediaControlStatus && (
                        <div className="media-status">{mediaControlStatus}</div>
                    )}
                </>
            )}
        </div>
    );
}
