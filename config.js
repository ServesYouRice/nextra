// config.js - Single source of truth for all configuration
require('dotenv').config();
const os = require('os');
const crypto = require('crypto');

function getLanIp() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
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

module.exports = {
    // Server
    PORT: parseIntEnv(process.env.PORT, 3000),
    BIND_HOST: bindHost,

    // HTTPS - self-signed cert auto-generated and cached here
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

    // Generate ICE servers with ephemeral TURN credentials.
    getIceServers() {
        const servers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ];

        const turnUrl = this.TURN_URL;
        if (!turnUrl) return servers;

        const urls = turnUrl.split(',').map((u) => u.trim()).filter(Boolean);

        if (this.TURN_SECRET) {
            const ttl = 86400; // 24h in seconds
            const timestamp = Math.floor(Date.now() / 1000) + ttl;
            const username = `${timestamp}:nextra`;
            const credential = crypto
                .createHmac('sha1', this.TURN_SECRET)
                .update(username)
                .digest('base64');

            urls.forEach((url) => {
                servers.push({ urls: url, username, credential });
            });
        } else if (this.TURN_USERNAME && this.TURN_CREDENTIAL) {
            urls.forEach((url) => {
                servers.push({ urls: url, username: this.TURN_USERNAME, credential: this.TURN_CREDENTIAL });
            });
        }

        return servers;
    },

    // Bandwidth management
    HOST_UPLOAD_MBPS: parseFloatEnv(process.env.HOST_UPLOAD_MBPS, 36),

    // Room limits
    MAX_VIEWERS_PER_ROOM: parseIntEnv(process.env.MAX_VIEWERS_PER_ROOM, 20),

    // Rate limits
    MEDIA_TOGGLE_COOLDOWN_MS: 1000,
    MEDIA_TOGGLE_VIEWER_COOLDOWN_MS: parseIntEnv(process.env.MEDIA_TOGGLE_VIEWER_COOLDOWN_MS, 3000),
    JOIN_RATE_LIMIT_MAX: 5,
    JOIN_RATE_LIMIT_WINDOW_MS: 60000,

    // Room cleanup
    ROOM_HEARTBEAT_INTERVAL_MS: 60000,
    ROOM_STALE_TIMEOUT_MS: parseIntEnv(process.env.ROOM_STALE_TIMEOUT_MS, 600000),

    // Socket.io
    SOCKET_PATH: '/socket.io',

    // Socket / relay limits
    MAX_CONNECTIONS_PER_IP: parseIntEnv(process.env.MAX_CONNECTIONS_PER_IP, 60),
    CONNECTION_WINDOW_MS: parseIntEnv(process.env.CONNECTION_WINDOW_MS, 60000),
    SOCKET_MAX_HTTP_BUFFER_SIZE: parseIntEnv(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE, 8 * 1024 * 1024),
    MEDIA_MAX_CHUNK_SIZE: parseIntEnv(process.env.MEDIA_MAX_CHUNK_SIZE, 4 * 1024 * 1024),
    RELAY_FLUSH_INTERVAL_MS: parseIntEnv(process.env.RELAY_FLUSH_INTERVAL_MS, 300),
    RELAY_VIDEO_BITS_PER_SECOND: parseIntEnv(process.env.RELAY_VIDEO_BITS_PER_SECOND, 45000000),
    HOST_RECONNECT_GRACE_MS: parseIntEnv(process.env.HOST_RECONNECT_GRACE_MS, 300000),
    METRICS_BROADCAST_INTERVAL_MS: parseIntEnv(process.env.METRICS_BROADCAST_INTERVAL_MS, 5000),
    ALLOW_REMOTE_METRICS: parseBoolEnv(process.env.ALLOW_REMOTE_METRICS, false),
    METRICS_TOKEN: (process.env.METRICS_TOKEN || '').trim(),
    // Public share URL (recommended when using a tunnel/reverse proxy)
    SHARE_BASE_URL: (process.env.SHARE_BASE_URL || '').trim(),
    EXTRA_ALLOWED_ORIGINS: (process.env.EXTRA_ALLOWED_ORIGINS || '').trim(),

    // TLS certificate generation
    HTTPS_INCLUDE_LAN_IP_IN_CERT: parseBoolEnv(process.env.HTTPS_INCLUDE_LAN_IP_IN_CERT, false),

    // ── OBS / WHIP ──
    WHIP_ENABLED: parseBoolEnv(process.env.WHIP_ENABLED, true),
    WHIP_HTTP_PORT: parseIntEnv(process.env.WHIP_HTTP_PORT, 3001),
    FFMPEG_PATH: (process.env.FFMPEG_PATH || 'ffmpeg').trim(),
    FALLBACK_AUDIO_BITRATE: (process.env.FALLBACK_AUDIO_BITRATE || '192k').trim(),
    FALLBACK_FRAGMENT_DURATION_MS: parseIntEnv(process.env.FALLBACK_FRAGMENT_DURATION_MS, 500),
    MAX_FALLBACK_VIEWERS: parseIntEnv(process.env.MAX_FALLBACK_VIEWERS, 50),
    MAX_FALLBACK_CHUNK_SIZE: parseIntEnv(process.env.MAX_FALLBACK_CHUNK_SIZE, 2 * 1024 * 1024),
    FALLBACK_RESTART_CAP: parseIntEnv(process.env.FALLBACK_RESTART_CAP, 5),
    WHIP_GRACE_TIMEOUT_MS: parseIntEnv(process.env.WHIP_GRACE_TIMEOUT_MS, 15000),
    // ── WHEP ──
    WHEP_ENABLED: parseBoolEnv(process.env.WHEP_ENABLED, false),
    WHEP_RATE_LIMIT_MAX: parseIntEnv(process.env.WHEP_RATE_LIMIT_MAX, 5),
    WHEP_RATE_LIMIT_WINDOW_MS: parseIntEnv(process.env.WHEP_RATE_LIMIT_WINDOW_MS, 60000),
    WHEP_MAX_GLOBAL_SESSIONS: parseIntEnv(process.env.WHEP_MAX_GLOBAL_SESSIONS, 30),
    WHIP_HEARTBEAT_INTERVAL_MS: parseIntEnv(process.env.WHIP_HEARTBEAT_INTERVAL_MS, 5000),
};
