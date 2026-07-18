// config.js - Single source of truth for all configuration
// NOTE: dotenv is intentionally NOT loaded here. Entry points (server.js) load it
// before requiring this module, which keeps `node --test` hermetic — tests use
// explicit fixture env rather than the developer's local .env file.
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
    DEFAULT_CLOUDFLARE_TURN_BASE_URL,
    DEFAULT_CLOUDFLARE_TURN_TTL_SECONDS,
    hasCloudflareTurnCredentialSource,
} = require('./lib/cloudflareTurn');

function getLanIp() {
    const ifaces = os.networkInterfaces();
    let defaultRouteIp = '';
    if (process.platform === 'win32') {
        try {
            const routeOutput = execFileSync('route.exe', ['print', '-4', '0.0.0.0'], {
                encoding: 'utf8',
                timeout: 1500,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            const defaultRoutes = routeOutput
                .split(/\r?\n/)
                .map((line) => line.trim().match(/^0\.0\.0\.0\s+0\.0\.0\.0\s+\S+\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)$/))
                .filter(Boolean)
                .map((match) => ({ address: match[1], metric: Number(match[2]) }))
                .sort((left, right) => left.metric - right.metric);
            defaultRouteIp = defaultRoutes[0]?.address || '';
        } catch {
            // Fall back to scored interface discovery below.
        }
    }
    const candidates = [];
    for (const [name, addresses] of Object.entries(ifaces)) {
        for (const iface of addresses || []) {
            if (iface.family !== 'IPv4' || iface.internal || /^169\.254\./.test(iface.address)) continue;
            const normalizedName = name.toLowerCase();
            let score = 0;
            if (iface.address === defaultRouteIp) score += 1000;
            if (/ethernet|wi-?fi|wlan|en\d|eth\d/.test(normalizedName)) score += 20;
            if (/docker|hyper-v|vethernet|virtual|vmware|vpn|tailscale|loopback|wsl/.test(normalizedName)) score -= 50;
            if (/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(iface.address)) score += 5;
            candidates.push({ address: iface.address, score, name });
        }
    }
    candidates.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
    if (candidates.length > 0) return candidates[0].address;
    return '127.0.0.1';
}

function parseIntEnv(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatEnv(value, fallback) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolEnv(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function parseTrustProxy(value) {
    if (value === undefined || value === null || value === '') return false;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    const asNumber = Number.parseInt(normalized, 10);
    if (Number.isFinite(asNumber)) return asNumber;
    return String(value).trim();
}

const lanIp = (process.env.LAN_IP || '').trim() || getLanIp();
const explicitPublicIp = (process.env.PUBLIC_IP || '').trim();
const bindHost = (process.env.BIND_HOST || '127.0.0.1').trim() || '127.0.0.1';
const rtcListenIp = (process.env.RTC_LISTEN_IP || (bindHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1')).trim();
const isPackagedRuntime = process.env.NEXTRA_PACKAGED === '1';
const DEFAULT_STUN_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

function normalizeTurnUrls(value) {
    const rawValues = Array.isArray(value)
        ? value
        : String(value || '').split(',');
    return rawValues
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
}

function normalizeTurnConfig(turnConfig = null) {
    if (turnConfig == null) return null;

    if (typeof turnConfig === 'string' || Array.isArray(turnConfig)) {
        return {
            urls: normalizeTurnUrls(turnConfig),
            authType: 'secret',
            secret: '',
            username: '',
            credential: '',
        };
    }

    if (typeof turnConfig !== 'object') return null;

    const authType = String(turnConfig.authType || '').trim().toLowerCase() === 'static'
        ? 'static'
        : 'secret';

    return {
        urls: normalizeTurnUrls(turnConfig.urls),
        authType,
        secret: String(turnConfig.secret || '').trim(),
        username: String(turnConfig.username || '').trim(),
        credential: String(turnConfig.credential || '').trim(),
    };
}

function hasUsableTurnConfig(turnConfig) {
    const normalized = normalizeTurnConfig(turnConfig);
    if (!normalized || normalized.urls.length === 0) return false;

    if (normalized.authType === 'secret') {
        return normalized.secret.length > 0;
    }

    return normalized.username.length > 0 && normalized.credential.length > 0;
}

function buildIceServers(turnConfig = null) {
    const servers = DEFAULT_STUN_SERVERS.map((server) => ({ ...server }));
    const normalized = normalizeTurnConfig(turnConfig);
    if (!hasUsableTurnConfig(normalized)) return servers;

    if (normalized.authType === 'secret') {
        // Short-lived ephemeral credentials: fresh values are minted on every
        // transport creation (create-send/recv-transport -> refreshRoomIceServers),
        // so a long TTL only widens the window for credential theft without any
        // benefit. 1h comfortably covers a session plus reconnects.
        const ttl = 3600; // 1h in seconds
        const timestamp = Math.floor(Date.now() / 1000) + ttl;
        const username = `${timestamp}:nextra`;
        const credential = crypto
            .createHmac('sha1', normalized.secret)
            .update(username)
            .digest('base64');

        normalized.urls.forEach((url) => {
            servers.push({ urls: url, username, credential });
        });
        return servers;
    }

    normalized.urls.forEach((url) => {
        servers.push({
            urls: url,
            username: normalized.username,
            credential: normalized.credential,
        });
    });
    return servers;
}

function iceServersIncludeTurn(servers = []) {
    return servers.some((server) => {
        const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
        return urls.some((url) => typeof url === 'string' && /^turns?:/i.test(url.trim()));
    });
}

const config = {
    // Server
    PORT: parseIntEnv(process.env.PORT, 3000),
    BIND_HOST: bindHost,
    OPEN_BROWSER: parseBoolEnv(process.env.OPEN_BROWSER, isPackagedRuntime),

    // HTTPS - self-signed cert auto-generated and cached here
    LOCAL_HTTPS: parseBoolEnv(process.env.LOCAL_HTTPS, false),
    HTTPS_CERT_DIR: (process.env.HTTPS_CERT_DIR || './certs').trim(),

    // Network
    LAN_IP: lanIp,
    PUBLIC_IP: explicitPublicIp || null,
    AUTO_DETECT_PUBLIC_IP: parseBoolEnv(process.env.AUTO_DETECT_PUBLIC_IP, false),
    TRUST_PROXY: parseTrustProxy(process.env.TRUST_PROXY),
    TRUST_X_FORWARDED_HEADERS: parseBoolEnv(process.env.TRUST_X_FORWARDED_HEADERS, false),
    ALLOW_TRYCLOUDFLARE_ORIGINS: parseBoolEnv(process.env.ALLOW_TRYCLOUDFLARE_ORIGINS, false),
    ALLOW_SOCKET_NO_ORIGIN: parseBoolEnv(process.env.ALLOW_SOCKET_NO_ORIGIN, false),
    EXPOSE_LAN_URL: parseBoolEnv(process.env.EXPOSE_LAN_URL, false),
    // Packaged builds auto-enable the public tunnel so end users can share from the EXE without editing .env.
    AUTO_PUBLIC_TUNNEL: parseBoolEnv(process.env.AUTO_PUBLIC_TUNNEL, isPackagedRuntime),
    PUBLIC_TUNNEL_PROVIDER: (process.env.PUBLIC_TUNNEL_PROVIDER || 'cloudflared').trim().toLowerCase(),
    CLOUDFLARED_PATH: (process.env.CLOUDFLARED_PATH || '').trim(),
    CLOUDFLARED_TUNNEL_TOKEN: (process.env.CLOUDFLARED_TUNNEL_TOKEN || '').trim(),
    PUBLIC_TUNNEL_NO_TLS_VERIFY: parseBoolEnv(process.env.PUBLIC_TUNNEL_NO_TLS_VERIFY, true),
    PUBLIC_TUNNEL_TIMEOUT_MS: parseIntEnv(process.env.PUBLIC_TUNNEL_TIMEOUT_MS, 20000),

    // Mediasoup Worker
    MEDIASOUP_WORKER_LOG_LEVEL: (process.env.MEDIASOUP_LOG_LEVEL || 'warn').trim(),
    RTC_MIN_PORT: parseIntEnv(process.env.RTC_MIN_PORT, 40000),
    RTC_MAX_PORT: parseIntEnv(process.env.RTC_MAX_PORT, 40099),
    RTC_LISTEN_IP: rtcListenIp,

    // Mediasoup Router - media codecs
    MEDIA_CODECS: [
        { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
        {
            kind: 'video', mimeType: 'video/H264', clockRate: 90000,
            parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 },
        },
        {
            kind: 'video', mimeType: 'video/H264', clockRate: 90000,
            parameters: { 'packetization-mode': 1, 'profile-level-id': '4d0032', 'level-asymmetry-allowed': 1 },
        },
        {
            kind: 'video', mimeType: 'video/H264', clockRate: 90000,
            parameters: { 'packetization-mode': 1, 'profile-level-id': '640032', 'level-asymmetry-allowed': 1 },
        },
        {
            kind: 'video',
            mimeType: 'video/AV1',
            clockRate: 90000,
        },
        {
            kind: 'audio',
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2,
            parameters: {
                useinbandfec: 1,
            },
        },
    ],

    // Legacy fallback simulcast encodings. The host UI applies profile/fps-aware
    // values at runtime, but keep the defaults aligned with the highest preset.
    SIMULCAST_ENCODINGS: [
        { rid: 'r0', maxBitrate: 4_320_000, scaleResolutionDownBy: 4 },
        { rid: 'r1', maxBitrate: 14_400_000, scaleResolutionDownBy: 2 },
        { rid: 'r2', maxBitrate: 36_000_000 },
    ],
    CODEC_OPTIONS: { videoGoogleStartBitrate: 5_000 },

    // ICE / TURN / STUN
    TURN_URL: process.env.TURN_URL || '',
    TURN_SECRET: process.env.TURN_SECRET || '',
    TURN_USERNAME: process.env.TURN_USERNAME || '',
    TURN_CREDENTIAL: process.env.TURN_CREDENTIAL || '',
    CLOUDFLARE_TURN_KEY_ID: (process.env.CLOUDFLARE_TURN_KEY_ID || '').trim(),
    CLOUDFLARE_TURN_API_TOKEN: (process.env.CLOUDFLARE_TURN_API_TOKEN || '').trim(),
    CLOUDFLARE_TURN_API_BASE_URL: (process.env.CLOUDFLARE_TURN_API_BASE_URL || DEFAULT_CLOUDFLARE_TURN_BASE_URL).trim(),
    CLOUDFLARE_TURN_TTL_SECONDS: parseIntEnv(process.env.CLOUDFLARE_TURN_TTL_SECONDS, DEFAULT_CLOUDFLARE_TURN_TTL_SECONDS),
    DEFAULT_STUN_SERVERS,
    normalizeTurnConfig,
    hasUsableTurnConfig,
    buildIceServers,
    iceServersIncludeTurn,

    getDefaultTurnConfig() {
        return normalizeTurnConfig({
            urls: this.TURN_URL,
            authType: this.TURN_SECRET ? 'secret' : 'static',
            secret: this.TURN_SECRET,
            username: this.TURN_USERNAME,
            credential: this.TURN_CREDENTIAL,
        });
    },

    // Generate ICE servers with ephemeral TURN credentials.
    getIceServers() {
        return buildIceServers(this.getDefaultTurnConfig());
    },

    hasCloudflareTurnCredentialSource() {
        return hasCloudflareTurnCredentialSource({
            keyId: this.CLOUDFLARE_TURN_KEY_ID,
            apiToken: this.CLOUDFLARE_TURN_API_TOKEN,
        });
    },

    getCloudflareTurnCredentialSource() {
        return {
            keyId: this.CLOUDFLARE_TURN_KEY_ID,
            apiToken: this.CLOUDFLARE_TURN_API_TOKEN,
            baseUrl: this.CLOUDFLARE_TURN_API_BASE_URL,
            ttlSeconds: this.CLOUDFLARE_TURN_TTL_SECONDS,
        };
    },

    // Bandwidth management
    HOST_UPLOAD_MBPS: parseFloatEnv(process.env.HOST_UPLOAD_MBPS, 36),

    // Room limits
    MAX_VIEWERS_PER_ROOM: parseIntEnv(process.env.MAX_VIEWERS_PER_ROOM, 10),
    MAX_ACTIVE_ROOMS: parseIntEnv(process.env.MAX_ACTIVE_ROOMS, 10),

    // Rate limits
    MEDIA_TOGGLE_COOLDOWN_MS: 1000,
    MEDIA_TOGGLE_VIEWER_COOLDOWN_MS: parseIntEnv(process.env.MEDIA_TOGGLE_VIEWER_COOLDOWN_MS, 3000),
    ALLOW_REMOTE_MEDIA_CONTROL: parseBoolEnv(process.env.ALLOW_REMOTE_MEDIA_CONTROL, false),
    CREATE_ROOM_RATE_LIMIT_MAX: parseIntEnv(process.env.CREATE_ROOM_RATE_LIMIT_MAX, 10),
    CREATE_ROOM_RATE_LIMIT_WINDOW_MS: parseIntEnv(process.env.CREATE_ROOM_RATE_LIMIT_WINDOW_MS, 60000),
    JOIN_RATE_LIMIT_MAX: parseIntEnv(process.env.JOIN_RATE_LIMIT_MAX, 20),
    JOIN_RATE_LIMIT_WINDOW_MS: parseIntEnv(process.env.JOIN_RATE_LIMIT_WINDOW_MS, 60000),

    // Room cleanup
    ROOM_HEARTBEAT_INTERVAL_MS: 60000,
    ROOM_STALE_TIMEOUT_MS: parseIntEnv(process.env.ROOM_STALE_TIMEOUT_MS, 600000),

    // Socket.io
    SOCKET_PATH: '/socket.io',
    SOCKET_PING_INTERVAL_MS: parseIntEnv(process.env.SOCKET_PING_INTERVAL_MS, 25000),
    SOCKET_PING_TIMEOUT_MS: parseIntEnv(process.env.SOCKET_PING_TIMEOUT_MS, 60000),

    // Socket / relay limits
    MAX_CONNECTIONS_PER_IP: parseIntEnv(process.env.MAX_CONNECTIONS_PER_IP, 60),
    CONNECTION_WINDOW_MS: parseIntEnv(process.env.CONNECTION_WINDOW_MS, 60000),
    SOCKET_MAX_HTTP_BUFFER_SIZE: parseIntEnv(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE, 8 * 1024 * 1024),
    MEDIA_MAX_CHUNK_SIZE: parseIntEnv(process.env.MEDIA_MAX_CHUNK_SIZE, 4 * 1024 * 1024),
    RELAY_FLUSH_INTERVAL_MS: parseIntEnv(process.env.RELAY_FLUSH_INTERVAL_MS, 300),
    RELAY_VIDEO_BITS_PER_SECOND: parseIntEnv(process.env.RELAY_VIDEO_BITS_PER_SECOND, 45000000),
    // Per-socket cap on bytes queued in the engine.io write buffer before a
    // relay viewer is considered too slow (WebM viewers are kicked to recover;
    // fMP4 viewers just skip fragments and seek past the gap client-side).
    RELAY_SOCKET_MAX_BUFFERED_BYTES: parseIntEnv(process.env.RELAY_SOCKET_MAX_BUFFERED_BYTES, 16 * 1024 * 1024),
    // How long viewers wait on "host reconnecting" before the room is destroyed.
    // The reclaim-host flow covers a page reload in seconds; a long grace just
    // leaves viewers staring at a frozen frame when the host is really gone.
    HOST_RECONNECT_GRACE_MS: parseIntEnv(process.env.HOST_RECONNECT_GRACE_MS, 30000),
    // Avoid restarting during an immediate startup crash loop. Tests can set 0
    // when they intentionally kill a fully initialized worker.
    WORKER_RECOVERY_MIN_UPTIME_SECONDS: parseIntEnv(process.env.WORKER_RECOVERY_MIN_UPTIME_SECONDS, 30),
    METRICS_BROADCAST_INTERVAL_MS: parseIntEnv(process.env.METRICS_BROADCAST_INTERVAL_MS, 5000),
    ALLOW_REMOTE_METRICS: parseBoolEnv(process.env.ALLOW_REMOTE_METRICS, false),
    METRICS_TOKEN: (process.env.METRICS_TOKEN || '').trim(),
    ENABLE_OPENMETRICS: parseBoolEnv(process.env.ENABLE_OPENMETRICS, false),
    MEDIA_DEBUG_LOGS: parseBoolEnv(process.env.MEDIA_DEBUG_LOGS, false),
    // Public share URL (recommended when using a tunnel/reverse proxy)
    SHARE_BASE_URL: (process.env.SHARE_BASE_URL || '').trim(),
    EXTRA_ALLOWED_ORIGINS: (process.env.EXTRA_ALLOWED_ORIGINS || '').trim(),

    // TLS certificate generation
    HTTPS_INCLUDE_LAN_IP_IN_CERT: parseBoolEnv(process.env.HTTPS_INCLUDE_LAN_IP_IN_CERT, false),

    // ── OBS / WHIP ──
    WHIP_ENABLED: parseBoolEnv(process.env.WHIP_ENABLED, true),
    WHIP_HTTP_PORT: parseIntEnv(process.env.WHIP_HTTP_PORT, 3001),
    WHIP_BIND_HOST: (process.env.WHIP_BIND_HOST || '127.0.0.1').trim() || '127.0.0.1',
    // The OBS-compatible listener is plain HTTP. Widening it beyond loopback
    // exposes bearer credentials unless a VPN or TLS reverse proxy protects it.
    WHIP_ALLOW_INSECURE_REMOTE: parseBoolEnv(process.env.WHIP_ALLOW_INSECURE_REMOTE, false),
    FFMPEG_PATH: (process.env.FFMPEG_PATH || 'ffmpeg').trim(),
    FALLBACK_AUDIO_BITRATE: (process.env.FALLBACK_AUDIO_BITRATE || '192k').trim(),
    // How much the relay delays OBS audio to match video (milliseconds). The video
    // picks up real latency that audio does not (decode -> NVENC re-encode -> 1s-GOP
    // fragmentation), so without this audio leads the picture by ~a second. If audio
    // still plays AHEAD of the lips, raise this; if it lags BEHIND, lower it.
    FALLBACK_AUDIO_OFFSET_MS: parseIntEnv(process.env.FALLBACK_AUDIO_OFFSET_MS, 1500),
    FALLBACK_FRAGMENT_DURATION_MS: parseIntEnv(process.env.FALLBACK_FRAGMENT_DURATION_MS, 500),
    MAX_FALLBACK_VIEWERS: parseIntEnv(process.env.MAX_FALLBACK_VIEWERS, 50),
    MAX_FALLBACK_PIPELINES: parseIntEnv(process.env.MAX_FALLBACK_PIPELINES, 2),
    FALLBACK_RESTART_CAP: parseIntEnv(process.env.FALLBACK_RESTART_CAP, 5),
    WHIP_GRACE_TIMEOUT_MS: parseIntEnv(process.env.WHIP_GRACE_TIMEOUT_MS, 15000),
    // ── WHEP ──
    WHEP_ENABLED: parseBoolEnv(process.env.WHEP_ENABLED, false),
    WHEP_RATE_LIMIT_MAX: parseIntEnv(process.env.WHEP_RATE_LIMIT_MAX, 5),
    WHEP_RATE_LIMIT_WINDOW_MS: parseIntEnv(process.env.WHEP_RATE_LIMIT_WINDOW_MS, 60000),
    WHEP_MAX_GLOBAL_SESSIONS: parseIntEnv(process.env.WHEP_MAX_GLOBAL_SESSIONS, 30),
    WHIP_HEARTBEAT_INTERVAL_MS: parseIntEnv(process.env.WHIP_HEARTBEAT_INTERVAL_MS, 5000),
};

function assertNumberInRange(name, value, min, max) {
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`Invalid ${name}: expected a number from ${min} to ${max}, received ${value}.`);
    }
}

function validateConfig(value) {
    assertNumberInRange('PORT', value.PORT, 1, 65535);
    assertNumberInRange('WHIP_HTTP_PORT', value.WHIP_HTTP_PORT, 1, 65535);
    assertNumberInRange('RTC_MIN_PORT', value.RTC_MIN_PORT, 1, 65534);
    assertNumberInRange('RTC_MAX_PORT', value.RTC_MAX_PORT, 2, 65535);
    if (value.RTC_MIN_PORT > value.RTC_MAX_PORT) {
        throw new Error(`Invalid RTC port range: RTC_MIN_PORT (${value.RTC_MIN_PORT}) exceeds RTC_MAX_PORT (${value.RTC_MAX_PORT}).`);
    }
    if (value.PUBLIC_IP && value.RTC_MIN_PORT + 1 > value.RTC_MAX_PORT) {
        throw new Error('Invalid RTC port range: public and LAN candidates require at least two ports.');
    }
    if (value.CLOUDFLARED_TUNNEL_TOKEN && !value.SHARE_BASE_URL) {
        throw new Error('Invalid tunnel configuration: SHARE_BASE_URL is required with CLOUDFLARED_TUNNEL_TOKEN.');
    }
    const whipBindHost = String(value.WHIP_BIND_HOST || '').toLowerCase().replace(/^\[|\]$/g, '');
    const whipIsLoopback = whipBindHost === 'localhost'
        || whipBindHost === '::1'
        || /^127\.\d+\.\d+\.\d+$/.test(whipBindHost);
    if (value.WHIP_ENABLED && !whipIsLoopback && !value.WHIP_ALLOW_INSECURE_REMOTE) {
        throw new Error(
            `Refusing plaintext WHIP listener on non-loopback host ${value.WHIP_BIND_HOST}. `
            + 'Keep WHIP_BIND_HOST on loopback, or set WHIP_ALLOW_INSECURE_REMOTE=1 only behind an encrypted VPN/TLS proxy.'
        );
    }

    [
        ['HOST_UPLOAD_MBPS', value.HOST_UPLOAD_MBPS, 0.1, 100000],
        ['MAX_VIEWERS_PER_ROOM', value.MAX_VIEWERS_PER_ROOM, 1, 1000],
        ['MAX_ACTIVE_ROOMS', value.MAX_ACTIVE_ROOMS, 1, 1000],
        ['MAX_FALLBACK_VIEWERS', value.MAX_FALLBACK_VIEWERS, 1, 1000],
        ['MAX_FALLBACK_PIPELINES', value.MAX_FALLBACK_PIPELINES, 1, 100],
        ['MAX_CONNECTIONS_PER_IP', value.MAX_CONNECTIONS_PER_IP, 1, 100000],
        ['SOCKET_MAX_HTTP_BUFFER_SIZE', value.SOCKET_MAX_HTTP_BUFFER_SIZE, 1024, 1024 * 1024 * 1024],
        ['MEDIA_MAX_CHUNK_SIZE', value.MEDIA_MAX_CHUNK_SIZE, 1024, 1024 * 1024 * 1024],
        ['RELAY_SOCKET_MAX_BUFFERED_BYTES', value.RELAY_SOCKET_MAX_BUFFERED_BYTES, 1024, 1024 * 1024 * 1024],
    ].forEach(([name, number, min, max]) => assertNumberInRange(name, number, min, max));

    [
        'PUBLIC_TUNNEL_TIMEOUT_MS', 'MEDIA_TOGGLE_VIEWER_COOLDOWN_MS',
        'CREATE_ROOM_RATE_LIMIT_MAX', 'CREATE_ROOM_RATE_LIMIT_WINDOW_MS',
        'JOIN_RATE_LIMIT_MAX', 'JOIN_RATE_LIMIT_WINDOW_MS', 'ROOM_STALE_TIMEOUT_MS',
        'SOCKET_PING_INTERVAL_MS', 'SOCKET_PING_TIMEOUT_MS', 'CONNECTION_WINDOW_MS',
        'RELAY_FLUSH_INTERVAL_MS', 'RELAY_VIDEO_BITS_PER_SECOND',
        'HOST_RECONNECT_GRACE_MS', 'METRICS_BROADCAST_INTERVAL_MS',
        'FALLBACK_FRAGMENT_DURATION_MS', 'WHIP_GRACE_TIMEOUT_MS',
        'WHEP_RATE_LIMIT_MAX', 'WHEP_RATE_LIMIT_WINDOW_MS',
        'WHEP_MAX_GLOBAL_SESSIONS', 'WHIP_HEARTBEAT_INTERVAL_MS',
    ].forEach((name) => assertNumberInRange(name, value[name], 1, Number.MAX_SAFE_INTEGER));

    assertNumberInRange('FALLBACK_AUDIO_OFFSET_MS', value.FALLBACK_AUDIO_OFFSET_MS, 0, 60_000);
    assertNumberInRange('FALLBACK_RESTART_CAP', value.FALLBACK_RESTART_CAP, 0, 100);
    assertNumberInRange('WORKER_RECOVERY_MIN_UPTIME_SECONDS', value.WORKER_RECOVERY_MIN_UPTIME_SECONDS, 0, 3600);
}

validateConfig(config);
module.exports = config;
