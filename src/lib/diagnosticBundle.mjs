const READINESS_COMPONENTS = ['http', 'socketIo', 'mediaWorker', 'spa', 'whip'];
const SOCKET_COUNTERS = [
    'totalConnections',
    'activeSockets',
    'activeRooms',
    'activeViewers',
    'activeRelayViewers',
    'activeProducers',
    'activeConsumers',
    'activeFallbackPipelines',
];
const WORKER_USAGE_FIELDS = ['ru_utime', 'ru_stime', 'ru_maxrss', 'ru_nvcsw', 'ru_nivcsw'];

function finiteNumber(value) {
    return Number.isFinite(value) ? value : null;
}

function safeString(value, maxLength = 500) {
    return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

export function sanitizeDiagnosticText(value) {
    return safeString(value, 2000)
        .replace(/\b(?:https?|wss?):\/\/[^\s<>'"]+/gi, '[redacted-url]')
        .replace(/\b(?:stuns?|turns?):[^\s<>'"]+/gi, '[redacted-url]')
        .replace(/\bauthorization\s*[:=]\s*bearer\s+[^\s,;]+/gi, 'Authorization=[redacted]')
        .replace(/\bbearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(/\b(?:authorization|bearer|token|secret|password|credential|passphrase|room[\s_-]*code)\s*[:=]\s*[^\s,;]+/gi, (match) => {
            const key = match.split(/[:=]/, 1)[0].trim();
            return `${key}=[redacted]`;
        })
        .replace(/\b(?:[a-f0-9]{32,}|[A-Za-z0-9_-]{48,})\b/g, '[redacted-value]');
}

function sanitizeReadiness(readiness) {
    const components = {};
    for (const name of READINESS_COMPONENTS) {
        const component = readiness?.components?.[name];
        if (!component) continue;
        components[name] = {
            required: component.required === true,
            status: safeString(component.status, 40) || 'unknown',
            ...(component.error ? { error: sanitizeDiagnosticText(component.error) } : {}),
        };
    }
    return {
        status: safeString(readiness?.status, 40) || 'unavailable',
        components,
        fallbackRelay: {
            nvencProbe: {
                status: safeString(readiness?.fallbackRelay?.nvencProbe?.status, 40) || 'unknown',
                encoder: safeString(readiness?.fallbackRelay?.nvencProbe?.encoder, 80) || null,
                ...(readiness?.fallbackRelay?.nvencProbe?.error
                    ? { error: sanitizeDiagnosticText(readiness.fallbackRelay.nvencProbe.error) }
                    : {}),
            },
        },
    };
}

function sanitizeGlobalMetrics(metrics) {
    const counters = {};
    for (const name of SOCKET_COUNTERS) {
        counters[name] = finiteNumber(metrics?.sockets?.counters?.[name]);
    }
    const workerUsage = {};
    for (const name of WORKER_USAGE_FIELDS) {
        workerUsage[name] = finiteNumber(metrics?.mediaWorker?.resourceUsage?.[name]);
    }
    return {
        available: !!metrics,
        generatedAt: safeString(metrics?.generatedAt, 80) || null,
        process: {
            pid: finiteNumber(metrics?.process?.pid),
            uptimeSec: finiteNumber(metrics?.process?.uptimeSec),
            memory: {
                rss: finiteNumber(metrics?.process?.memory?.rss),
                heapTotal: finiteNumber(metrics?.process?.memory?.heapTotal),
                heapUsed: finiteNumber(metrics?.process?.memory?.heapUsed),
                external: finiteNumber(metrics?.process?.memory?.external),
            },
            eventLoopDelayMs: {
                mean: finiteNumber(metrics?.process?.eventLoopDelayMs?.mean),
                p95: finiteNumber(metrics?.process?.eventLoopDelayMs?.p95),
                max: finiteNumber(metrics?.process?.eventLoopDelayMs?.max),
            },
            resources: {
                total: finiteNumber(metrics?.process?.resources?.total),
            },
        },
        rooms: {
            active: finiteNumber(metrics?.rooms?.active),
            totalViewers: finiteNumber(metrics?.rooms?.totalViewers),
            totalRelayViewers: finiteNumber(metrics?.rooms?.totalRelayViewers),
            totalWhepViewers: finiteNumber(metrics?.rooms?.totalWhepViewers),
            totalMediasoupConsumers: finiteNumber(metrics?.rooms?.totalMediasoupConsumers),
        },
        sockets: { counters },
        mediaWorker: {
            pid: finiteNumber(metrics?.mediaWorker?.pid),
            resourceUsage: workerUsage,
        },
    };
}

function sanitizeRoomMetrics(metrics) {
    return {
        available: !!metrics,
        viewerCount: finiteNumber(metrics?.viewerCount),
        relayViewerCount: finiteNumber(metrics?.relayViewerCount),
        whepViewerCount: finiteNumber(metrics?.whepViewerCount),
        mediasoupConsumerCount: finiteNumber(metrics?.mediasoupConsumerCount),
        hasProducer: metrics?.hasProducer === true,
        hasAudioProducer: metrics?.hasAudioProducer === true,
        whipConnected: metrics?.whipConnected === true,
        obsVideoCodec: safeString(metrics?.obsVideoCodec, 20) || null,
        fallbackAvailable: metrics?.fallbackAvailable === true,
        fallbackViewerCount: finiteNumber(metrics?.fallbackViewerCount),
        fallbackRestartCount: finiteNumber(metrics?.fallbackRestartCount),
        fallbackDroppedBytes: finiteNumber(metrics?.fallbackDroppedBytes),
        relay: {
            chunksReceived: finiteNumber(metrics?.relay?.chunksReceived),
            bytesReceived: finiteNumber(metrics?.relay?.bytesReceived),
            chunksForwarded: finiteNumber(metrics?.relay?.chunksForwarded),
            bytesForwarded: finiteNumber(metrics?.relay?.bytesForwarded),
            droppedOversized: finiteNumber(metrics?.relay?.droppedOversized),
        },
    };
}

export function buildDiagnosticBundle({
    generatedAt = new Date().toISOString(),
    packageInfo,
    readiness,
    publicConfig,
    globalMetrics,
    roomMetrics,
    hostState,
    clientRuntime,
    errors = [],
}) {
    const uniqueErrors = [...new Set(errors
        .map(sanitizeDiagnosticText)
        .map((value) => value.trim())
        .filter(Boolean))].slice(-10);

    return {
        schemaVersion: 1,
        generatedAt: safeString(generatedAt, 80),
        app: {
            version: safeString(packageInfo?.version, 40) || 'unavailable',
            packaged: packageInfo?.packaged === true,
        },
        clientRuntime: {
            userAgent: safeString(clientRuntime?.userAgent, 300),
            platform: safeString(clientRuntime?.platform, 100),
            language: safeString(clientRuntime?.language, 40),
            secureContext: clientRuntime?.secureContext === true,
        },
        readiness: sanitizeReadiness(readiness),
        configuration: {
            ingestMode: hostState?.ingestMode === 'obs' ? 'obs' : 'browser',
            obsAv1Mode: hostState?.obsAv1Mode === true,
            qualityProfile: safeString(hostState?.qualityProfile, 20) || 'unknown',
            frameRate: finiteNumber(hostState?.frameRate),
            publicShareStatus: safeString(hostState?.publicShareStatus, 40) || 'unknown',
            hasTurnServer: hostState?.hasTurnServer === true,
            roomHasTurnServer: hostState?.roomHasTurnServer === true,
            whipEnabled: publicConfig?.whipEnabled === true,
            whipHttpStatus: safeString(hostState?.whipHttpStatus, 40) || 'unknown',
            whepEnabled: publicConfig?.whepEnabled === true,
            reloadRecoveryEnabled: hostState?.reloadRecoveryEnabled === true,
        },
        topology: sanitizeRoomMetrics(roomMetrics),
        runtime: sanitizeGlobalMetrics(globalMetrics),
        errors: uniqueErrors,
    };
}

export function downloadDiagnosticBundle(bundle, {
    documentRef = document,
    urlApi = URL,
    BlobImpl = Blob,
} = {}) {
    const compactTimestamp = String(bundle?.generatedAt || new Date().toISOString())
        .replace(/[:.]/g, '-')
        .replace(/[^0-9TZ-]/g, '');
    const filename = `nextra-diagnostics-${compactTimestamp || 'current'}.json`;
    const blob = new BlobImpl([`${JSON.stringify(bundle, null, 2)}\n`], { type: 'application/json' });
    const objectUrl = urlApi.createObjectURL(blob);
    const link = documentRef.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    link.hidden = true;
    documentRef.body.appendChild(link);
    try {
        link.click();
    } finally {
        link.remove();
        urlApi.revokeObjectURL(objectUrl);
    }
    return filename;
}
