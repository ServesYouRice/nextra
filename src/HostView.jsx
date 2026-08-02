import React, { useState, useRef, useEffect, useCallback, useContext } from 'react';
import { SocketContext } from './context/SocketContext';
import { getDevice, resetDevice, socketRequest } from './lib/mediasoupClient';
import { configureObsStream, stopObsStream } from './lib/obsWebSocket';
import { getAv1EncoderCandidates } from './lib/obsOutputModel.mjs';
import CopyField from './components/CopyField';
import StatusPill from './components/StatusPill';
import Modal from './components/Modal';
import FirstRunGuide from './components/FirstRunGuide';
import HostDiagnostics from './components/HostDiagnostics';
import UserErrorAlert from './components/UserErrorAlert';
import RoomSharePanel from './components/RoomSharePanel';
import { useHostSessionController } from './hooks/useHostSessionController';
import { formatBytes } from './lib/formatBytes.mjs';
import { isMediaDebugEnabled } from './lib/mediaDebug.mjs';
import { evaluateHostPreflight } from './lib/hostPreflight.mjs';
import { buildDiagnosticBundle, downloadDiagnosticBundle } from './lib/diagnosticBundle.mjs';
import { setNavigationGuard } from './lib/navigationGuard.mjs';

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
const OBS_WS_PASSWORD_STORAGE_KEY = 'nextra.obsWsPassword.v1';
const BYOK_TURN_SESSION_STORAGE_KEY = 'nextra.byokTurnSession.v1';
const HOST_RECOVERY_SESSION_STORAGE_KEY = 'nextra.hostRecovery.v1';
const CAPTURE_PREFS_STORAGE_KEY = 'nextra.capturePrefs.v1';
const MEDIA_DEBUG_LOGS = isMediaDebugEnabled(window.location, window.localStorage);

function mediaDebugLog(...args) {
    if (MEDIA_DEBUG_LOGS) {
        console.log(...args);
    }
}

async function fetchDiagnosticJson(path, { acceptErrorStatus = false } = {}) {
    try {
        const response = await fetch(path, {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
        });
        if (!response.ok && !acceptErrorStatus) return null;
        return await response.json();
    } catch {
        return null;
    }
}

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

function loadStoredCapturePrefs() {
    try {
        const parsed = JSON.parse(window.localStorage.getItem(CAPTURE_PREFS_STORAGE_KEY) || 'null');
        if (!parsed || typeof parsed !== 'object') return null;
        return {
            qualityProfile: QUALITY_PROFILES[parsed.qualityProfile] ? parsed.qualityProfile : null,
            frameRate: parsed.frameRate === 30 || parsed.frameRate === 60 ? parsed.frameRate : null,
        };
    } catch {
        return null;
    }
}

function persistCapturePrefs(prefs) {
    try {
        window.localStorage.setItem(CAPTURE_PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
        // Ignore storage write failures.
    }
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
        av1EncoderIds: getAv1EncoderCandidates(),
        av1Label: 'AV1',
        ...overrides,
    };
}

/**
 * Detect the host GPU only to order OBS encoder attempts. OBS set-and-verify is
 * authoritative because WebGL renderers may be masked or misleading.
 */
function detectGpuCapability() {
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) return createGpuCapability();

        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (!debugInfo) return createGpuCapability();

        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '';
        canvas.remove();
        const av1EncoderIds = getAv1EncoderCandidates(renderer);

        if (/GTX|NVIDIA|GeForce/i.test(renderer)) {
            return createGpuCapability({
                gpu: renderer,
                h264EncoderIds: ['obs_nvenc_h264_tex', 'jim_nvenc', 'obs_x264'],
                h264Label: 'NVENC',
                av1EncoderIds,
                av1Label: 'NVENC AV1',
            });
        }

        if (/AMD|Radeon/i.test(renderer)) {
            return createGpuCapability({
                gpu: renderer,
                h264EncoderIds: ['h264_texture_amf', 'obs_amf_h264', 'obs_x264'],
                h264Label: 'AMF',
                av1EncoderIds,
                av1Label: 'AMF AV1',
            });
        }

        if (/Intel/i.test(renderer)) {
            return createGpuCapability({
                gpu: renderer,
                h264EncoderIds: ['obs_qsv11', 'obs_x264'],
                h264Label: 'QSV',
                av1EncoderIds,
                av1Label: 'QSV AV1',
            });
        }

        return createGpuCapability({ gpu: renderer, av1EncoderIds });
    } catch {
        return createGpuCapability();
    }
}

const gpuInfo = detectGpuCapability();

function getObsEncoderSelectionConfig(gpuCapability, { preferAv1 = false } = {}) {
    if (preferAv1) {
        return {
            videoCodec: 'av1',
            preset: 'p5',
            obsEncoderIds: gpuCapability.av1EncoderIds,
            label: gpuCapability.av1Label || 'AV1',
        };
    }

    return {
        videoCodec: 'h264',
        preset: 'veryfast',
        obsEncoderIds: gpuCapability.h264EncoderIds,
        label: gpuCapability.h264Label || 'H.264',
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

function formatHostForUrl(host) {
    const value = String(host || '127.0.0.1').trim() || '127.0.0.1';
    return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
}

function parseTurnUrlInput(value) {
    return String(value || '')
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function buildByokTurnConfig({ urlsInput, authType, secret, username, credential }) {
    const urls = parseTurnUrlInput(urlsInput);
    if (urls.length === 0) {
        throw new Error('AV1 mode requires at least one TURN URL.');
    }

    if (authType === 'static') {
        if (!String(username || '').trim() || !String(credential || '').trim()) {
            throw new Error('AV1 mode requires a TURN username and credential.');
        }
        return {
            urls,
            authType: 'static',
            username: String(username || '').trim(),
            credential: String(credential || '').trim(),
        };
    }

    if (!String(secret || '').trim()) {
        throw new Error('AV1 mode requires a TURN shared secret.');
    }

    return {
        urls,
        authType: 'secret',
        secret: String(secret || '').trim(),
    };
}

function loadStoredObsPassword() {
    try {
        // Session-only: clear any legacy long-lived localStorage copy, then read
        // from sessionStorage (survives reloads, cleared when the tab closes).
        window.localStorage.removeItem(OBS_WS_PASSWORD_STORAGE_KEY);
        return window.sessionStorage.getItem(OBS_WS_PASSWORD_STORAGE_KEY) || '';
    } catch {
        return '';
    }
}

function persistObsPassword(value) {
    try {
        const normalized = String(value || '');
        if (normalized) {
            window.sessionStorage.setItem(OBS_WS_PASSWORD_STORAGE_KEY, normalized);
        } else {
            window.sessionStorage.removeItem(OBS_WS_PASSWORD_STORAGE_KEY);
        }
    } catch {
        // Ignore storage write failures.
    }
}

function loadStoredByokTurnSession() {
    try {
        const raw = window.sessionStorage.getItem(BYOK_TURN_SESSION_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return {
            urls: String(parsed.urls || ''),
            authType: parsed.authType === 'static' ? 'static' : 'secret',
            secret: String(parsed.secret || ''),
            username: String(parsed.username || ''),
            credential: String(parsed.credential || ''),
        };
    } catch {
        return null;
    }
}

function clearStoredByokTurnSession() {
    try {
        window.sessionStorage.removeItem(BYOK_TURN_SESSION_STORAGE_KEY);
    } catch {
        // Ignore storage write failures.
    }
}

function persistByokTurnSession({ urls, authType, secret, username, credential }) {
    try {
        window.sessionStorage.setItem(BYOK_TURN_SESSION_STORAGE_KEY, JSON.stringify({
            urls: String(urls || ''),
            authType: authType === 'static' ? 'static' : 'secret',
            secret: String(secret || ''),
            username: String(username || ''),
            credential: String(credential || ''),
        }));
    } catch {
        // Ignore storage write failures.
    }
}

function loadHostRecoverySession() {
    try {
        const parsed = JSON.parse(window.sessionStorage.getItem(HOST_RECOVERY_SESSION_STORAGE_KEY) || 'null');
        if (parsed?.code && parsed?.hostToken) return parsed;
    } catch { }
    return null;
}

function persistHostRecoverySession(session) {
    try { window.sessionStorage.setItem(HOST_RECOVERY_SESSION_STORAGE_KEY, JSON.stringify(session)); } catch { }
}

function clearHostRecoverySession() {
    try { window.sessionStorage.removeItem(HOST_RECOVERY_SESSION_STORAGE_KEY); } catch { }
}

export default function HostView() {
    const socket = useContext(SocketContext);
    const [storedByokTurnSession] = useState(() => loadStoredByokTurnSession());
    const [roomCode, setRoomCode] = useState(null);
    const [isSharing, setIsSharing] = useState(false);
    const [viewerCount, setViewerCount] = useState(0);
    const contentMode = 'motion';
    const [allowMediaControl, setAllowMediaControl] = useState(false);
    const [roomPassphrase, setRoomPassphrase] = useState('');
    const [reloadRecoveryEnabled, setReloadRecoveryEnabled] = useState(false);
    const [resumePending, setResumePending] = useState(false);
    const [remoteMediaControlEnabled, setRemoteMediaControlEnabled] = useState(false);
    const [hostUploadMbps, setHostUploadMbps] = useState(20);
    const [lanBaseUrl, setLanBaseUrl] = useState(window.location.origin);
    const [shareBaseUrl, setShareBaseUrl] = useState('');
    const [publicShareStatus, setPublicShareStatus] = useState('disabled');
    const [publicShareError, setPublicShareError] = useState('');
    const [publicAv1Supported, setPublicAv1Supported] = useState(false);
    const [hasTurnServer, setHasTurnServer] = useState(false);
    const [whipHttpHost, setWhipHttpHost] = useState('127.0.0.1');
    const [whipHttpPort, setWhipHttpPort] = useState(3001);
    const [whipHttpStatus, setWhipHttpStatus] = useState('starting');
    const [whipHttpError, setWhipHttpError] = useState('');
    const [relayFlushIntervalMs, setRelayFlushIntervalMs] = useState(300);
    const [relayVideoBitsPerSecond, setRelayVideoBitsPerSecond] = useState(45_000_000);
    const [relayMaxChunkSize, setRelayMaxChunkSize] = useState(4 * 1024 * 1024);
    const [relayViewerCount, setRelayViewerCount] = useState(0);
    const [error, setError] = useState('');
    const [preflightWarnings, setPreflightWarnings] = useState([]);
    const [diagnosticDownloading, setDiagnosticDownloading] = useState(false);
    const [diagnosticDownloadStatus, setDiagnosticDownloadStatus] = useState('');
    const [status, setStatus] = useState('idle');
    const [terminalRoomEnded, setTerminalRoomEnded] = useState(false);
    const [showStopConfirm, setShowStopConfirm] = useState(false);
    const [pendingNavRoute, setPendingNavRoute] = useState(null);
    const [whepEnabled, setWhepEnabled] = useState(false);
    const [qualityProfile, setQualityProfile] = useState(() => {
        const stored = loadStoredCapturePrefs();
        if (stored?.qualityProfile) return stored.qualityProfile;
        const h = window.screen.height * (window.devicePixelRatio || 1);
        if (h >= 2160) return '4k';
        if (h >= 1440) return '1440p';
        return '1080p';
    });
    const [frameRate, setFrameRate] = useState(() => loadStoredCapturePrefs()?.frameRate || 60);
    const [roomMetrics, setRoomMetrics] = useState(null);
    const [ingestMode, setIngestMode] = useState('browser');
    const [whipConnected, setWhipConnected] = useState(false);
    const [fallbackViewerCount, setFallbackViewerCount] = useState(0);
    const [obsVideoCodec, setObsVideoCodec] = useState(null);
    const [fallbackAvailable, setFallbackAvailable] = useState(false);
    const [roomHasTurnServer, setRoomHasTurnServer] = useState(false);
    const [whepViewerCount, setWhepViewerCount] = useState(0);
    const [cloudflareTurnAutofillAvailable, setCloudflareTurnAutofillAvailable] = useState(false);
    const [cloudflareTurnAutofillLoading, setCloudflareTurnAutofillLoading] = useState(false);
    const [obsAutoStatus, setObsAutoStatus] = useState(''); // '' | 'configuring' | 'success' | 'error'
    const [obsAutoMessage, setObsAutoMessage] = useState('');
    const [obsPassword, setObsPassword] = useState(() => loadStoredObsPassword());
    const [obsAutoStart, setObsAutoStart] = useState(true);
    const [obsApplySettings, setObsApplySettings] = useState(true);
    const [obsTryAv1, setObsTryAv1] = useState(false);
    const [obsTuningProfile, setObsTuningProfile] = useState('balanced');
    const [byokTurnUrls, setByokTurnUrls] = useState(() => storedByokTurnSession?.urls || '');
    const [byokTurnAuthType, setByokTurnAuthType] = useState(() => storedByokTurnSession?.authType || 'secret');
    const [byokTurnSecret, setByokTurnSecret] = useState(() => storedByokTurnSession?.secret || '');
    const [byokTurnUsername, setByokTurnUsername] = useState(() => storedByokTurnSession?.username || '');
    const [byokTurnCredential, setByokTurnCredential] = useState(() => storedByokTurnSession?.credential || '');
    const [saveByokTurnForSession, setSaveByokTurnForSession] = useState(() => storedByokTurnSession != null);
    const [showByokTurnModal, setShowByokTurnModal] = useState(false);
    const [hostToken, setHostToken] = useState('');
    const [showFirstRun, setShowFirstRun] = useState(() => {
        try { return window.localStorage.getItem('nextra.hostGuideSeen') !== '1'; } catch { return true; }
    });

    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const videoProducerRef = useRef(null);
    const audioProducerRef = useRef(null);
    const sendTransportRef = useRef(null);
    const heartbeatRef = useRef(null);
    const safetyFlushIntervalRef = useRef(null);
    const audioCtxRef = useRef(null);
    const silentAudioTrackRef = useRef(null);
    const hostTokenRef = useRef(null);
    const roomCodeRef = useRef(null);
    const reloadRecoveryEnabledRef = useRef(false);
    const ingestModeRef = useRef('browser');
    const resumeRoomRef = useRef(null);
    const pageHidingRef = useRef(false);
    const isSharingRef = useRef(false);
    const releaseNavGuardRef = useRef(null);
    const hostUnmountTimerRef = useRef(null);
    const prevRelayViewerCountRef = useRef(0);
    const relayGenerationRef = useRef(0);

    const bitratePerViewer = viewerCount > 0 ? hostUploadMbps / viewerCount : hostUploadMbps;
    const bandwidthWarning = viewerCount >= 3 && bitratePerViewer < 7
        // 1080p at 30 fps is the lowest profile Nextra offers; never recommend a
        // resolution that is not in QUALITY_PROFILES.
        ? `${viewerCount} viewers x ~${bitratePerViewer.toFixed(1)} Mbps each. Consider 1080p at 30 fps.`
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
    const obsAv1Mode = ingestMode === 'obs' && obsTryAv1;
    const hasRemoteShareLink = !!shareBaseUrl && !isLikelyLocalOrigin(shareBaseUrl);
    const effectiveTurnAvailability = obsAv1Mode ? roomHasTurnServer : hasTurnServer;
    const shouldPrewarmRelay = ingestMode !== 'obs' && hasRemoteShareLink && !effectiveTurnAvailability;
    const byokTurnSessionHint = 'Keeps TURN credentials in session storage so they survive reloads and are cleared when the tab or window closes.';
    const buildWhipBroadcastUrl = useCallback((code) => (
        `http://${formatHostForUrl(whipHttpHost)}:${whipHttpPort}/whip/broadcast/${code}`
    ), [whipHttpHost, whipHttpPort]);

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
        const encoderConfig = getObsEncoderSelectionConfig(gpuInfo, { preferAv1: obsAv1Mode });
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
            preset: encoderConfig.videoCodec === 'h264' ? tuningProfile.x264Preset : encoderConfig.preset,
            encoder: encoderConfig.videoCodec,
            obsEncoderIds: encoderConfig.obsEncoderIds,
            nvencPreset: tuningProfile.nvencPreset,
            nvencMultipass: tuningProfile.nvencMultipass,
            tuningLabel: tuningProfile.label,
        };

        return obsOpts;
    }, [frameRate, obsApplySettings, obsAutoStart, obsAv1Mode, obsPassword, qualityProfile, obsTuningProfile]);

    useEffect(() => {
        persistObsPassword(obsPassword);
    }, [obsPassword]);

    useEffect(() => {
        persistCapturePrefs({ qualityProfile, frameRate });
    }, [qualityProfile, frameRate]);

    useEffect(() => {
        roomCodeRef.current = roomCode;
        reloadRecoveryEnabledRef.current = reloadRecoveryEnabled;
        ingestModeRef.current = ingestMode;
        isSharingRef.current = isSharing;
        if (isSharing && reloadRecoveryEnabled && roomCode && hostToken) {
            persistHostRecoverySession({ code: roomCode, hostToken, ingestMode });
        }
    }, [roomCode, hostToken, ingestMode, isSharing, reloadRecoveryEnabled]);

    useEffect(() => {
        if (!saveByokTurnForSession) {
            clearStoredByokTurnSession();
            return;
        }
        persistByokTurnSession({
            urls: byokTurnUrls,
            authType: byokTurnAuthType,
            secret: byokTurnSecret,
            username: byokTurnUsername,
            credential: byokTurnCredential,
        });
    }, [
        saveByokTurnForSession,
        byokTurnUrls,
        byokTurnAuthType,
        byokTurnSecret,
        byokTurnUsername,
        byokTurnCredential,
    ]);

    // WHEP enablement is only exposed via the HTTP config endpoint (the
    // socket server-config payload does not include it), so probe it once.
    // Everything else here also arrives over 'server-config'.
    useEffect(() => {
        const controller = new AbortController();
        fetch('/api/config', {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            signal: controller.signal,
        })
            .then((response) => (response.ok ? response.json() : null))
            .then((data) => {
                if (data) {
                    if (typeof data.whepEnabled === 'boolean') setWhepEnabled(data.whepEnabled);
                }
            })
            .catch(() => { });
        return () => controller.abort();
    }, []);

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

    const emitRelayChunk = useCallback((blob, generation) => {
        if (!blob || blob.size <= 0) return;

        if (blob.size <= relayMaxChunkSize) {
            socket.emit('media-chunk', { generation, chunk: blob });
            return;
        }

        let emittedParts = 0;
        for (let offset = 0; offset < blob.size; offset += relayChunkEmitSize) {
            const part = blob.slice(offset, Math.min(offset + relayChunkEmitSize, blob.size));
            if (part.size > 0) {
                socket.emit('media-chunk', { generation, chunk: part });
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
        const generation = ++relayGenerationRef.current;
        mediaRecorderRef.current = recorder;

        let chunkCount = 0;
        let lastChunkAt = 0;
        recorder.onstart = () => {
            lastChunkAt = Date.now();
            socket.emit('media-init', { mimeType, generation });
        };
        recorder.ondataavailable = (evt) => {
            if (evt.data && evt.data.size > 0) {
                lastChunkAt = Date.now();
                chunkCount += 1;
                if (chunkCount % 20 === 0) {
                    mediaDebugLog(`[Nextra-Host] Emitted ${chunkCount} relay chunks. Latest size: ${evt.data.size}`);
                }
                emitRelayChunk(evt.data, generation);
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

    const resetHostSessionState = useCallback(() => {
        setIsSharing(false);
        setRoomCode(null);
        setHostToken('');
        hostTokenRef.current = null;
        roomCodeRef.current = null;
        resumeRoomRef.current = null;
        clearHostRecoverySession();
        setViewerCount(0);
        setWhepViewerCount(0);
        setRelayViewerCount(0);
        setRoomMetrics(null);
        setPreflightWarnings([]);
        setWhipConnected(false);
        setFallbackViewerCount(0);
        setObsVideoCodec(null);
        setFallbackAvailable(false);
        setRoomHasTurnServer(false);
        setObsAutoStatus('');
        setObsAutoMessage('');
        setShowByokTurnModal(false);
        setStatus('idle');
        setTerminalRoomEnded(false);
        resetDevice();
    }, []);

    const cleanup = useHostSessionController({
        stopRelayRecorder,
        videoProducerRef,
        audioProducerRef,
        sendTransportRef,
        streamRef,
        videoRef,
        audioCtxRef,
        silentAudioTrackRef,
        resetState: resetHostSessionState,
    });

    const terminateHostSession = useCallback((reason) => {
        cleanup();
        setResumePending(false);
        setTerminalRoomEnded(true);
        setError(reason || 'This room ended. Create a new room to share again.');
    }, [cleanup]);

    // Leaving #host unmounts this view, which stops the stream and retires the
    // room code, so hold the route change until the host confirms.
    useEffect(() => {
        if (!isSharing) return undefined;
        const release = setNavigationGuard((targetRoute) => {
            // Re-check at call time: a stop that lands in the same task as the
            // navigation has not flushed through React state yet, and a room
            // that is already torn down has nothing left to warn about.
            if (!isSharingRef.current) return true;
            setPendingNavRoute(targetRoute);
            return false;
        });
        releaseNavGuardRef.current = release;
        return () => {
            releaseNavGuardRef.current = null;
            release();
            // Capture can end outside this view (the browser's own stop bar),
            // which drops the guard while the prompt is still open.
            setPendingNavRoute(null);
        };
    }, [isSharing]);

    useEffect(() => {
        if (hostUnmountTimerRef.current) {
            clearTimeout(hostUnmountTimerRef.current);
            hostUnmountTimerRef.current = null;
        }
        const closeHostSession = () => {
            pageHidingRef.current = true;
            if (reloadRecoveryEnabledRef.current && roomCodeRef.current && hostTokenRef.current) {
                persistHostRecoverySession({
                    code: roomCodeRef.current,
                    hostToken: hostTokenRef.current,
                    ingestMode: ingestModeRef.current,
                });
                return;
            }
            socket.emit('host-stopped');
            cleanup();
        };
        // Prompt only; tearing the room down here would strand the host on a
        // cancelled prompt with no stream. pagehide does the teardown once the
        // page is actually going away. Reload recovery makes the room
        // reclaimable, so an opted-in host is not warned.
        const confirmUnload = (event) => {
            if (isSharingRef.current && !reloadRecoveryEnabledRef.current) {
                // Leave pageHidingRef alone: a cancelled prompt would strand it
                // set and suppress the unmount teardown on a later in-app exit.
                event.preventDefault();
                event.returnValue = '';
                return;
            }
            // Unwarned paths keep the original early flag. Chromium ends
            // display-capture tracks while unloading, and the track 'ended'
            // handler must not destroy a room reload recovery will reclaim.
            pageHidingRef.current = true;
        };
        const onPageShow = () => { pageHidingRef.current = false; };
        window.addEventListener('beforeunload', confirmUnload);
        window.addEventListener('pagehide', closeHostSession);
        window.addEventListener('pageshow', onPageShow);
        return () => {
            window.removeEventListener('beforeunload', confirmUnload);
            window.removeEventListener('pagehide', closeHostSession);
            window.removeEventListener('pageshow', onPageShow);
            // Defer non-pagehide teardown by one task so React StrictMode's
            // development-only effect setup/cleanup replay can cancel it.
            hostUnmountTimerRef.current = setTimeout(() => {
                hostUnmountTimerRef.current = null;
                if (!pageHidingRef.current) {
                    socket.emit('host-stopped');
                    cleanup();
                }
            }, 0);
        };
    }, [socket, cleanup]);

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
                if (err.terminal === true) {
                    terminateHostSession(err.reason || err.message);
                }
            }
        };

        socket.on('connect', onReconnect);
        return () => socket.off('connect', onReconnect);
    }, [socket, isSharing, roomCode, terminateHostSession]);

    useEffect(() => {
        const stored = loadHostRecoverySession();
        if (!stored) return undefined;
        let cancelled = false;

        const reclaimStoredRoom = async () => {
            try {
                const response = await socketRequest(socket, 'reclaim-host', {
                    ...stored,
                    reloadRecovery: true,
                });
                if (cancelled) return;
                if (response.reloadRecoveryEnabled !== true) {
                    clearHostRecoverySession();
                    return;
                }
                setRoomCode(stored.code);
                roomCodeRef.current = stored.code;
                setHostToken(stored.hostToken);
                hostTokenRef.current = stored.hostToken;
                setReloadRecoveryEnabled(true);
                reloadRecoveryEnabledRef.current = true;
                setIngestMode(response.ingestMode === 'obs' ? 'obs' : 'browser');
                setObsVideoCodec(response.obsVideoCodec || null);
                setRoomHasTurnServer(!!response.hasRoomTurnServer);
                // Room-state responses also carry a stable `code` describing the
                // transition (for example `host-reconnected`). Preserve the room
                // identity from the authenticated recovery session explicitly.
                resumeRoomRef.current = {
                    ...response,
                    code: stored.code,
                    hostToken: stored.hostToken,
                };
                if (response.ingestMode === 'obs') {
                    setIsSharing(true);
                    setStatus('streaming');
                    setResumePending(false);
                } else {
                    setResumePending(true);
                    setStatus('idle');
                }
            } catch (err) {
                if (cancelled) return;
                terminateHostSession(err.reason || err.message || 'The previous room ended. Create a new room to continue.');
            }
        };

        reclaimStoredRoom();
        return () => { cancelled = true; };
    }, [socket, terminateHostSession]);

    useEffect(() => {
        const onRoomEnded = ({ reason } = {}) => terminateHostSession(reason);
        socket.on('room-ended', onRoomEnded);
        // Older servers used this event for process replacement. In-memory
        // rooms cannot survive either signal, so it is terminal as well.
        socket.on('server-restarting', onRoomEnded);
        return () => {
            socket.off('room-ended', onRoomEnded);
            socket.off('server-restarting', onRoomEnded);
        };
    }, [socket, terminateHostSession]);

    useEffect(() => {
        const onRoomMetrics = (data) => {
            setRoomMetrics(data || null);
            if (data) {
                setRelayViewerCount(Math.max(0, Number(data.relayViewerCount) || 0));
                setWhepViewerCount(Math.max(0, Number(data.whepViewerCount) || 0));
                if (data.whipConnected !== undefined) setWhipConnected(data.whipConnected);
                if (data.fallbackViewerCount !== undefined) setFallbackViewerCount(data.fallbackViewerCount);
                if (typeof data.obsVideoCodec === 'string') setObsVideoCodec(data.obsVideoCodec);
                if (data.fallbackAvailable !== undefined) setFallbackAvailable(data.fallbackAvailable);
                if (typeof data.hasRoomTurnServer === 'boolean') setRoomHasTurnServer(data.hasRoomTurnServer);
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
                    if (metrics.whipConnected !== undefined) setWhipConnected(metrics.whipConnected);
                    if (metrics.fallbackViewerCount !== undefined) setFallbackViewerCount(metrics.fallbackViewerCount);
                    if (typeof metrics.obsVideoCodec === 'string') setObsVideoCodec(metrics.obsVideoCodec);
                    if (metrics.fallbackAvailable !== undefined) setFallbackAvailable(metrics.fallbackAvailable);
                    if (typeof metrics.hasRoomTurnServer === 'boolean') setRoomHasTurnServer(metrics.hasRoomTurnServer);
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

    // Apply capture/producer quality changes to the live stream.
    useEffect(() => {
        if (!isSharing) return;
        void applyQualityProfileToLiveStream(qualityProfile, frameRate);
    }, [isSharing, qualityProfile, frameRate, applyQualityProfileToLiveStream]);

    // Keep one recorder generation alive while relay is needed. The server caches
    // initialization/media for late joiners, so viewer churn does not restart the
    // encoder or disrupt viewers already watching.
    useEffect(() => {
        if (!isSharing) {
            prevRelayViewerCountRef.current = 0;
            return;
        }

        const previousRelayViewerCount = prevRelayViewerCountRef.current;
        prevRelayViewerCountRef.current = relayViewerCount;

        if (relayViewerCount > 0 || shouldPrewarmRelay) {
            if (relayViewerCount > 0 && previousRelayViewerCount === 0 && mediaRecorderRef.current) {
                stopRelayRecorder();
                startRelayRecorder();
            } else if (!mediaRecorderRef.current) {
                startRelayRecorder();
            }
        } else {
            stopRelayRecorder();
        }
    }, [isSharing, relayViewerCount, shouldPrewarmRelay, startRelayRecorder, stopRelayRecorder]);

    // Recorder parameter changes (quality tier, fps, flush interval, bitrate)
    // need a restart with the new settings — but only if it is already running;
    // the membership effect above owns starting it.
    useEffect(() => {
        if (!isSharing || !mediaRecorderRef.current) return;
        stopRelayRecorder();
        startRelayRecorder();
    }, [
        isSharing,
        qualityProfile,
        frameRate,
        relayFlushIntervalMs,
        effectiveRelayBitsPerSecond,
        startRelayRecorder,
        stopRelayRecorder,
    ]);

    const handleStartSharing = useCallback(async () => {
        setError('');
        setPreflightWarnings([]);
        setTerminalRoomEnded(false);
        setStatus('connecting');
        const resumedRoom = resumeRoomRef.current;

        try {
            let roomTurnConfig = null;
            let turnConfigError = '';
            if (obsAv1Mode) {
                try {
                    roomTurnConfig = buildByokTurnConfig({
                        urlsInput: byokTurnUrls,
                        authType: byokTurnAuthType,
                        secret: byokTurnSecret,
                        username: byokTurnUsername,
                        credential: byokTurnCredential,
                    });
                } catch (turnError) {
                    setShowByokTurnModal(true);
                    turnConfigError = turnError.message;
                }
            }

            const isChromiumBrand = !!navigator.userAgentData?.brands?.some((b) => /Chrom/i.test(b.brand));
            const isChromium = isChromiumBrand || /Chrome|Chromium|Edg\//i.test(navigator.userAgent || '');
            const preflight = evaluateHostPreflight({
                ingestMode,
                captureApiAvailable: typeof navigator.mediaDevices?.getDisplayMedia === 'function',
                secureContext: window.isSecureContext === true,
                chromium: isChromium,
                whipHttpStatus,
                whipHttpError,
                obsAv1Mode,
                obsApplySettings,
                turnConfigValid: !obsAv1Mode || roomTurnConfig != null,
                turnConfigError,
                publicShareStatus,
                publicShareError,
                publicAv1Supported,
                webSocketAvailable: typeof WebSocket === 'function',
            });
            setPreflightWarnings(preflight.warnings.map(({ message }) => message));
            if (preflight.blockers.length > 0) {
                throw new Error(preflight.blockers.map(({ message }) => message).join(' '));
            }

            if (ingestMode !== 'obs') {
                // `systemAudio: 'include'` is a Chromium-only getDisplayMedia
                // option with no feature-detection API, so this probe brands the
                // capture option only. It never gates whether hosting is allowed.
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
                    // Reload recovery deliberately keeps the server-side room
                    // alive across pagehide. Chromium ends display-capture tracks
                    // while unloading; treating that teardown as a user stop
                    // would immediately destroy the room before the new page can
                    // reclaim it.
                    if (pageHidingRef.current && reloadRecoveryEnabledRef.current) return;
                    isSharingRef.current = false;
                    socket.emit('host-stopped');
                    cleanup();
                });
            }

            let createdRoom = resumedRoom;
            if (!createdRoom) {
                // Best effort cleanup for stale socket room state before creating a fresh room.
                try {
                    await socketRequest(socket, 'leave-room', {}, { timeoutMs: 5000, maxAttempts: 1 });
                } catch { }

                createdRoom = await socketRequest(socket, 'create-room', {
                    allowMediaControl,
                    ingestMode,
                    obsAv1Mode,
                    turnConfig: roomTurnConfig,
                    frameRate,
                    passphrase: roomPassphrase,
                    reloadRecoveryEnabled,
                    // H.264 fallback relay re-encode bitrate for the selected quality tier.
                    relayVideoKbps: Math.round(getProfileRelayBitsPerSecond(qualityProfile, frameRate) / 1000),
                });
            }
            const code = createdRoom.code;
            const hostToken = createdRoom.hostToken;
            const createdObsVideoCodec = createdRoom.obsVideoCodec;
            const createdRoomHasTurnServer = createdRoom.hasRoomTurnServer;
            setRoomCode(code);
            setHostToken(hostToken || '');
            hostTokenRef.current = hostToken || null;
            setObsVideoCodec(createdObsVideoCodec || null);
            setRoomHasTurnServer(!!createdRoomHasTurnServer);
            resumeRoomRef.current = null;
            setResumePending(false);

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
                sendTransportRef.current = sendTransport;

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
                    audioProducerRef.current = await sendTransport.produce({
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
                const whipUrl = buildWhipBroadcastUrl(code);
                if (whipHttpStatus !== 'ready') {
                    const message = whipHttpStatus === 'error'
                        ? `OBS WHIP endpoint is unavailable: ${whipHttpError || 'HTTP listener failed.'}`
                        : 'OBS WHIP endpoint is still starting. Retry OBS auto-configuration in a moment.';
                    setObsAutoStatus('error');
                    setObsAutoMessage(message);
                    if (obsAv1Mode) {
                        throw new Error(message);
                    }
                } else {
                    setObsAutoStatus('configuring');
                    setObsAutoMessage('Connecting to OBS...');
                    const result = await configureObsStream(buildObsAutoConfig(whipUrl, hostToken));
                    setObsAutoStatus(result.success ? 'success' : 'error');
                    setObsAutoMessage(result.message);
                    if (obsAv1Mode && !result.success) {
                        throw new Error(result.message);
                    }
                }
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
    }, [
        socket,
        allowMediaControl,
        roomPassphrase,
        reloadRecoveryEnabled,
        ingestMode,
        cleanup,
        selectedProfile,
        qualityProfile,
        frameRate,
        buildObsAutoConfig,
        buildWhipBroadcastUrl,
        byokTurnUrls,
        byokTurnAuthType,
        byokTurnSecret,
        byokTurnUsername,
        byokTurnCredential,
        obsApplySettings,
        obsAv1Mode,
        publicShareStatus,
        publicShareError,
        publicAv1Supported,
        whipHttpStatus,
        whipHttpError,
    ]);

    const handleAutofillCloudflareTurn = useCallback(async () => {
        setError('');
        setCloudflareTurnAutofillLoading(true);
        try {
            const response = await fetch('/api/cloudflare-turn-credentials', {
                method: 'POST',
                headers: {
                    accept: 'application/json',
                },
                credentials: 'same-origin',
            });

            let payload = null;
            try {
                payload = await response.json();
            } catch {
                payload = null;
            }

            if (!response.ok) {
                throw new Error(payload?.error || 'Cloudflare TURN autofill request failed.');
            }

            const turnConfig = payload?.turnConfig;
            if (!turnConfig || !Array.isArray(turnConfig.urls) || !turnConfig.username || !turnConfig.credential) {
                throw new Error('Server returned an invalid TURN credential payload.');
            }

            setByokTurnAuthType('static');
            setByokTurnUrls(turnConfig.urls.join('\n'));
            setByokTurnUsername(turnConfig.username);
            setByokTurnCredential(turnConfig.credential);
            setByokTurnSecret('');
        } catch (err) {
            setError(`Failed to autofill Cloudflare TURN: ${err.message}`);
        } finally {
            setCloudflareTurnAutofillLoading(false);
        }
    }, []);

    const applyServerConfig = useCallback((data = {}) => {
        if (typeof data.hostUploadMbps === 'number') {
            setHostUploadMbps(data.hostUploadMbps);
        }
        if (typeof data.remoteMediaControlEnabled === 'boolean') {
            setRemoteMediaControlEnabled(data.remoteMediaControlEnabled);
            if (!data.remoteMediaControlEnabled) setAllowMediaControl(false);
        }
        if (typeof data.publicAv1Supported === 'boolean') {
            setPublicAv1Supported(data.publicAv1Supported);
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
        if (typeof data.whipHttpHost === 'string' && data.whipHttpHost) {
            setWhipHttpHost(data.whipHttpHost);
        }
        if (typeof data.whipHttpPort === 'number' && data.whipHttpPort > 0) {
            setWhipHttpPort(data.whipHttpPort);
        }
        if (typeof data.whipHttpStatus === 'string') {
            setWhipHttpStatus(data.whipHttpStatus);
        }
        if (typeof data.whipHttpError === 'string') {
            setWhipHttpError(data.whipHttpError);
        }
        if (typeof data.cloudflareTurnAutofillAvailable === 'boolean') {
            setCloudflareTurnAutofillAvailable(data.cloudflareTurnAutofillAvailable);
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

    const handleDownloadDiagnostics = useCallback(async () => {
        setDiagnosticDownloading(true);
        setDiagnosticDownloadStatus('');
        try {
            const [packageInfo, readiness, publicConfig, globalMetrics] = await Promise.all([
                fetchDiagnosticJson('/api/package-info'),
                fetchDiagnosticJson('/readyz', { acceptErrorStatus: true }),
                fetchDiagnosticJson('/api/config'),
                fetchDiagnosticJson('/api/metrics'),
            ]);
            const bundle = buildDiagnosticBundle({
                packageInfo,
                readiness,
                publicConfig,
                globalMetrics,
                roomMetrics,
                hostState: {
                    ingestMode,
                    obsAv1Mode,
                    qualityProfile,
                    frameRate,
                    publicShareStatus,
                    hasTurnServer,
                    roomHasTurnServer,
                    whipHttpStatus,
                    reloadRecoveryEnabled,
                },
                clientRuntime: {
                    userAgent: navigator.userAgent || '',
                    platform: navigator.userAgentData?.platform || navigator.platform || '',
                    language: navigator.language || '',
                    secureContext: window.isSecureContext === true,
                },
                errors: [
                    error,
                    publicShareError,
                    whipHttpError,
                    obsAutoStatus === 'error' ? obsAutoMessage : '',
                    roomMetrics?.fallbackLastError,
                    ...preflightWarnings,
                ],
            });
            const filename = downloadDiagnosticBundle(bundle);
            setDiagnosticDownloadStatus(`Downloaded ${filename}.`);
        } catch (downloadError) {
            setDiagnosticDownloadStatus(`Could not prepare diagnostics: ${downloadError.message}`);
        } finally {
            setDiagnosticDownloading(false);
        }
    }, [
        roomMetrics,
        ingestMode,
        obsAv1Mode,
        qualityProfile,
        frameRate,
        publicShareStatus,
        hasTurnServer,
        roomHasTurnServer,
        whipHttpStatus,
        reloadRecoveryEnabled,
        error,
        publicShareError,
        whipHttpError,
        obsAutoStatus,
        obsAutoMessage,
        preflightWarnings,
    ]);

    const handleStopSharing = useCallback((confirmed = false) => {
        // Guard against a misclick ending everyone's session: stopping tears down
        // the room and disconnects every viewer, and the next share gets a NEW code.
        const connectedViewers = viewerCount + whepViewerCount;
        if (connectedViewers > 0 && !confirmed) {
            setShowStopConfirm(true);
            return;
        }
        // Stop OBS streaming if in OBS mode
        if (ingestMode === 'obs') {
            stopObsStream({ password: obsPassword }).catch(() => {});
        }
        // Drop the nav guard now rather than waiting for the isSharing effect, so
        // a navigation issued in this same task is not warned about a room that
        // is already gone.
        isSharingRef.current = false;
        socket.emit('host-stopped');
        cleanup();
    }, [socket, cleanup, ingestMode, obsPassword, viewerCount, whepViewerCount]);

    const handleObsTryAv1Change = useCallback((enabled) => {
        setObsTryAv1(enabled);
        if (enabled) {
            setObsApplySettings(true);
            setShowByokTurnModal(true);
            return;
        }
        setShowByokTurnModal(false);
    }, []);

    const handleIngestModeChange = useCallback((mode) => {
        setIngestMode(mode);
        if (mode !== 'obs') {
            setShowByokTurnModal(false);
        }
    }, []);

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
    const whepBaseUrl = shareBaseUrl || lanBaseUrl;
    const whepPlaybackUrl = whepEnabled && roomCode && whepBaseUrl
        ? `${whepBaseUrl}/whep/watch/${roomCode}`
        : '';
    const totalViewers = viewerCount + whepViewerCount;
    const dismissFirstRun = useCallback(() => {
        setShowFirstRun(false);
        try { window.localStorage.setItem('nextra.hostGuideSeen', '1'); } catch { }
    }, []);

    return (
        <div className="view-container">
            <div className="view-header">
                <h1>Host</h1>
                <p className="subtitle">Share your screen with viewers</p>
            </div>

            {showFirstRun && !isSharing && (
                <FirstRunGuide
                    onChoose={(mode) => { handleIngestModeChange(mode); dismissFirstRun(); }}
                    onDismiss={dismissFirstRun}
                />
            )}

            <div className="host-layout">
                <div className="host-video-section">
                    <div className="video-container">
                        <video ref={videoRef} autoPlay muted playsInline className="video-player" />
                        {status === 'idle' && (
                            <div className="video-overlay">
                                <p>No screen shared yet</p>
                                <p className="video-overlay-sub">
                                    Pick your quality in Settings, then press Start Sharing.
                                    You&apos;ll get a room code and link to send to viewers.
                                </p>
                            </div>
                        )}
                        {isSharing && ingestMode === 'obs' && (
                            <div className="video-overlay">
                                <p>Streaming via OBS</p>
                                <p className="video-overlay-sub">
                                    {whipConnected ? 'OBS connected' : 'Waiting for OBS...'}
                                    {obsVideoCodec ? ` \u00B7 ${obsVideoCodec.toUpperCase()}` : ''}
                                    {totalViewers > 0 ? ` \u00B7 ${totalViewers} viewer${totalViewers !== 1 ? 's' : ''}` : ''}
                                </p>
                            </div>
                        )}
                    </div>

                    {!isSharing ? (
                        <>
                            <div className="controls">
                                <button
                                    className="btn btn-primary btn-large"
                                    onClick={handleStartSharing}
                                    disabled={status === 'connecting'}
                                >
                                    {status === 'connecting'
                                        ? 'Connecting...'
                                        : resumePending
                                            ? 'Resume Sharing'
                                            : terminalRoomEnded
                                                ? 'Create new room'
                                                : 'Start Sharing'}
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
                            </div>
                            <div className="capture-settings">
                                <div className="setting-row setting-row-inline">
                                    <span className="setting-row-label">Resolution</span>
                                    <div className="mode-toggle" role="group" aria-label="Resolution">
                                        {Object.entries(QUALITY_PROFILES).map(([key, profile]) => (
                                            <button
                                                key={key}
                                                type="button"
                                                className={qualityProfile === key ? 'active' : ''}
                                                aria-pressed={qualityProfile === key}
                                                onClick={() => setQualityProfile(key)}
                                            >
                                                {profile.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="setting-row setting-row-inline">
                                    <span className="setting-row-label">Frame rate</span>
                                    <div className="mode-toggle" role="group" aria-label="Frame rate">
                                        {[60, 30].map((fps) => (
                                            <button
                                                key={fps}
                                                type="button"
                                                className={frameRate === fps ? 'active' : ''}
                                                aria-pressed={frameRate === fps}
                                                onClick={() => setFrameRate(fps)}
                                            >
                                                {fps} fps
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="controls">
                                <button
                                    className="btn btn-danger"
                                    onClick={() => {
                                        handleStopSharing();
                                    }}
                                >
                                    Stop Sharing
                                </button>
                                {/* Browser-capture resolution is applied live via
                                    applyQualityProfileToLiveStream, so keep it
                                    adjustable while streaming (mirrors the live fps
                                    toggle). OBS resolution is fixed at config time. */}
                                {ingestMode !== 'obs' && (
                                    <div className="mode-toggle" role="group" aria-label="Resolution">
                                        {Object.entries(QUALITY_PROFILES).map(([key, profile]) => (
                                            <button
                                                key={key}
                                                type="button"
                                                className={qualityProfile === key ? 'active' : ''}
                                                aria-pressed={qualityProfile === key}
                                                onClick={() => setQualityProfile(key)}
                                            >
                                                {profile.label}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <div className="mode-toggle" role="group" aria-label="Frame rate">
                                    {[60, 30].map((fps) => (
                                        <button
                                            key={fps}
                                            type="button"
                                            className={frameRate === fps ? 'active' : ''}
                                            aria-pressed={frameRate === fps}
                                            onClick={() => setFrameRate(fps)}
                                        >
                                            {fps} fps
                                        </button>
                                    ))}
                                </div>
                        </div>
                    )}

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
                            <div className="advanced-settings advanced-settings-lead">
                                <div className="setting-row setting-row-toggle">
                                    <input
                                        type="checkbox"
                                        id="allowMediaControl"
                                        checked={allowMediaControl}
                                        disabled={!remoteMediaControlEnabled}
                                        onChange={(evt) => setAllowMediaControl(evt.target.checked)}
                                    />
                                    <label htmlFor="allowMediaControl">
                                        Allow viewers to pause/play media
                                        <span className="setting-hint">
                                            {remoteMediaControlEnabled
                                                ? 'Viewers can remotely press Play/Pause on your keyboard'
                                                : 'Disabled by the server operator'}
                                        </span>
                                    </label>
                                </div>
                                <div className="setting-row">
                                    <label htmlFor="roomPassphrase">
                                        Optional room passphrase
                                        <span className="setting-hint">Viewers must enter it after the room code</span>
                                    </label>
                                    <input
                                        id="roomPassphrase"
                                        type="password"
                                        value={roomPassphrase}
                                        maxLength={128}
                                        autoComplete="new-password"
                                        onChange={(evt) => setRoomPassphrase(evt.target.value)}
                                        className="select-input"
                                    />
                                </div>
                                <div className="setting-row setting-row-toggle">
                                    <input
                                        type="checkbox"
                                        id="reloadRecoveryEnabled"
                                        checked={reloadRecoveryEnabled}
                                        onChange={(evt) => setReloadRecoveryEnabled(evt.target.checked)}
                                    />
                                    <label htmlFor="reloadRecoveryEnabled">
                                        Allow recovery after reload
                                        <span className="setting-hint">Keeps this room reclaimable for about 30 seconds; browser capture must be selected again</span>
                                    </label>
                                </div>
                                <div className="setting-row setting-row-toggle">
                                    <input
                                        type="checkbox"
                                        id="obsMode"
                                        checked={ingestMode === 'obs'}
                                        onChange={(e) => handleIngestModeChange(e.target.checked ? 'obs' : 'browser')}
                                    />
                                    <label htmlFor="obsMode">
                                        Use OBS (WHIP ingest)
                                        <span className="setting-hint">
                                            Stream via OBS instead of browser screen capture
                                        </span>
                                    </label>
                                </div>
                            </div>
                        </div>
                            <div
                                className="settings-panel obs-config-panel"
                                aria-hidden={ingestMode !== 'obs'}
                                inert={ingestMode !== 'obs' || undefined}
                            >
                                    <h3>OBS Configuration</h3>
                                    <div className="setting-row setting-row-toggle">
                                        <input
                                            type="checkbox"
                                            id="obsApplySettings"
                                            checked={obsApplySettings}
                                            disabled={obsAv1Mode}
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
                                            disabled={(publicShareStatus === 'active' || publicShareStatus === 'manual') && !publicAv1Supported}
                                            onChange={(e) => handleObsTryAv1Change(e.target.checked)}
                                        />
                                        <label htmlFor="obsTryAv1">
                                            Use BYOK TURN (AV1)
                                            <span className="setting-hint">Open TURN setup in a modal and switch OBS rooms to AV1 WebRTC-only mode</span>
                                            {(publicShareStatus === 'active' || publicShareStatus === 'manual') && !publicAv1Supported && (
                                                <span className="setting-hint">
                                                    Disabled for public sharing: configure a reachable public media address first.
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
                                    <div className="setting-row setting-row-inline">
                                        <label htmlFor="obsPassword" className="setting-row-label">
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

                    <UserErrorAlert error={error} />
                    {preflightWarnings.length > 0 && (
                        <div className="alert alert-warning" role="status">
                            <strong>Preflight notice</strong>
                            <ul>
                                {preflightWarnings.map((warning) => <li key={warning}>{warning}</li>)}
                            </ul>
                        </div>
                    )}
                    {bandwidthWarning && <div className="alert alert-warning" role="status">{bandwidthWarning}</div>}

                    {roomCode && (
                        <div className={ingestMode === 'obs' ? 'streaming-info-row' : ''}>
                        <div className="room-info">
                            <RoomSharePanel
                                localWatchLink={localWatchLink}
                                publicWatchLink={publicWatchLink}
                                showPublicLink={showPublicLink}
                                publicLinkHint={publicLinkHint}
                                whepPlaybackUrl={whepPlaybackUrl}
                            />
                            <div className="viewer-count">
                                <StatusPill tone={totalViewers > 0 ? 'ok' : undefined} pulse={totalViewers > 0}>
                                    {totalViewers} viewer{totalViewers !== 1 ? 's' : ''}
                                </StatusPill>
                                {whepViewerCount > 0 && (
                                    <span className="room-meta">
                                        {viewerCount} WebRTC · {whepViewerCount} WHEP
                                    </span>
                                )}
                            </div>
                            {roomMetrics && (
                                <div className="room-meta">
                                    WebRTC consumers: {roomMetrics.mediasoupConsumerCount || 0} | Relay out: {formatBytes(roomMetrics.relay?.bytesForwarded || 0, { maxUnit: 'MB' })}
                                </div>
                            )}
                            {ingestMode === 'obs' && (
                                <div className="room-meta">
                                    Codec: {obsVideoCodec || 'waiting'} |{' '}
                                    {obsAv1Mode || obsVideoCodec === 'av1'
                                        ? `WebRTC-only AV1 room | TURN ${roomHasTurnServer ? 'ready' : 'missing'}`
                                        : `Fallback viewers: ${fallbackViewerCount} | ${fallbackAvailable ? 'Fallback active' : 'Fallback inactive'}`}
                                </div>
                            )}
                        </div>
                    {ingestMode === 'obs' && (
                        <div className="obs-whip-setup-panel room-info">
                            <h3>OBS WHIP Setup</h3>

                            {whipHttpStatus !== 'ready' && (
                                <div className="obs-status-line is-warn" role="status">
                                    {whipHttpStatus === 'error'
                                        ? `OBS WHIP endpoint unavailable: ${whipHttpError || 'HTTP listener failed.'}`
                                        : 'OBS WHIP endpoint is starting...'}
                                </div>
                            )}

                            {obsAutoStatus === 'configuring' && (
                                <div className="obs-status-line is-info" role="status">{obsAutoMessage}</div>
                            )}
                            {obsAutoStatus === 'success' && (
                                <div className="obs-status-line is-ok" role="status">{obsAutoMessage}</div>
                            )}
                            {obsAutoStatus === 'error' && (
                                <div className="obs-status-line is-warn" role="alert">{obsAutoMessage}</div>
                            )}

                            {obsAutoStatus === 'error' && (
                                <div className="obs-retry-row">
                                    <button
                                        type="button"
                                        className="btn btn-secondary btn-small"
                                        onClick={() => {
                                            if (whipHttpStatus !== 'ready') {
                                                setObsAutoStatus('error');
                                                setObsAutoMessage(whipHttpStatus === 'error'
                                                    ? `OBS WHIP endpoint is unavailable: ${whipHttpError || 'HTTP listener failed.'}`
                                                    : 'OBS WHIP endpoint is still starting. Retry in a moment.');
                                                socket.emit('request-server-config');
                                                return;
                                            }
                                            const whipUrl = buildWhipBroadcastUrl(roomCode);
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
                                    >
                                        Retry Auto-Configure OBS
                                    </button>
                                </div>
                            )}

                            <details className="obs-manual-details">
                                <summary>Manual setup (if auto-config fails)</summary>
                                <div>
                                    <CopyField label="WHIP URL" value={buildWhipBroadcastUrl(roomCode)} />
                                    <CopyField label="Bearer Token" value={hostToken} />
                                    <div className="obs-manual-note">
                                        In OBS: Settings &rarr; Stream &rarr; Service: WHIP &rarr; Server: paste URL above &rarr; Bearer Token: paste token above
                                    </div>
                                    {(obsAv1Mode || obsVideoCodec === 'av1') && (
                                        <div className="obs-av1-note">
                                            Keep AV1 selected in OBS output. This room disables relay fallback and expects viewers to connect over WebRTC.
                                        </div>
                                    )}
                                </div>
                            </details>

                            <div className="obs-connection-status">
                                {whipConnected
                                    ? <StatusPill tone="ok" pulse>OBS Connected</StatusPill>
                                    : <StatusPill tone="warn">Waiting for OBS...</StatusPill>}
                            </div>
                        </div>
                    )}
                        </div>
                    )}
                    {/* Stays last in the side panel: the settings card unmounts and
                        the room card mounts when sharing starts, so anything above
                        the room card visibly jumps to the top on that swap. */}
                    <HostDiagnostics
                        metrics={roomMetrics}
                        onDownload={handleDownloadDiagnostics}
                        downloading={diagnosticDownloading}
                        downloadStatus={diagnosticDownloadStatus}
                    />
                </div>
            </div>
            {showByokTurnModal && (
                <Modal titleId="byokTurnModalTitle" onClose={() => setShowByokTurnModal(false)}>
                        <div className="settings-modal-head">
                            <div>
                                <div className="settings-modal-eyebrow">AV1 WebRTC Mode</div>
                                <h3 id="byokTurnModalTitle">Bring Your Own TURN</h3>
                                <p>AV1 rooms disable relay fallback and require TURN so viewers stay on WebRTC.</p>
                            </div>
                            <button
                                type="button"
                                className="settings-modal-close"
                                onClick={() => setShowByokTurnModal(false)}
                            >
                                Close
                            </button>
                        </div>
                        {cloudflareTurnAutofillAvailable && (
                            <div className="modal-inline-row">
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={handleAutofillCloudflareTurn}
                                    disabled={cloudflareTurnAutofillLoading}
                                >
                                    {cloudflareTurnAutofillLoading ? 'Fetching Cloudflare TURN...' : 'Autofill From Cloudflare'}
                                </button>
                            </div>
                        )}
                        <div className="setting-row setting-row-toggle" title={byokTurnSessionHint}>
                            <input
                                type="checkbox"
                                id="saveByokTurnForSession"
                                checked={saveByokTurnForSession}
                                title={byokTurnSessionHint}
                                onChange={(e) => setSaveByokTurnForSession(e.target.checked)}
                            />
                            <label htmlFor="saveByokTurnForSession" title={byokTurnSessionHint}>
                                Save TURN credentials for this session
                            </label>
                        </div>
                        <div className="setting-row setting-row-inline">
                            <label htmlFor="byokTurnUrls" className="setting-row-label">
                                TURN URLs
                            </label>
                            <textarea
                                id="byokTurnUrls"
                                value={byokTurnUrls}
                                onChange={(e) => setByokTurnUrls(e.target.value)}
                                placeholder={'turn:turn.example.com:3478?transport=udp\nturns:turn.example.com:5349?transport=tcp'}
                                className="select-input input-textarea"
                            />
                        </div>
                        <div className="setting-row setting-row-inline">
                            <label htmlFor="byokTurnAuthType" className="setting-row-label">
                                Auth mode
                            </label>
                            <select
                                id="byokTurnAuthType"
                                value={byokTurnAuthType}
                                onChange={(e) => setByokTurnAuthType(e.target.value)}
                                className="select-input"
                            >
                                <option value="secret">Shared secret (recommended)</option>
                                <option value="static">Static username/password</option>
                            </select>
                        </div>
                        {byokTurnAuthType === 'secret' ? (
                            <div className="setting-row setting-row-inline">
                                <label htmlFor="byokTurnSecret" className="setting-row-label">
                                    TURN secret
                                </label>
                                <input
                                    id="byokTurnSecret"
                                    type="password"
                                    value={byokTurnSecret}
                                    onChange={(e) => setByokTurnSecret(e.target.value)}
                                    placeholder="coturn static-auth-secret"
                                    className="select-input"
                                />
                            </div>
                        ) : (
                            <>
                                <div className="setting-row setting-row-inline">
                                    <label htmlFor="byokTurnUsername" className="setting-row-label">
                                        Username
                                    </label>
                                    <input
                                        id="byokTurnUsername"
                                        type="text"
                                        value={byokTurnUsername}
                                        onChange={(e) => setByokTurnUsername(e.target.value)}
                                        placeholder="turn username"
                                        className="select-input"
                                    />
                                </div>
                                <div className="setting-row setting-row-inline">
                                    <label htmlFor="byokTurnCredential" className="setting-row-label">
                                        Credential
                                    </label>
                                    <input
                                        id="byokTurnCredential"
                                        type="password"
                                        value={byokTurnCredential}
                                        onChange={(e) => setByokTurnCredential(e.target.value)}
                                        placeholder="turn password"
                                        className="select-input"
                                    />
                                </div>
                            </>
                        )}
                        <div className="settings-modal-actions">
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => {
                                    setObsTryAv1(false);
                                    setShowByokTurnModal(false);
                                }}
                            >
                                Disable AV1 Mode
                            </button>
                            <button
                                type="button"
                                className="btn btn-primary"
                                onClick={() => setShowByokTurnModal(false)}
                                disabled={cloudflareTurnAutofillLoading}
                            >
                                Done
                            </button>
                        </div>
                </Modal>
            )}
            {showStopConfirm && (
                <Modal titleId="stopSharingConfirmTitle" onClose={() => setShowStopConfirm(false)}>
                    <div className="settings-modal-head">
                        <div>
                            <h3 id="stopSharingConfirmTitle">Stop sharing?</h3>
                            <p>
                                {totalViewers} viewer{totalViewers !== 1 ? 's are' : ' is'} currently watching.
                                Stopping ends the stream for everyone and retires this room code —
                                sharing again creates a new code you&apos;ll need to send out.
                            </p>
                        </div>
                    </div>
                    <div className="settings-modal-actions">
                        <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => setShowStopConfirm(false)}
                        >
                            Keep Sharing
                        </button>
                        <button
                            type="button"
                            className="btn btn-danger"
                            onClick={() => {
                                setShowStopConfirm(false);
                                handleStopSharing(true);
                            }}
                        >
                            Stop Sharing
                        </button>
                    </div>
                </Modal>
            )}
            {pendingNavRoute !== null && (
                <Modal titleId="leaveWhileSharingTitle" onClose={() => setPendingNavRoute(null)}>
                    <div className="settings-modal-head">
                        <div>
                            <h3 id="leaveWhileSharingTitle">Leave the host page?</h3>
                            <p>
                                {totalViewers} viewer{totalViewers !== 1 ? 's are' : ' is'} currently watching.
                                Leaving ends the stream for everyone and retires this room code —
                                sharing again creates a new code you&apos;ll need to send out.
                            </p>
                        </div>
                    </div>
                    <div className="settings-modal-actions">
                        <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => setPendingNavRoute(null)}
                        >
                            Stay Here
                        </button>
                        <button
                            type="button"
                            className="btn btn-danger"
                            onClick={() => {
                                const target = pendingNavRoute;
                                setPendingNavRoute(null);
                                // Release before navigating: isSharing has not
                                // changed yet, so the guard would block the retry.
                                releaseNavGuardRef.current?.();
                                window.location.hash = target;
                            }}
                        >
                            Leave and Stop
                        </button>
                    </div>
                </Modal>
            )}
        </div>
    );
}
