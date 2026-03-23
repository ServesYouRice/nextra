import React, { useState, useRef, useEffect, useCallback, useContext } from 'react';
import { SocketContext } from './context/SocketContext';
import { getDevice, resetDevice, socketRequest } from './lib/mediasoupClient';

const BASE_SIMULCAST_ENCODINGS = [
    { rid: 'r0', maxBitrate: 900_000, scaleResolutionDownBy: 4 },
    { rid: 'r1', maxBitrate: 4_000_000, scaleResolutionDownBy: 2 },
    { rid: 'r2', maxBitrate: 18_000_000 },
];

const CODEC_OPTIONS = { videoGoogleStartBitrate: 10_000 };

const QUALITY_PROFILES = {
    '4k': {
        label: '4K',
        maxSpatialLayer: 2,
        capture: { width: 3840, height: 2160 },
        relayBitsPerSecond: 8_000_000,
    },
    '1440p': {
        label: '1440p',
        maxSpatialLayer: 2,
        capture: { width: 2560, height: 1440 },
        relayBitsPerSecond: 6_000_000,
    },
    '1080p': {
        label: '1080p',
        maxSpatialLayer: 1,
        capture: { width: 1920, height: 1080 },
        relayBitsPerSecond: 4_000_000,
    },
};

function isLikelyLocalOrigin(origin) {
    try {
        const parsed = new URL(origin);
        const host = parsed.hostname.toLowerCase();
        return (
            host === 'localhost'
            || host === '127.0.0.1'
            || host === '::1'
            || host === '[::1]'
            || /^192\.168\./.test(host)
            || /^10\./.test(host)
            || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
        );
    } catch {
        return true;
    }
}

function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function HostView() {
    const socket = useContext(SocketContext);
    const [roomCode, setRoomCode] = useState(null);
    const [isSharing, setIsSharing] = useState(false);
    const [viewerCount, setViewerCount] = useState(0);
    const contentMode = 'motion';
    const [allowMediaControl, setAllowMediaControl] = useState(true);
    const [hostUploadMbps, setHostUploadMbps] = useState(20);
    const [lanBaseUrl, setLanBaseUrl] = useState(window.location.origin);
    const [shareBaseUrl, setShareBaseUrl] = useState('');
    const [publicShareStatus, setPublicShareStatus] = useState('disabled');
    const [publicShareError, setPublicShareError] = useState('');
    const [relayFlushIntervalMs, setRelayFlushIntervalMs] = useState(300);
    const [relayVideoBitsPerSecond, setRelayVideoBitsPerSecond] = useState(6_000_000);
    const [relayViewerCount, setRelayViewerCount] = useState(0);
    const [error, setError] = useState('');
    const [copied, setCopied] = useState(false);
    const [status, setStatus] = useState('idle');
    const [qualityProfile, setQualityProfile] = useState('1440p');
    const [frameRate, setFrameRate] = useState(60);
    const [autoTuneQuality, setAutoTuneQuality] = useState(true);
    const [roomMetrics, setRoomMetrics] = useState(null);

    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const videoProducerRef = useRef(null);
    const heartbeatRef = useRef(null);
    const safetyFlushIntervalRef = useRef(null);
    const audioCtxRef = useRef(null);
    const silentAudioTrackRef = useRef(null);
    const hostTokenRef = useRef(null);

    const bitratePerViewer = viewerCount > 0 ? hostUploadMbps / viewerCount : hostUploadMbps;
    const bandwidthWarning = viewerCount >= 3 && bitratePerViewer < 7
        ? `${viewerCount} viewers x ~${bitratePerViewer.toFixed(1)} Mbps each. Consider 720p.`
        : '';
    const selectedProfile = QUALITY_PROFILES[qualityProfile] || QUALITY_PROFILES['1440p'];
    const effectiveRelayBitsPerSecond = Math.min(relayVideoBitsPerSecond, selectedProfile.relayBitsPerSecond);

    const maybeAutoTuneProfile = useCallback((nextViewerCount, nextRelayViewerCount) => {
        if (!isSharing || !autoTuneQuality) return;

        const viewers = Math.max(0, Number(nextViewerCount) || 0);
        const relayCount = Math.max(0, Number(nextRelayViewerCount) || 0);
        const perViewer = viewers > 0 ? (hostUploadMbps / viewers) : hostUploadMbps;

        let recommended = qualityProfile;
        const currentIndex = ['1080p', '1440p', '4k'].indexOf(qualityProfile);
        if (relayCount >= 2 || perViewer < 5 || viewers >= 8) {
            recommended = '1080p';
        } else if (relayCount >= 1 || perViewer < 8 || viewers >= 4) {
            recommended = currentIndex > 1 ? '1440p' : qualityProfile;
        }

        setQualityProfile((current) => (current === recommended ? current : recommended));
    }, [isSharing, autoTuneQuality, hostUploadMbps]);

    useEffect(() => {
        if (!roomCode) return undefined;
        heartbeatRef.current = setInterval(() => {
            socket.emit('heartbeat');
        }, 30000);
        return () => {
            if (heartbeatRef.current) {
                clearInterval(heartbeatRef.current);
                heartbeatRef.current = null;
            }
        };
    }, [socket, roomCode]);

    useEffect(() => {
        const onViewerCount = ({ count }) => {
            const nextCount = Math.max(0, Number(count) || 0);
            setViewerCount(nextCount);
            maybeAutoTuneProfile(nextCount, relayViewerCount);
        };
        socket.on('viewer-count', onViewerCount);
        return () => socket.off('viewer-count', onViewerCount);
    }, [socket, maybeAutoTuneProfile, relayViewerCount]);

    const stopRelayRecorder = useCallback(() => {
        if (safetyFlushIntervalRef.current) {
            clearInterval(safetyFlushIntervalRef.current);
            safetyFlushIntervalRef.current = null;
        }

        const recorder = mediaRecorderRef.current;
        if (recorder) {
            try {
                if (recorder.state !== 'inactive') {
                    recorder.stop();
                }
            } catch { }
        }
        mediaRecorderRef.current = null;

        if (silentAudioTrackRef.current) {
            try {
                if (streamRef.current) {
                    streamRef.current.removeTrack(silentAudioTrackRef.current);
                }
                silentAudioTrackRef.current.stop();
            } catch { }
            silentAudioTrackRef.current = null;
        }

        if (audioCtxRef.current) {
            try { audioCtxRef.current.close(); } catch { }
            audioCtxRef.current = null;
        }
    }, []);

    const startRelayRecorder = useCallback(() => {
        if (mediaRecorderRef.current || !streamRef.current) return;
        if (typeof MediaRecorder !== 'function') {
            console.warn('[Nextra-Host] MediaRecorder unavailable; relay fallback cannot start.');
            return;
        }

        const stream = streamRef.current;

        if (stream.getAudioTracks().length === 0) {
            try {
                const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                audioCtxRef.current = audioCtx;
                const oscillator = audioCtx.createOscillator();
                const gainNode = audioCtx.createGain();
                gainNode.gain.value = 0;
                const dst = audioCtx.createMediaStreamDestination();
                oscillator.connect(gainNode);
                gainNode.connect(dst);
                oscillator.start();

                const silentAudioTrack = dst.stream.getAudioTracks()[0];
                if (silentAudioTrack) {
                    silentAudioTrackRef.current = silentAudioTrack;
                    stream.addTrack(silentAudioTrack);
                }
            } catch (err) {
                console.warn('[Nextra-Host] Could not create silent audio track for relay:', err.message);
            }
        }

        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
            ? 'video/webm;codecs=vp8,opus'
            : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
                ? 'video/webm;codecs=vp8'
                : 'video/webm';

        const recorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: effectiveRelayBitsPerSecond,
        });
        mediaRecorderRef.current = recorder;

        let chunkCount = 0;
        let lastChunkAt = 0;
        recorder.onstart = () => {
            lastChunkAt = Date.now();
            socket.emit('media-init', { mimeType });
        };
        recorder.ondataavailable = (evt) => {
            if (evt.data && evt.data.size > 0) {
                lastChunkAt = Date.now();
                chunkCount += 1;
                if (chunkCount % 20 === 0) {
                    console.log(`[Nextra-Host] Emitted ${chunkCount} relay chunks. Latest size: ${evt.data.size}`);
                }
                socket.emit('media-chunk', evt.data);
            }
        };
        recorder.onerror = (evt) => {
            const message = evt?.error?.message || evt?.error?.name || 'unknown recorder error';
            console.error('[Nextra-Host] Relay recorder error:', message);
        };
        recorder.onstop = () => {
            if (mediaRecorderRef.current === recorder) {
                mediaRecorderRef.current = null;
            }
        };

        try {
            recorder.start(relayFlushIntervalMs);
        } catch (err) {
            mediaRecorderRef.current = null;
            console.error('[Nextra-Host] Failed to start relay recorder:', err.message);
            return;
        }

        if (safetyFlushIntervalRef.current) {
            clearInterval(safetyFlushIntervalRef.current);
        }
        safetyFlushIntervalRef.current = setInterval(() => {
            if (
                recorder.state === 'recording'
                && lastChunkAt > 0
                && (Date.now() - lastChunkAt) > Math.max(1500, relayFlushIntervalMs * 4)
            ) {
                recorder.requestData();
            }
        }, Math.max(1000, relayFlushIntervalMs * 2));
    }, [socket, effectiveRelayBitsPerSecond, relayFlushIntervalMs]);

    const cleanup = useCallback(() => {
        stopRelayRecorder();

        if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
        }

        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }

        if (audioCtxRef.current) {
            try { audioCtxRef.current.close(); } catch { }
            audioCtxRef.current = null;
        }
        silentAudioTrackRef.current = null;

        setIsSharing(false);
        setRoomCode(null);
        hostTokenRef.current = null;
        videoProducerRef.current = null;
        setViewerCount(0);
        setRelayViewerCount(0);
        setRoomMetrics(null);
        setStatus('idle');
        resetDevice();
    }, [stopRelayRecorder]);

    useEffect(() => {
        const onReconnect = async () => {
            if (!isSharing || !roomCode || !hostTokenRef.current) return;
            try {
                await socketRequest(socket, 'reclaim-host', {
                    code: roomCode,
                    hostToken: hostTokenRef.current,
                });
                socket.emit('request-server-config');
                const { metrics } = await socketRequest(socket, 'get-room-metrics');
                setRoomMetrics(metrics || null);
            } catch (err) {
                console.warn('[Nextra] Failed to reclaim host room after reconnect:', err.message);
            }
        };

        socket.on('connect', onReconnect);
        return () => socket.off('connect', onReconnect);
    }, [socket, isSharing, roomCode]);

    useEffect(() => {
        const onRoomMetrics = (data) => {
            setRoomMetrics(data || null);
            if (data) {
                setRelayViewerCount(Math.max(0, Number(data.relayViewerCount) || 0));
                maybeAutoTuneProfile(data.viewerCount, data.relayViewerCount);
            }
        };

        socket.on('room-metrics', onRoomMetrics);
        return () => socket.off('room-metrics', onRoomMetrics);
    }, [socket, maybeAutoTuneProfile]);

    useEffect(() => {
        const onConnect = () => socket.emit('request-server-config');
        socket.on('connect', onConnect);
        return () => socket.off('connect', onConnect);
    }, [socket]);

    useEffect(() => {
        if (!roomCode) return;
        socketRequest(socket, 'get-room-metrics', {}, { timeoutMs: 8000, maxAttempts: 1 })
            .then(({ metrics }) => {
                setRoomMetrics(metrics || null);
                if (metrics) {
                    setRelayViewerCount(Math.max(0, Number(metrics.relayViewerCount) || 0));
                }
            })
            .catch(() => { });
    }, [socket, roomCode]);

    useEffect(() => {
        if (!isSharing) return undefined;

        const onRelayDemandChanged = ({ count } = {}) => {
            const nextCount = Math.max(0, Number(count) || 0);
            setRelayViewerCount(nextCount);
            maybeAutoTuneProfile(viewerCount, nextCount);
        };

        socket.on('relay-demand-changed', onRelayDemandChanged);
        return () => socket.off('relay-demand-changed', onRelayDemandChanged);
    }, [socket, isSharing, viewerCount, maybeAutoTuneProfile]);

    const applyQualityProfileToLiveStream = useCallback(async (profileKey, fps) => {
        const profile = QUALITY_PROFILES[profileKey] || QUALITY_PROFILES['1440p'];
        const videoProducer = videoProducerRef.current;
        if (videoProducer) {
            try {
                await videoProducer.setMaxSpatialLayer(profile.maxSpatialLayer);
            } catch (err) {
                console.warn('[Nextra-Host] Failed to apply producer layer profile:', err.message);
            }
        }

        const stream = streamRef.current;
        const track = stream?.getVideoTracks?.()[0];
        if (track?.applyConstraints) {
            try {
                await track.applyConstraints({
                    width: { ideal: profile.capture.width },
                    height: { ideal: profile.capture.height },
                    frameRate: { ideal: fps },
                });
            } catch (err) {
                console.warn('[Nextra-Host] Failed to apply capture profile constraints:', err.message);
            }
        }
    }, []);

    useEffect(() => {
        if (!isSharing) return;
        void applyQualityProfileToLiveStream(qualityProfile, frameRate);

        if (relayViewerCount > 0) {
            stopRelayRecorder();
            startRelayRecorder();
        } else {
            stopRelayRecorder();
        }
    }, [
        isSharing,
        qualityProfile,
        frameRate,
        relayViewerCount,
        relayFlushIntervalMs,
        effectiveRelayBitsPerSecond,
        applyQualityProfileToLiveStream,
        startRelayRecorder,
        stopRelayRecorder,
    ]);

    const handleStartSharing = useCallback(async () => {
        setError('');
        setStatus('connecting');

        try {
            const userAgent = navigator.userAgent || '';
            const isChromiumBrand = !!navigator.userAgentData?.brands?.some((b) => /Chrom/i.test(b.brand));
            const isChromium = isChromiumBrand || /Chrome|Chromium|Edg\//i.test(userAgent);

            if (!isChromium) {
                setError('System audio is best supported in Chrome or Edge.');
            }

            const displayMediaOptions = {
                video: {
                    width: selectedProfile.capture.width,
                    height: selectedProfile.capture.height,
                    frameRate: frameRate,
                },
                audio: isChromium ? { channelCount: 2 } : false,
            };
            if (isChromium) {
                displayMediaOptions.systemAudio = 'include';
            }

            const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
            streamRef.current = stream;

            const videoTrack = stream.getVideoTracks()[0];
            videoTrack.contentHint = contentMode;

            if (videoRef.current) {
                videoRef.current.srcObject = stream;
            }

            videoTrack.addEventListener('ended', () => {
                socket.emit('host-stopped');
                cleanup();
            });

            // Best effort cleanup for stale socket room state before creating a fresh room.
            try {
                await socketRequest(socket, 'leave-room', {}, { timeoutMs: 5000, maxAttempts: 1 });
            } catch { }

            const { code, hostToken } = await socketRequest(socket, 'create-room', { allowMediaControl });
            setRoomCode(code);
            hostTokenRef.current = hostToken || null;

            const { rtpCapabilities } = await socketRequest(socket, 'get-rtp-capabilities');
            const device = await getDevice();
            if (!device.loaded) {
                await device.load({ routerRtpCapabilities: rtpCapabilities });
            }

            const { params, iceServers } = await socketRequest(socket, 'create-send-transport');
            const sendTransport = device.createSendTransport({
                ...params,
                iceServers,
            });

            sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                try {
                    await socketRequest(socket, 'connect-transport', {
                        transportId: sendTransport.id,
                        dtlsParameters,
                    });
                    callback();
                } catch (err) {
                    errback(err);
                }
            });

            sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
                try {
                    const { producerId } = await socketRequest(socket, 'produce', {
                        kind,
                        rtpParameters,
                        appData,
                    });
                    callback({ id: producerId });
                } catch (err) {
                    errback(err);
                }
            });

            const videoProducer = await sendTransport.produce({
                track: videoTrack,
                encodings: BASE_SIMULCAST_ENCODINGS,
                codecOptions: CODEC_OPTIONS,
            });
            videoProducerRef.current = videoProducer;
            try {
                await videoProducer.setMaxSpatialLayer(selectedProfile.maxSpatialLayer);
            } catch (err) {
                console.warn('[Nextra-Host] Could not apply initial profile layer:', err.message);
            }

            const audioTracks = stream.getAudioTracks();
            if (audioTracks.length > 0) {
                await sendTransport.produce({ track: audioTracks[0] });
            }
            setRelayViewerCount(0);
            setIsSharing(true);
            setStatus('streaming');
        } catch (err) {
            console.error('Start sharing failed:', err);
            if (err?.name === 'NotAllowedError') {
                setError('Screen sharing was cancelled.');
            } else {
                setError(`Failed to start sharing: ${err.message}`);
            }
            socket.emit('host-stopped');
            cleanup();
        }
    }, [socket, allowMediaControl, cleanup, selectedProfile, frameRate]);

    const applyServerConfig = useCallback((data = {}) => {
        if (typeof data.hostUploadMbps === 'number') {
            setHostUploadMbps(data.hostUploadMbps);
        }
        if (typeof data.lanUrl === 'string' && data.lanUrl) {
            setLanBaseUrl(data.lanUrl.replace(/\/$/, ''));
        }
        if (typeof data.shareBaseUrl === 'string') {
            setShareBaseUrl(data.shareBaseUrl.replace(/\/$/, ''));
        } else if (!isLikelyLocalOrigin(window.location.origin)) {
            setShareBaseUrl(window.location.origin.replace(/\/$/, ''));
        }
        if (typeof data.publicShareStatus === 'string') {
            setPublicShareStatus(data.publicShareStatus);
        }
        if (typeof data.publicShareError === 'string') {
            setPublicShareError(data.publicShareError);
        }
        if (typeof data.relayFlushIntervalMs === 'number' && data.relayFlushIntervalMs >= 100) {
            setRelayFlushIntervalMs(data.relayFlushIntervalMs);
        }
        if (typeof data.relayVideoBitsPerSecond === 'number' && data.relayVideoBitsPerSecond > 0) {
            setRelayVideoBitsPerSecond(data.relayVideoBitsPerSecond);
        }
    }, []);

    useEffect(() => {
        const onServerConfig = (data) => applyServerConfig(data);
        socket.on('server-config', onServerConfig);
        socket.emit('request-server-config');

        return () => socket.off('server-config', onServerConfig);
    }, [socket, applyServerConfig]);

    const handleStopSharing = useCallback(() => {
        socket.emit('host-stopped');
        cleanup();
    }, [socket, cleanup]);

    const handleCopyCode = useCallback(async (text) => {
        const toCopy = text || roomCode;
        try {
            await navigator.clipboard.writeText(toCopy);
        } catch {
            console.warn('[Nextra] Clipboard API unavailable');
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, [roomCode]);

    const localWatchLink = roomCode ? `${lanBaseUrl}/#watch/${roomCode}` : '';
    const publicWatchLink = roomCode && shareBaseUrl ? `${shareBaseUrl}/#watch/${roomCode}` : '';
    const showPublicLink = !!publicWatchLink && publicWatchLink !== localWatchLink;
    const publicLinkHint = showPublicLink
        ? ''
        : publicShareStatus === 'starting'
            ? 'Public link is starting automatically. Wait a few seconds and it will appear here.'
            : publicShareStatus === 'error'
                ? `Public link unavailable on this machine. ${publicShareError || 'Built-in tunnel startup failed.'}`
                : 'Public link unavailable on this machine. Share the local link or room code instead.';
    const formattedRoomCode = roomCode ? `${roomCode.slice(0, 3)}-${roomCode.slice(3)}` : '';

    return (
        <div className="view-container">
            <div className="view-header">
                <h1>Host</h1>
                <p className="subtitle">Share your screen with viewers</p>
            </div>

            <div className="host-layout">
                <div className="host-video-section">
                    <div className="video-container">
                        <video ref={videoRef} autoPlay muted playsInline className="video-player" />
                        {status === 'idle' && (
                            <div className="video-overlay">
                                <p>No screen shared yet</p>
                            </div>
                        )}
                    </div>

                    <div className="controls">
                        {!isSharing ? (
                            <button
                                className="btn btn-primary btn-large"
                                onClick={handleStartSharing}
                                disabled={status === 'connecting'}
                            >
                                {status === 'connecting' ? 'Connecting...' : 'Start Sharing'}
                            </button>
                        ) : (
                            <>
                                <button className="btn btn-danger" onClick={handleStopSharing}>
                                    Stop Sharing
                                </button>
                                <div className="mode-toggle">
                                    <button
                                        className={frameRate === 60 ? 'active' : ''}
                                        onClick={() => setFrameRate(60)}
                                    >
                                        60fps
                                    </button>
                                    <button
                                        className={frameRate === 30 ? 'active' : ''}
                                        onClick={() => setFrameRate(30)}
                                    >
                                        30fps
                                    </button>
                                </div>
                            </>
                        )}
                    </div>

                    {isSharing && (
                        <div className="status-bar">
                            <span className="status-dot streaming" /> Streaming ({QUALITY_PROFILES[qualityProfile]?.label || qualityProfile} @ {frameRate}fps)
                            {relayViewerCount > 0 ? ` | Relay fallback viewers: ${relayViewerCount}` : ''}
                        </div>
                    )}
                </div>

                <div className="host-side-panel">
                    {status === 'idle' && (
                        <div className="settings-panel">
                            <h3>Settings</h3>
                            <div className="setting-row">
                                <input
                                    type="checkbox"
                                    id="allowMediaControl"
                                    checked={allowMediaControl}
                                    onChange={(evt) => setAllowMediaControl(evt.target.checked)}
                                />
                                <label htmlFor="allowMediaControl">
                                    Allow viewers to pause/play media
                                    <span className="setting-hint">
                                        Viewers can remotely press Play/Pause on your keyboard
                                    </span>
                                </label>
                            </div>
                            <div className="setting-row" style={{ alignItems: 'center' }}>
                                <label htmlFor="qualityProfile" style={{ minWidth: '140px' }}>
                                    Resolution
                                </label>
                                <select
                                    id="qualityProfile"
                                    value={qualityProfile}
                                    onChange={(evt) => setQualityProfile(evt.target.value)}
                                    className="select-input"
                                >
                                    {Object.entries(QUALITY_PROFILES).map(([key, profile]) => (
                                        <option key={key} value={key}>{profile.label}</option>
                                    ))}
                                </select>
                            </div>
                            <div className="setting-row" style={{ alignItems: 'center' }}>
                                <label htmlFor="frameRate" style={{ minWidth: '140px' }}>
                                    Frame rate
                                </label>
                                <select
                                    id="frameRate"
                                    value={frameRate}
                                    onChange={(evt) => setFrameRate(Number(evt.target.value))}
                                    className="select-input"
                                >
                                    <option value={60}>60 fps</option>
                                    <option value={30}>30 fps</option>
                                </select>
                            </div>
                            <div className="setting-row">
                                <input
                                    type="checkbox"
                                    id="autoTuneQuality"
                                    checked={autoTuneQuality}
                                    onChange={(evt) => setAutoTuneQuality(evt.target.checked)}
                                />
                                <label htmlFor="autoTuneQuality">
                                    Auto-tune quality from live room metrics
                                    <span className="setting-hint">
                                        Uses viewer count, relay usage, and host upload estimate
                                    </span>
                                </label>
                            </div>
                        </div>
                    )}

                    {error && <div className="alert alert-error">{error}</div>}
                    {bandwidthWarning && <div className="alert alert-warning">{bandwidthWarning}</div>}

                    {roomCode && (
                        <div className="room-info">
                            <div className="room-code-display">
                                <span className="room-code-label">Room Code</span>
                                <span className="room-code" onClick={() => handleCopyCode(formattedRoomCode)} title="Click to copy">
                                    {formattedRoomCode}
                                </span>

                                <div style={{ display: 'flex', gap: '2rem', marginTop: '1rem', flexWrap: 'wrap' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                                        <span className="room-code-label">Local Link</span>
                                        <span
                                            className="room-link"
                                            onClick={() => handleCopyCode(localWatchLink)}
                                            title="Click to copy local link"
                                        >
                                            {localWatchLink}
                                        </span>
                                    </div>
                                    {showPublicLink && (
                                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                                            <span className="room-code-label">Public Link</span>
                                            <span
                                                className="room-link"
                                                onClick={() => handleCopyCode(publicWatchLink)}
                                                title="Click to copy public link"
                                            >
                                                {publicWatchLink}
                                            </span>
                                        </div>
                                    )}
                                </div>

                                {!showPublicLink && (
                                    <span className="copy-hint" style={{ marginTop: '0.5rem' }}>
                                        {publicLinkHint}
                                    </span>
                                )}

                                <span className="copy-hint" style={{ marginTop: '0.75rem' }}>
                                    {copied ? 'Copied!' : 'Click any link above to copy'}
                                </span>
                            </div>
                            <div className="viewer-count">
                                <span className="viewer-icon" style={{ fontSize: '1.2rem', marginRight: '0.2rem' }}>&bull;</span>
                                <span>{viewerCount} viewer{viewerCount !== 1 ? 's' : ''}</span>
                            </div>
                            {roomMetrics && (
                                <div className="copy-hint" style={{ marginTop: '0.75rem' }}>
                                    WebRTC consumers: {roomMetrics.mediasoupConsumerCount || 0} | Relay out: {formatBytes(roomMetrics.relay?.bytesForwarded || 0)}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

