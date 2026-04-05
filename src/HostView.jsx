import React, { useState, useRef, useEffect, useCallback, useContext } from 'react';
import { SocketContext } from './context/SocketContext';
import { getDevice, resetDevice, socketRequest } from './lib/mediasoupClient';
import { configureObsStream, stopObsStream } from './lib/obsWebSocket';

const VIDEO_CODEC_OPTIONS = { videoGoogleStartBitrate: 5_000 };
const OBS_MAX_BITRATE_KBPS = 45_000;
const AUDIO_CODEC_OPTIONS = {
    opusStereo: 1,
    opusFec: 1,
    opusDtx: 0,
};
const OBS_TUNING_PROFILES = {
    balanced: {
        label: 'Balanced',
        bitrateMultiplier: 1,
        x264Preset: 'veryfast',
        nvencPreset: 'p5',
        nvencMultipass: 'fullres',
    },
    crisp: {
        label: 'Crisp',
        bitrateMultiplier: 1.15,
        x264Preset: 'faster',
        nvencPreset: 'p6',
        nvencMultipass: 'fullres',
    },
    max: {
        label: 'Max',
        bitrateMultiplier: 1.3,
        x264Preset: 'fast',
        nvencPreset: 'p6',
        nvencMultipass: 'fullres',
    },
};

const QUALITY_PROFILES = {
    '4k': {
        label: '4K',
        maxSpatialLayer: 2,
        capture: { width: 3840, height: 2160 },
        relayBitsPerSecond: { 30: 26_000_000, 60: 36_000_000 },
        obsBitrateKbps: { 30: 30_000, 60: 40_000 },
    },
    '1440p': {
        label: '1440p',
        maxSpatialLayer: 2,
        capture: { width: 2560, height: 1440 },
        relayBitsPerSecond: { 30: 14_000_000, 60: 21_000_000 },
        obsBitrateKbps: { 30: 18_000, 60: 24_000 },
    },
    '1080p': {
        label: '1080p',
        maxSpatialLayer: 2,
        capture: { width: 1920, height: 1080 },
        relayBitsPerSecond: { 30: 8_000_000, 60: 12_000_000 },
        obsBitrateKbps: { 30: 12_000, 60: 15_000 },
    },
};

function getQualityProfile(profileKey) {
    return QUALITY_PROFILES[profileKey] || QUALITY_PROFILES['1440p'];
}

function getProfileRelayBitsPerSecond(profileKey, fps) {
    const profile = getQualityProfile(profileKey);
    return fps >= 60 ? profile.relayBitsPerSecond[60] : profile.relayBitsPerSecond[30];
}

function getSimulcastEncodings(profileKey, fps) {
    const topBitrate = getProfileRelayBitsPerSecond(profileKey, fps);
    return [
        { rid: 'r0', maxBitrate: Math.max(900_000, Math.round(topBitrate * 0.12)), scaleResolutionDownBy: 4 },
        { rid: 'r1', maxBitrate: Math.max(3_000_000, Math.round(topBitrate * 0.4)), scaleResolutionDownBy: 2 },
        { rid: 'r2', maxBitrate: topBitrate },
    ];
}

async function applyProducerBitrateProfile(videoProducer, profileKey, fps) {
    const sender = videoProducer?.rtpSender;
    if (!sender?.getParameters || !sender?.setParameters) return;

    const params = sender.getParameters();
    if (!Array.isArray(params.encodings) || params.encodings.length === 0) return;

    const targetEncodings = getSimulcastEncodings(profileKey, fps);
    params.encodings = params.encodings.map((encoding, index) => {
        const target = targetEncodings[index] || targetEncodings[targetEncodings.length - 1];
        return {
            ...encoding,
            maxBitrate: target.maxBitrate,
        };
    });

    await sender.setParameters(params);
}

function createGpuCapability(overrides = {}) {
    return {
        gpu: 'unknown',
        h264EncoderIds: ['obs_x264'],
        h264Label: 'x264',
        av1Supported: false,
        ...overrides,
    };
}

/**
 * Detect host GPU and determine the preferred OBS encoder families.
 */
function detectAv1Support(renderer) {
    const normalized = String(renderer || '').toUpperCase();
    if (!normalized) return false;

    if (/NVIDIA|GEFORCE|RTX/.test(normalized)) {
        return /\bRTX\s*40\d{2}\b|\bRTX\s*50\d{2}\b|\bRTX\s*(4000|4500|5000|6000)\s*ADA\b|\bADA\b|\bL4\b|\bL40\b/.test(normalized);
    }

    if (/AMD|RADEON/.test(normalized)) {
        return /\bRX\s*7\d{3}\b|\bRADEON\s*7\d{3}\b|\b780M\b|\b880M\b|\b890M\b/.test(normalized);
    }

    if (/INTEL/.test(normalized)) {
        return /\bARC\b|\bULTRA\b/.test(normalized);
    }

    return false;
}

function detectGpuCapability() {
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) return createGpuCapability();

        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (!debugInfo) return createGpuCapability();

        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '';
        canvas.remove();
        const av1Supported = detectAv1Support(renderer);

        if (/GTX|NVIDIA|GeForce/i.test(renderer)) {
            return createGpuCapability({
                gpu: renderer,
                h264EncoderIds: ['obs_nvenc_h264_tex', 'jim_nvenc', 'obs_x264'],
                h264Label: 'NVENC',
                av1Supported,
            });
        }

        if (/AMD|Radeon/i.test(renderer)) {
            return createGpuCapability({
                gpu: renderer,
                h264EncoderIds: ['h264_texture_amf', 'obs_amf_h264', 'obs_x264'],
                h264Label: 'AMF',
                av1Supported,
            });
        }

        if (/Intel/i.test(renderer)) {
            return createGpuCapability({
                gpu: renderer,
                h264EncoderIds: ['obs_qsv11', 'obs_x264'],
                h264Label: 'QSV',
                av1Supported,
            });
        }

        return createGpuCapability({ gpu: renderer, av1Supported });
    } catch {
        return createGpuCapability();
    }
}

const gpuInfo = detectGpuCapability();

function getObsEncoderSelectionConfig(gpuCapability) {
    return {
        encoder: 'h264',
        preset: 'veryfast',
        obsEncoderIds: gpuCapability.h264EncoderIds,
    };
}

function getObsBitrateKbps(profile, fps) {
    const fpsKey = fps >= 60 ? 60 : 30;
    return profile.obsBitrateKbps[fpsKey];
}

function getObsTuningProfile(profileKey) {
    return OBS_TUNING_PROFILES[profileKey] || OBS_TUNING_PROFILES.balanced;
}

function scaleObsBitrateKbps(bitrateKbps, profileKey) {
    const tuning = getObsTuningProfile(profileKey);
    return Math.min(
        OBS_MAX_BITRATE_KBPS,
        Math.max(1000, Math.round((bitrateKbps * tuning.bitrateMultiplier) / 500) * 500),
    );
}

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
    const [hasTurnServer, setHasTurnServer] = useState(false);
    const [relayFlushIntervalMs, setRelayFlushIntervalMs] = useState(300);
    const [relayVideoBitsPerSecond, setRelayVideoBitsPerSecond] = useState(45_000_000);
    const [relayMaxChunkSize, setRelayMaxChunkSize] = useState(4 * 1024 * 1024);
    const [relayViewerCount, setRelayViewerCount] = useState(0);
    const [error, setError] = useState('');
    const [copied, setCopied] = useState(false);
    const [status, setStatus] = useState('idle');
    const [qualityProfile, setQualityProfile] = useState(() => {
        const h = window.screen.height * (window.devicePixelRatio || 1);
        if (h >= 2160) return '4k';
        if (h >= 1440) return '1440p';
        return '1080p';
    });
    const [frameRate, setFrameRate] = useState(30);
    const [roomMetrics, setRoomMetrics] = useState(null);
    const [ingestMode, setIngestMode] = useState('browser');
    const [whipConnected, setWhipConnected] = useState(false);
    const [fallbackViewerCount, setFallbackViewerCount] = useState(0);
    const [fallbackCodec, setFallbackCodec] = useState(null);
    const [fallbackAvailable, setFallbackAvailable] = useState(false);
    const [whepViewerCount, setWhepViewerCount] = useState(0);
    const [obsAutoStatus, setObsAutoStatus] = useState(''); // '' | 'configuring' | 'success' | 'error'
    const [obsAutoMessage, setObsAutoMessage] = useState('');
    const [obsPassword, setObsPassword] = useState('');
    const [obsAutoStart, setObsAutoStart] = useState(true);
    const [obsApplySettings, setObsApplySettings] = useState(true);
    const [obsTryAv1, setObsTryAv1] = useState(false);
    const [obsTuningProfile, setObsTuningProfile] = useState('balanced');
    const [hostToken, setHostToken] = useState('');

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
    const selectedProfile = getQualityProfile(qualityProfile);
    const profileRelayBits = getProfileRelayBitsPerSecond(qualityProfile, frameRate);
    const effectiveRelayBitsPerSecond = Math.min(relayVideoBitsPerSecond, profileRelayBits);
    const relayChunkEmitSize = Math.max(256 * 1024, relayMaxChunkSize - (64 * 1024));
    const estimatedMaxChunkDurationMs = Math.max(
        250,
        Math.floor((relayChunkEmitSize * 8 * 1000) / Math.max(effectiveRelayBitsPerSecond, 1)),
    );
    const relayFlushThresholdMs = Math.max(
        250,
        Math.min(relayFlushIntervalMs * 2, Math.floor(estimatedMaxChunkDurationMs * 0.45)),
    );
    const relayFlushPollIntervalMs = Math.max(
        150,
        Math.min(relayFlushIntervalMs, Math.floor(relayFlushThresholdMs / 2)),
    );
    const hasRemoteShareLink = !!shareBaseUrl && !isLikelyLocalOrigin(shareBaseUrl);
    const shouldPrewarmRelay = hasRemoteShareLink && !hasTurnServer;

    const buildObsAutoConfig = useCallback((whipUrl, bearerToken) => {
        const obsOpts = {
            whipUrl,
            bearerToken,
            password: obsPassword,
            autoStart: obsAutoStart,
        };

        if (!obsApplySettings) {
            return obsOpts;
        }

        const profile = getQualityProfile(qualityProfile);
        const encoderConfig = getObsEncoderSelectionConfig(gpuInfo);
        const tuningProfile = getObsTuningProfile(obsTuningProfile);
        const bitrateKbps = scaleObsBitrateKbps(
            getObsBitrateKbps(profile, frameRate),
            obsTuningProfile,
        );

        obsOpts.videoSettings = {
            outputWidth: profile.capture.width,
            outputHeight: profile.capture.height,
            fpsNumerator: frameRate,
            fpsDenominator: 1,
        };
        obsOpts.encoderSettings = {
            bitrateKbps,
            keyframeIntervalSec: 2,
            preset: encoderConfig.encoder === 'h264' ? tuningProfile.x264Preset : encoderConfig.preset,
            encoder: encoderConfig.encoder,
            obsEncoderIds: encoderConfig.obsEncoderIds,
            nvencPreset: tuningProfile.nvencPreset,
            nvencMultipass: tuningProfile.nvencMultipass,
            tuningLabel: tuningProfile.label,
        };

        return obsOpts;
    }, [frameRate, obsApplySettings, obsAutoStart, obsPassword, qualityProfile, obsTuningProfile]);


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
        };
        socket.on('viewer-count', onViewerCount);
        return () => socket.off('viewer-count', onViewerCount);
    }, [socket]);

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

    const emitRelayChunk = useCallback((blob) => {
        if (!blob || blob.size <= 0) return;

        if (blob.size <= relayMaxChunkSize) {
            socket.emit('media-chunk', blob);
            return;
        }

        let emittedParts = 0;
        for (let offset = 0; offset < blob.size; offset += relayChunkEmitSize) {
            const part = blob.slice(offset, Math.min(offset + relayChunkEmitSize, blob.size));
            if (part.size > 0) {
                socket.emit('media-chunk', part);
                emittedParts += 1;
            }
        }

        console.warn(
            `[Nextra-Host] Split oversized relay chunk (${blob.size} bytes) into ${emittedParts} parts of up to ${relayChunkEmitSize} bytes.`,
        );
    }, [socket, relayMaxChunkSize, relayChunkEmitSize]);

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
                emitRelayChunk(evt.data);
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
                && (Date.now() - lastChunkAt) > relayFlushThresholdMs
            ) {
                recorder.requestData();
            }
        }, relayFlushPollIntervalMs);
    }, [
        socket,
        emitRelayChunk,
        effectiveRelayBitsPerSecond,
        relayFlushPollIntervalMs,
        relayFlushThresholdMs,
        relayFlushIntervalMs,
    ]);

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
        setHostToken('');
        hostTokenRef.current = null;
        videoProducerRef.current = null;
        setViewerCount(0);
        setWhepViewerCount(0);
        setRelayViewerCount(0);
        setRoomMetrics(null);
        setWhipConnected(false);
        setFallbackViewerCount(0);
        setFallbackCodec(null);
        setFallbackAvailable(false);
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
                setWhepViewerCount(Math.max(0, Number(data.whepViewerCount) || 0));
                if (data.whipConnected !== undefined) setWhipConnected(data.whipConnected);
                if (data.fallbackViewerCount !== undefined) setFallbackViewerCount(data.fallbackViewerCount);
                if (data.fallbackCodec) setFallbackCodec(data.fallbackCodec);
                if (data.fallbackAvailable !== undefined) setFallbackAvailable(data.fallbackAvailable);
            }
        };

        socket.on('room-metrics', onRoomMetrics);
        return () => socket.off('room-metrics', onRoomMetrics);
    }, [socket]);

    useEffect(() => {
        const onTransportFailed = ({ reason } = {}) => {
            cleanup();
            setError(reason || 'Host media connection failed. Please start sharing again.');
        };

        socket.on('transport-failed', onTransportFailed);
        return () => socket.off('transport-failed', onTransportFailed);
    }, [socket, cleanup]);

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
                    setWhepViewerCount(Math.max(0, Number(metrics.whepViewerCount) || 0));
                }
            })
            .catch(() => { });
    }, [socket, roomCode]);

    useEffect(() => {
        if (!isSharing) return undefined;

        const onRelayDemandChanged = ({ count } = {}) => {
            const nextCount = Math.max(0, Number(count) || 0);
            setRelayViewerCount(nextCount);
        };

        socket.on('relay-demand-changed', onRelayDemandChanged);
        return () => socket.off('relay-demand-changed', onRelayDemandChanged);
    }, [socket, isSharing]);

    const applyQualityProfileToLiveStream = useCallback(async (profileKey, fps) => {
        const profile = getQualityProfile(profileKey);
        const videoProducer = videoProducerRef.current;
        if (videoProducer) {
            try {
                await videoProducer.setMaxSpatialLayer(profile.maxSpatialLayer);
            } catch (err) {
                console.warn('[Nextra-Host] Failed to apply producer layer profile:', err.message);
            }
            try {
                await applyProducerBitrateProfile(videoProducer, profileKey, fps);
            } catch (err) {
                console.warn('[Nextra-Host] Failed to apply producer bitrate profile:', err.message);
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

        if (relayViewerCount > 0 || shouldPrewarmRelay) {
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
        shouldPrewarmRelay,
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
            if (ingestMode !== 'obs') {
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
            }

            // Best effort cleanup for stale socket room state before creating a fresh room.
            try {
                await socketRequest(socket, 'leave-room', {}, { timeoutMs: 5000, maxAttempts: 1 });
            } catch { }

            const { code, hostToken } = await socketRequest(socket, 'create-room', { allowMediaControl, ingestMode });
            setRoomCode(code);
            setHostToken(hostToken || '');
            hostTokenRef.current = hostToken || null;

            if (ingestMode !== 'obs') {
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
                    track: streamRef.current.getVideoTracks()[0],
                    encodings: getSimulcastEncodings(qualityProfile, frameRate),
                    codecOptions: VIDEO_CODEC_OPTIONS,
                });
                videoProducerRef.current = videoProducer;
                try {
                    await videoProducer.setMaxSpatialLayer(selectedProfile.maxSpatialLayer);
                } catch (err) {
                    console.warn('[Nextra-Host] Could not apply initial profile layer:', err.message);
                }

                const audioTracks = streamRef.current.getAudioTracks();
                if (audioTracks.length > 0) {
                    await sendTransport.produce({
                        track: audioTracks[0],
                        codecOptions: AUDIO_CODEC_OPTIONS,
                    });
                }
            }

            setRelayViewerCount(0);
            setIsSharing(true);
            setStatus('streaming');

            // Auto-configure OBS via WebSocket when in OBS mode
            if (ingestMode === 'obs' && code && hostToken) {
                const whipUrl = `http://${window.location.hostname}:3001/whip/broadcast/${code}`;
                setObsAutoStatus('configuring');
                setObsAutoMessage('Connecting to OBS...');
                configureObsStream(buildObsAutoConfig(whipUrl, hostToken)).then((result) => {
                    setObsAutoStatus(result.success ? 'success' : 'error');
                    setObsAutoMessage(result.message);
                });
            }
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
    }, [socket, allowMediaControl, ingestMode, cleanup, selectedProfile, qualityProfile, frameRate, buildObsAutoConfig]);

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
        if (typeof data.hasTurnServer === 'boolean') {
            setHasTurnServer(data.hasTurnServer);
        }
        if (typeof data.relayFlushIntervalMs === 'number' && data.relayFlushIntervalMs >= 100) {
            setRelayFlushIntervalMs(data.relayFlushIntervalMs);
        }
        if (typeof data.relayVideoBitsPerSecond === 'number' && data.relayVideoBitsPerSecond > 0) {
            setRelayVideoBitsPerSecond(data.relayVideoBitsPerSecond);
        }
        if (typeof data.mediaMaxChunkSize === 'number' && data.mediaMaxChunkSize > 0) {
            setRelayMaxChunkSize(data.mediaMaxChunkSize);
        }
    }, []);

    useEffect(() => {
        const onServerConfig = (data) => applyServerConfig(data);
        socket.on('server-config', onServerConfig);
        socket.emit('request-server-config');

        return () => socket.off('server-config', onServerConfig);
    }, [socket, applyServerConfig]);

    const handleStopSharing = useCallback(() => {
        // Stop OBS streaming if in OBS mode
        if (ingestMode === 'obs') {
            stopObsStream({ password: obsPassword }).catch(() => {});
        }
        socket.emit('host-stopped');
        cleanup();
    }, [socket, cleanup, ingestMode, obsPassword]);

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
                        {isSharing && ingestMode === 'obs' && (
                            <div className="video-overlay">
                                <p>Streaming via OBS</p>
                                <p style={{ fontSize: '0.8rem', color: 'var(--text-3)', marginTop: '0.25rem' }}>
                                    {whipConnected ? 'OBS connected' : 'Waiting for OBS...'}
                                    {fallbackCodec ? ` \u00B7 ${fallbackCodec.toUpperCase()}` : ''}
                                    {(viewerCount + whepViewerCount) > 0 ? ` \u00B7 ${viewerCount + whepViewerCount} viewer${(viewerCount + whepViewerCount) !== 1 ? 's' : ''}` : ''}
                                </p>
                            </div>
                        )}
                    </div>

                    <div className="controls">
                        {!isSharing ? (
                            <>
                                <button
                                    className="btn btn-primary btn-large"
                                    onClick={handleStartSharing}
                                    disabled={status === 'connecting'}
                                >
                                    {status === 'connecting' ? 'Connecting...' : 'Start Sharing'}
                                </button>
                                {ingestMode === 'obs' && obsApplySettings && (
                                    <div className="mode-toggle" role="group" aria-label="OBS tuning profile">
                                        {Object.entries(OBS_TUNING_PROFILES).map(([key, tuning]) => (
                                            <button
                                                key={key}
                                                type="button"
                                                className={obsTuningProfile === key ? 'active' : ''}
                                                aria-pressed={obsTuningProfile === key}
                                                onClick={() => setObsTuningProfile(key)}
                                            >
                                                {tuning.label}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </>
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
                        <div className={`settings-wrapper${ingestMode === 'obs' ? ' settings-expanded' : ''}`}>
                        <div className="settings-panel">
                            <h3>Settings</h3>
                            <div className="setting-row setting-row-toggle">
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
                            <div className="setting-row setting-row-inline" style={{ alignItems: 'center' }}>
                                <label htmlFor="qualityProfile" className="setting-row-label" style={{ minWidth: '140px' }}>
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
                            <div className="setting-row setting-row-inline" style={{ alignItems: 'center' }}>
                                <label htmlFor="frameRate" className="setting-row-label" style={{ minWidth: '140px' }}>
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
                            <div className="setting-row setting-row-toggle">
                                <input
                                    type="checkbox"
                                    id="obsMode"
                                    checked={ingestMode === 'obs'}
                                    onChange={(e) => setIngestMode(e.target.checked ? 'obs' : 'browser')}
                                />
                                <label htmlFor="obsMode">
                                    Use OBS (WHIP ingest)
                                    <span className="setting-hint">
                                        Stream via OBS instead of browser screen capture
                                    </span>
                                </label>
                            </div>
                        </div>
                            <div
                                className="settings-panel obs-config-panel"
                                aria-hidden={ingestMode !== 'obs'}
                            >
                                    <h3>OBS Configuration</h3>
                                    <div className="setting-row setting-row-toggle">
                                        <input
                                            type="checkbox"
                                            id="obsApplySettings"
                                            checked={obsApplySettings}
                                            onChange={(e) => setObsApplySettings(e.target.checked)}
                                        />
                                        <label htmlFor="obsApplySettings">
                                            Apply recommended output settings
                                            <span className="setting-hint">
                                                {selectedProfile.capture.width}x{selectedProfile.capture.height} @ {frameRate}fps, low-latency tuning
                                            </span>
                                        </label>
                                    </div>
                                    <div className="setting-row setting-row-toggle">
                                        <input
                                            type="checkbox"
                                            id="obsTryAv1"
                                            checked={obsTryAv1}
                                            disabled={!gpuInfo.av1Supported}
                                            onChange={(e) => setObsTryAv1(e.target.checked)}
                                        />
                                        <label htmlFor="obsTryAv1">
                                            Use BYOK TURN (AV1)
                                            <span className="setting-hint">Improve quality by bringing your own key from a remote TURN server</span>
                                            {!gpuInfo.av1Supported && (
                                                <span className="setting-hint">
                                                    Disabled: AV1 encode was not detected on this host GPU.
                                                </span>
                                            )}
                                        </label>
                                    </div>
                                    <div className="setting-row setting-row-toggle">
                                        <input
                                            type="checkbox"
                                            id="obsAutoStart"
                                            checked={obsAutoStart}
                                            onChange={(e) => setObsAutoStart(e.target.checked)}
                                        />
                                        <label htmlFor="obsAutoStart">
                                            Auto-start streaming in OBS
                                            <span className="setting-hint">
                                                Begin streaming immediately after configuration
                                            </span>
                                        </label>
                                    </div>
                                    <div className="setting-row setting-row-inline" style={{ alignItems: 'center' }}>
                                        <label htmlFor="obsPassword" className="setting-row-label" style={{ minWidth: '90px', flexShrink: 0 }}>
                                            WS password
                                        </label>
                                        <input
                                            id="obsPassword"
                                            type="password"
                                            value={obsPassword}
                                            onChange={(e) => setObsPassword(e.target.value)}
                                            placeholder="(leave empty if no auth)"
                                            className="select-input"
                                        />
                                    </div>
                                </div>
                        </div>
                    )}

                    {error && <div className="alert alert-error">{error}</div>}
                    {bandwidthWarning && <div className="alert alert-warning">{bandwidthWarning}</div>}

                    {roomCode && (
                        <div className={ingestMode === 'obs' ? 'streaming-info-row' : ''}>
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
                                <span>{viewerCount + whepViewerCount} viewer{(viewerCount + whepViewerCount) !== 1 ? 's' : ''}</span>
                                {whepViewerCount > 0 && (
                                    <span className="copy-hint" style={{ marginLeft: '0.5rem', fontSize: '0.8rem' }}>
                                        ({viewerCount} WebRTC · {whepViewerCount} WHEP)
                                    </span>
                                )}
                            </div>
                            {roomMetrics && (
                                <div className="copy-hint" style={{ marginTop: '0.75rem' }}>
                                    WebRTC consumers: {roomMetrics.mediasoupConsumerCount || 0} | Relay out: {formatBytes(roomMetrics.relay?.bytesForwarded || 0)}
                                </div>
                            )}
                            {ingestMode === 'obs' && (
                                <div className="copy-hint" style={{ marginTop: '0.25rem' }}>
                                    Fallback viewers: {fallbackViewerCount} |{' '}
                                    Codec: {fallbackCodec || 'waiting'} |{' '}
                                    {fallbackAvailable ? 'Fallback active' : 'Fallback inactive'}
                                </div>
                            )}
                        </div>
                    {ingestMode === 'obs' && (
                        <div className="obs-whip-setup-panel room-info">
                            <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem' }}>OBS WHIP Setup</h3>

                                    {obsAutoStatus === 'configuring' && (
                                        <div style={{ fontSize: '0.85rem', color: '#5b8def', marginBottom: '0.5rem' }}>
                                            {obsAutoMessage}
                                        </div>
                                    )}
                                    {obsAutoStatus === 'success' && (
                                        <div style={{ fontSize: '0.85rem', color: '#3ccb7f', marginBottom: '0.5rem' }}>
                                            {obsAutoMessage}
                                        </div>
                                    )}
                                    {obsAutoStatus === 'error' && (
                                        <div style={{ fontSize: '0.85rem', color: '#e5a84b', marginBottom: '0.5rem' }}>
                                            {obsAutoMessage}
                                        </div>
                                    )}

                                    {obsAutoStatus === 'error' && (
                                        <div style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>
                                            <button
                                                onClick={() => {
                                                    const whipUrl = `http://${window.location.hostname}:3001/whip/broadcast/${roomCode}`;
                                                    setObsAutoStatus('configuring');
                                                    setObsAutoMessage('Connecting to OBS...');
                                                    const retryOpts = {
                                                        ...buildObsAutoConfig(whipUrl, hostTokenRef.current),
                                                    };
                                                    configureObsStream(retryOpts).then((result) => {
                                                        setObsAutoStatus(result.success ? 'success' : 'error');
                                                        setObsAutoMessage(result.message);
                                                    });
                                                }}
                                                style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem', cursor: 'pointer', borderRadius: '4px', border: '1px solid #555', background: '#2a2a3e', color: '#fff' }}
                                            >
                                                Retry Auto-Configure OBS
                                            </button>
                                        </div>
                                    )}

                                    <details style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                                        <summary style={{ cursor: 'pointer', color: '#aaa' }}>Manual setup (if auto-config fails)</summary>
                                        <div style={{ marginTop: '0.5rem' }}>
                                            <div style={{ marginBottom: '0.5rem' }}>
                                                <strong>WHIP URL:</strong>
                                                <code style={{ display: 'block', padding: '0.5rem', background: '#0d0d1a', borderRadius: '4px', marginTop: '0.25rem', wordBreak: 'break-all', userSelect: 'all' }}>
                                                    {`http://${window.location.hostname}:3001/whip/broadcast/${roomCode}`}
                                                </code>
                                            </div>
                                            <div style={{ marginBottom: '0.5rem' }}>
                                                <strong>Bearer Token:</strong>
                                                <code style={{ display: 'block', padding: '0.5rem', background: '#0d0d1a', borderRadius: '4px', marginTop: '0.25rem', wordBreak: 'break-all', userSelect: 'all' }}>
                                                    {hostToken}
                                                </code>
                                            </div>
                                            <div style={{ color: '#aaa' }}>
                                                In OBS: Settings &rarr; Stream &rarr; Service: WHIP &rarr; Server: paste URL above &rarr; Bearer Token: paste token above
                                            </div>
                                        </div>
                                    </details>

                                    <div style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
                                        Status: {whipConnected ? '\uD83D\uDFE2 OBS Connected' : '\uD83D\uDD34 Waiting for OBS...'}
                                    </div>
                        </div>
                    )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
