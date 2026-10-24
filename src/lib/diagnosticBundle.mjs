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

const MAX_TEXT_LENGTH = 2000;
const REDACTED = '[redacted]';
const REDACTED_URL = '[redacted-url]';
const REDACTED_VALUE = '[redacted-value]';

// The server draws a room code of CODE_LENGTH (6) characters from CHARS in lib/rooms.js
// (upper-case letters and digits without I, O, 0 and 1; a test reads that file to keep
// this in step). Redaction accepts every upper-case letter and digit instead, so a code
// typed by hand ("AB12CD") is covered too. The host UI shows a code as ABC-123, so a
// hyphen in the middle is allowed. No lookbehind is used below: this module ships to the
// browser and Safari before 16.4 rejects it.
const ROOM_CODE_CHARS = 'A-Z0-9';
const ROOM_CODE = `[${ROOM_CODE_CHARS}]{3}-?[${ROOM_CODE_CHARS}]{3}`;
const ROOM_CODE_ONLY = new RegExp(`^${ROOM_CODE}$`);

const QUOTED_VALUE = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const AUTH_PARAM = String.raw`[\w-]+=(?:"[^"]*"|'[^']*'|[^\s,;]+)`;
// "<scheme> <credential>", plus the comma-separated parameters of a Digest header.
const AUTH_SCHEME_VALUE = String.raw`[^\s,;"')]+(?:[ \t]+(?:${AUTH_PARAM}|[^\s,;")]+)(?:\s*,\s*${AUTH_PARAM})*)?`;
const SECRET_KEY = String.raw`[\w-]*(?:token|secret|password|passwd|passphrase|credentials?|api[_-]?key)|bearer|room[\s_-]*code`;

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>'"]+/gi;
const STUN_TURN_RE = /\b(?:stuns?|turns?):[^\s<>'"]+/gi;
const AUTHORIZATION_RE = new RegExp(
    String.raw`(["']?)\b([\w-]*authorization)(["']?)(\s*[:=]\s*)(\[redacted\]|${QUOTED_VALUE}|${AUTH_SCHEME_VALUE})`,
    'gi',
);
const BEARER_RE = /\bbearer\s+[^\s,;"']+/gi;
const SECRET_KEY_VALUE_RE = new RegExp(
    String.raw`(["']?)\b(${SECRET_KEY})\b(["']?)(\s*[:=]\s*)(${QUOTED_VALUE}|[^\s,;}]+)`,
    'gi',
);
// Whatever follows these path markers is a room code or a session id.
const ROOM_SEGMENT_RE = /(#\/?watch\/|\/whep\/watch\/|\/whip\/broadcast\/)(?!\[redacted\])[^\s/?#&"'<>),;\]]+/gi;
const ROOM_PATH_RE = new RegExp(String.raw`(\/wh[ei]p\/)${ROOM_CODE}(?![\w-])`, 'g');
// "Room AB12CD", "room code: AB12CD", "roomId=AB12CD". Matched case-insensitively and
// then checked against the real alphabet, so "room" before ordinary text stays as is.
const ROOM_WORD_RE = /\b(rooms?(?:[\s_-]*(?:code|id))?\b["']?\s*[:=]?\s*["']?)([A-Za-z0-9]{3}-?[A-Za-z0-9]{3})\b/gi;

const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const HEX_GROUP = '[0-9a-f]{1,4}';
const IPV4_RE = new RegExp(String.raw`(^|[^\w.])${OCTET}(?:\.${OCTET}){3}(?::\d{1,5})?(?!\w|\.\d)`, 'g');
const BRACKETED_IPV6_RE = /\[(?=[0-9a-f:.]*:[0-9a-f:.]*:)[0-9a-f:.]+\](?::\d{1,5})?/gi;
// A bare IPv6 address needs eight groups or "::", so clock times such as 12:30:45 stay.
const BARE_IPV6_RE = new RegExp(
    String.raw`(^|[^\w:.])(?:(?:${HEX_GROUP}:){7}${HEX_GROUP}|(?:${HEX_GROUP}:){1,7}:(?:${HEX_GROUP}(?::${HEX_GROUP}){0,6})?|::${HEX_GROUP}(?::${HEX_GROUP}){0,6})(?![\w:])`,
    'gi',
);
// Only dotted names and localhost count as hosts: "width:1920" or "code:500" do not.
const HOST_PORT_RE = /(^|[^\w.@/-])((?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*|localhost):\d{1,5}(?!\w)/gi;
// "HostView.jsx:538" in a stack trace looks like host:port; these endings mean a file.
const FILE_EXTENSIONS = new Set([
    'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'json', 'css', 'scss', 'html', 'htm', 'map',
    'md', 'txt', 'log', 'exe', 'dll', 'node', 'bat', 'cmd', 'ps1', 'sh', 'py', 'c', 'h', 'cc', 'cpp',
    'hpp', 'rs', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'lock', 'wasm', 'svg',
]);

const HEX_RE = /\b[a-f0-9]{32,}\b/gi;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{48,}\b/g;
const BASE64_RE = /(^|[^A-Za-z0-9+/])([A-Za-z0-9+/]{20,}={0,2})(?![A-Za-z0-9+/])/g;

function redactSecretValue(match, openQuote, key, closeQuote, separator, value) {
    if (!(openQuote && closeQuote)) return `${openQuote}${key}=${REDACTED}`;
    // Quoted key (JSON and similar): keep the shape so the report stays readable.
    const valueQuote = value[0] === '"' || value[0] === "'" ? value[0] : '';
    return `${openQuote}${key}${closeQuote}${separator}${valueQuote}${REDACTED}${valueQuote}`;
}

function redactRoomWord(match, context, code) {
    return ROOM_CODE_ONLY.test(code) ? `${context}${REDACTED}` : match;
}

function redactHostPort(match, prefix, host) {
    const ending = host.slice(host.lastIndexOf('.') + 1).toLowerCase();
    return FILE_EXTENSIONS.has(ending) ? match : `${prefix}${REDACTED_URL}`;
}

// A run of base64 characters is only a secret when it carries a "+", "/" or "=" (plain
// letters and digits are the hex and 48-character rules' job) and has upper case, lower
// case and a digit, which keeps file paths and identifiers out. A trailing "=" is
// padding, so a shorter run counts then.
function redactBase64(match, prefix, run) {
    const padded = run.endsWith('=');
    if (run.replace(/=+$/, '').length < 32 && !padded) return match;
    if (!/[+/=]/.test(run)) return match;
    const slashes = (run.match(/\//g) || []).length;
    if (slashes > 2 && !padded && !run.includes('+')) return match;
    if (!/[a-z]/.test(run) || !/[A-Z]/.test(run) || !/\d/.test(run)) return match;
    return `${prefix}${REDACTED_VALUE}`;
}

export function sanitizeDiagnosticText(value) {
    return safeString(value, MAX_TEXT_LENGTH)
        .replace(URL_RE, REDACTED_URL)
        .replace(STUN_TURN_RE, REDACTED_URL)
        .replace(AUTHORIZATION_RE, redactSecretValue)
        .replace(BEARER_RE, 'Bearer [redacted]')
        .replace(SECRET_KEY_VALUE_RE, redactSecretValue)
        .replace(ROOM_SEGMENT_RE, `$1${REDACTED}`)
        .replace(ROOM_PATH_RE, `$1${REDACTED}`)
        .replace(ROOM_WORD_RE, redactRoomWord)
        .replace(BRACKETED_IPV6_RE, REDACTED_URL)
        .replace(IPV4_RE, `$1${REDACTED_URL}`)
        .replace(BARE_IPV6_RE, `$1${REDACTED_URL}`)
        .replace(HOST_PORT_RE, redactHostPort)
        .replace(HEX_RE, REDACTED_VALUE)
        .replace(LONG_TOKEN_RE, REDACTED_VALUE)
        .replace(BASE64_RE, redactBase64);
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
        fallbackVideoKbps: finiteNumber(metrics?.fallbackVideoKbps),
        fallbackVideoTargetKbps: finiteNumber(metrics?.fallbackVideoTargetKbps),
        fallbackVideoCopy: metrics?.fallbackVideoCopy === true,
        obsKeyframeIntervalMs: finiteNumber(metrics?.obsKeyframeIntervalMs),
        obsBitrateKbps: finiteNumber(metrics?.obsBitrateKbps),
        obsLostPackets: finiteNumber(metrics?.obsLostPackets),
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
