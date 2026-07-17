// server.js - Entry point: Express + Socket.io + Mediasoup
require('dotenv').config();
const { installConsoleLogger, runWithLogContext } = require('./lib/logger');
installConsoleLogger();
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Server } = require('socket.io');
const helmet = require('helmet');
const compression = require('compression');
const { monitorEventLoopDelay } = require('perf_hooks');
const config = require('./config');
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

// Resolved run mode. Development origins (the Vite dev server on :5173) are
// opt-in via the --dev flag (npm run dev:server) or NODE_ENV/APP_ENV=development.
// `npm start` sets none of these, so a production start never enables them.
const isDevMode = process.argv.includes('--dev')
    || process.env.NODE_ENV === 'development'
    || process.env.APP_ENV === 'development';
const { createMediasoupWorker, setWorkerDeathHandler } = require('./lib/mediasoup');
const {
    registerSocketHandlers,
    startJoinCleanup,
    stopJoinCleanup,
    getSocketRuntimeMetrics,
    destroyRoomWithReason,
    startFallbackRelay,
    stopFallbackRelay,
    emitHostMetrics,
} = require('./lib/socket');
const { startRoomCleanup, stopRoomCleanup, getAllRoomStats } = require('./lib/rooms');
const { getOrCreateCert } = require('./lib/https');
const { startCloudflareTunnel } = require('./lib/tunnel');
const { fetchCloudflareTurnCredentials } = require('./lib/cloudflareTurn');
const {
    normalizeIp,
    parseForwardedFirst,
    isLocalHostname,
    isLocalClientIp,
    isLoopbackIp,
    shouldTrustForwardedHeaders,
    getTrustedForwardedClientIp,
} = require('./lib/network');
const { createWhipRouter, setIo: setWhipIo, setMediaLifecycle: setWhipMediaLifecycle } = require('./lib/whipRoutes');
const { createWhepRouter } = require('./lib/whepRoutes');
const { warmNvencProbe, getNvencProbeStatus } = require('./lib/ffmpegRelay');
const { findAvailablePort } = require('./lib/portResolver');
const { resolveExecutablePath } = require('./lib/executable');
const { renderOpenMetrics } = require('./lib/openMetrics');
const { decideWorkerDeathAction } = require('./lib/workerRecovery');
const { execFile, execFileSync } = require('child_process');

setWhipMediaLifecycle({ startFallbackRelay, stopFallbackRelay, emitHostMetrics });

// Process-level safety net. Without these, a single stray promise rejection or
// uncaught exception terminates the whole process on modern Node, dropping every
// room and viewer — and the mediasoup worker-death auto-restart below does NOT
// cover main-process crashes. An unhandled rejection is logged but not treated as
// fatal (much of the codebase guards with .catch(); one stray rejection should not
// nuke unrelated rooms). An uncaught exception leaves indeterminate state, so we
// clean up listeners/worker and exit non-zero for a supervisor to restart us.
process.on('unhandledRejection', (reason) => {
    console.error('[fatal-guard] Unhandled promise rejection:', reason?.stack || reason);
});
process.on('uncaughtException', (err) => {
    console.error('[fatal-guard] Uncaught exception:', err?.stack || err?.message || err);
    try { cleanupGlobalResources(); } catch { }
    process.exit(1);
});

const app = express();
let runtimeShareBaseUrl = '';
let stopPublicTunnel = null;
let ioServer = null;
let publicShareStatus = config.CLOUDFLARED_TUNNEL_TOKEN
    ? 'starting'
    : (normalizeBaseUrl(config.SHARE_BASE_URL) ? 'manual' : (config.AUTO_PUBLIC_TUNNEL ? 'starting' : 'disabled'));
let publicShareError = '';
let runtimeWhipHttpPort = config.WHIP_HTTP_PORT;
let whipHttpStatus = config.WHIP_ENABLED ? 'starting' : 'disabled';
let whipHttpError = '';
let whipHttpServer = null;
let serviceReady = false;
let tunnelRestartTimer = null;
let tunnelRestartAttempts = 0;
let requestGracefulShutdown = null;

app.use((req, _res, next) => {
    const requestId = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 128);
    runWithLogContext({ requestId, method: req.method, path: req.path }, next);
});

function getLocalProtocol() {
    return config.LOCAL_HTTPS ? 'https' : 'http';
}

function getHostPageUrl(protocol = getLocalProtocol()) {
    return `${protocol}://127.0.0.1:${config.PORT}/#host`;
}

function openBrowser(url) {
    if (!config.OPEN_BROWSER || !url) return;

    try {
        if (process.platform === 'win32') {
            execFileSync('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true });
            return;
        }

        const child = process.platform === 'darwin'
            ? execFile('open', [url])
            : execFile('xdg-open', [url]);
        if (typeof child.unref === 'function') child.unref();
    } catch (err) {
        console.warn(`Could not open browser automatically: ${err.message}`);
    }
}

if (config.TRUST_PROXY !== false) {
    app.set('trust proxy', config.TRUST_PROXY);
}

// gzip/deflate compression for HTTP responses (static assets, API, SPA HTML).
app.use(compression());

app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
});

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", (_req, res) => `'nonce-${res.locals.cspNonce}'`],
            styleSrc: ["'self'"],
            fontSrc: ["'self'"],
            connectSrc: ["'self'", 'ws:', 'wss:'],
            imgSrc: ["'self'", 'data:', 'blob:'],
            mediaSrc: ["'self'", 'blob:'],
            workerSrc: ["'self'", 'blob:'],
        },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.LOCAL_HTTPS ? { maxAge: 31536000, includeSubDomains: false } : false,
}));

function getRemoteAddressFromReq(req) {
    return normalizeIp(
        req?.socket?.remoteAddress
        || req?.connection?.remoteAddress
        || 'unknown'
    );
}

function parseUrlHostParts(hostValue) {
    if (!hostValue) return null;
    const trimmed = hostValue.trim();
    if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes(' ')) return null;

    const probe = trimmed.startsWith('[') ? `https://${trimmed}` : `https://${trimmed}`;
    try {
        const parsed = new URL(probe);
        const hostname = parsed.hostname;
        if (!hostname) return null;
        const port = parsed.port || '';
        return { hostname, port, hostWithPort: port ? `${hostname}:${port}` : hostname };
    } catch {
        return null;
    }
}

function normalizeOrigin(origin) {
    if (!origin || typeof origin !== 'string') return '';
    try {
        const parsed = new URL(origin);
        return `${parsed.protocol}//${parsed.host}`;
    } catch {
        return '';
    }
}

function normalizeBaseUrl(url) {
    const normalized = normalizeOrigin(url);
    return normalized.replace(/\/$/, '');
}

function getOriginHostname(origin) {
    const normalized = normalizeOrigin(origin);
    if (!normalized) return '';
    try {
        return new URL(normalized).hostname;
    } catch {
        return '';
    }
}

function isPublicOrigin(origin) {
    const hostname = getOriginHostname(origin);
    return !!hostname && !isLocalHostname(hostname, config.LAN_IP);
}

function getKnownPublicShareOrigins() {
    return [
        normalizeBaseUrl(config.SHARE_BASE_URL),
        runtimeShareBaseUrl,
    ].filter((origin) => origin && isPublicOrigin(origin));
}

function isKnownPublicShareOrigin(origin) {
    const normalized = normalizeBaseUrl(origin);
    if (!normalized || !isPublicOrigin(normalized)) return false;
    return getKnownPublicShareOrigins().includes(normalized);
}

function getForwardedOrigin(headers = {}) {
    const forwardedProto = parseForwardedFirst(headers['x-forwarded-proto']);
    const forwardedHost = parseForwardedFirst(headers['x-forwarded-host']);
    const proto = (forwardedProto || '').toLowerCase();
    const hostParts = parseUrlHostParts(forwardedHost);
    if ((proto === 'http' || proto === 'https') && hostParts) {
        return `${proto}://${hostParts.hostWithPort}`;
    }

    return '';
}

function getRequestHostOrigin(headers = {}, encrypted = true) {
    const hostHeader = typeof headers.host === 'string' ? headers.host : '';
    const hostParts = parseUrlHostParts(hostHeader);
    if (!hostParts) return '';
    return `${encrypted ? 'https' : 'http'}://${hostParts.hostWithPort}`;
}

function isKnownPublicShareRequest(headers = {}, encrypted = true) {
    const candidates = [
        getForwardedOrigin(headers),
        getRequestHostOrigin(headers, encrypted),
        normalizeOrigin(headers.origin),
        normalizeOrigin(headers.referer || headers.referrer),
    ];

    return candidates.some((origin) => isKnownPublicShareOrigin(origin));
}

function shouldTrustRequestForwardedHeaders(headers = {}, remoteAddress = '', encrypted = true) {
    if (shouldTrustForwardedHeaders(remoteAddress, config.TRUST_X_FORWARDED_HEADERS)) {
        return true;
    }

    return isLoopbackIp(remoteAddress)
        && isKnownPublicShareRequest(headers, encrypted);
}

function getClientIpFromHeaders(headers = {}, remoteAddress = '', encrypted = true) {
    const normalizedRemote = normalizeIp(remoteAddress || 'unknown');
    const trustForwarded = shouldTrustRequestForwardedHeaders(headers, normalizedRemote, encrypted);
    const forwardedIp = getTrustedForwardedClientIp(headers, normalizedRemote, trustForwarded);
    if (forwardedIp) return forwardedIp;

    if (isKnownPublicShareRequest(headers, encrypted)) {
        // The built-in cloudflared tunnel proxies from loopback, so we don't trust
        // forwarded headers for security decisions — but cloudflared does set
        // cf-connecting-ip to the real viewer address. Fold it into a namespaced,
        // per-viewer identity so each internet viewer gets its OWN rate-limit
        // bucket instead of every tunnel viewer sharing 'public-share-proxy' (which
        // let one client's traffic rate-limit everyone off the tunnel). The
        // 'public-share:' prefix keeps this from ever matching isLocalClientIp, so
        // LAN-URL and metrics gating are unchanged.
        const tunnelViewerIp = parseForwardedFirst(headers['cf-connecting-ip']);
        return tunnelViewerIp
            ? `public-share:${normalizeIp(tunnelViewerIp)}`
            : 'public-share-proxy';
    }

    return normalizedRemote;
}

function getRequestClientIp(req) {
    return getClientIpFromHeaders(
        req?.headers || {},
        getRemoteAddressFromReq(req),
        !!req?.socket?.encrypted
    );
}

function shouldExposeLanUrl(req) {
    if (config.EXPOSE_LAN_URL) return true;
    return isLocalClientIp(getRequestClientIp(req));
}

function getHasTurnServer() {
    return config.iceServersIncludeTurn(config.getIceServers());
}

function isAllowedSocketOrigin(origin) {
    const normalized = normalizeOrigin(origin);
    if (!normalized) return false;

    const allowed = getAllowedOrigins();
    if (allowed.has(normalized)) return true;

    return config.ALLOW_TRYCLOUDFLARE_ORIGINS
        && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(normalized)
        && isKnownPublicShareOrigin(normalized);
}

function getSocketRequestHostOrigin(req) {
    const remoteAddress = getRemoteAddressFromReq(req);
    let proto = req?.socket?.encrypted ? 'https' : 'http';

    if (shouldTrustRequestForwardedHeaders(req?.headers || {}, remoteAddress, !!req?.socket?.encrypted)) {
        const forwardedProto = parseForwardedFirst(req?.headers?.['x-forwarded-proto']);
        if (forwardedProto === 'http' || forwardedProto === 'https') {
            proto = forwardedProto;
        }
    }

    const hostHeader = typeof req?.headers?.host === 'string' ? req.headers.host : '';
    const hostParts = parseUrlHostParts(hostHeader);
    if (!hostParts) return '';

    return `${proto}://${hostParts.hostWithPort}`;
}

function validateSocketHandshakeRequest(req) {
    const originHeader = typeof req?.headers?.origin === 'string' ? req.headers.origin : '';
    const normalizedOrigin = normalizeOrigin(originHeader);

    if (normalizedOrigin) {
        if (isAllowedSocketOrigin(normalizedOrigin)) {
            return { ok: true };
        }

        return {
            ok: false,
            reason: `Blocked CORS origin: ${originHeader}`,
        };
    }

    if (config.ALLOW_SOCKET_NO_ORIGIN) {
        return { ok: true };
    }

    const refererHeader = typeof req?.headers?.referer === 'string'
        ? req.headers.referer
        : (typeof req?.headers?.referrer === 'string' ? req.headers.referrer : '');
    const refererOrigin = normalizeOrigin(refererHeader);
    if (refererOrigin && isAllowedSocketOrigin(refererOrigin)) {
        return { ok: true };
    }

    const hostOrigin = getSocketRequestHostOrigin(req);
    if (hostOrigin && isAllowedSocketOrigin(hostOrigin)) {
        return { ok: true };
    }

    return {
        ok: false,
        reason: 'Blocked socket connection with missing or untrusted Origin header.',
    };
}

function getAllowedOrigins() {
    const localProtocol = getLocalProtocol();
    const origins = new Set([
        `${localProtocol}://localhost:${config.PORT}`,
        `${localProtocol}://127.0.0.1:${config.PORT}`,
    ]);

    if (config.LAN_IP) {
        origins.add(`${localProtocol}://${config.LAN_IP}:${config.PORT}`);
    }

    if (config.PUBLIC_IP && config.PUBLIC_IP !== config.LAN_IP) {
        origins.add(`${localProtocol}://${config.PUBLIC_IP}:${config.PORT}`);
    }

    if (isDevMode) {
        origins.add('http://localhost:5173');
        origins.add('http://127.0.0.1:5173');
    }

    config.EXTRA_ALLOWED_ORIGINS
        .split(',')
        .map((origin) => normalizeOrigin(origin.trim()))
        .filter(Boolean)
        .forEach((origin) => origins.add(origin));

    const manualShareBase = normalizeBaseUrl(config.SHARE_BASE_URL);
    if (manualShareBase) origins.add(manualShareBase);
    if (runtimeShareBaseUrl) origins.add(runtimeShareBaseUrl);

    return origins;
}

function getShareBaseUrl(req) {
    if (runtimeShareBaseUrl) {
        return runtimeShareBaseUrl;
    }

    const manualShareBase = normalizeBaseUrl(config.SHARE_BASE_URL);
    if (manualShareBase) {
        return manualShareBase;
    }

    if (shouldTrustRequestForwardedHeaders(req.headers || {}, getRemoteAddressFromReq(req), !!req?.socket?.encrypted)) {
        const forwardedProto = parseForwardedFirst(req.headers['x-forwarded-proto']);
        const forwardedHost = parseForwardedFirst(req.headers['x-forwarded-host']);
        const proto = (forwardedProto || '').toLowerCase();
        const hostParts = parseUrlHostParts(forwardedHost);
        if ((proto === 'http' || proto === 'https') && hostParts && !isLocalHostname(hostParts.hostname, config.LAN_IP)) {
            return `${proto}://${hostParts.hostWithPort}`;
        }
    }

    const reqProto = req.protocol === 'https' ? 'https' : 'http';
    const hostHeader = req.get('host') || '';
    const hostParts = parseUrlHostParts(hostHeader);
    if (hostParts && !isLocalHostname(hostParts.hostname, config.LAN_IP)) {
        return `${reqProto}://${hostParts.hostWithPort}`;
    }

    if (config.PUBLIC_IP && config.PUBLIC_IP !== config.LAN_IP) {
        return `${getLocalProtocol()}://${config.PUBLIC_IP}:${config.PORT}`;
    }

    return '';
}

function getLocalBaseUrl() {
    const bindHost = (config.BIND_HOST || '').toLowerCase();
    const localProtocol = getLocalProtocol();
    if (bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1' || bindHost === '[::1]') {
        return `${localProtocol}://localhost:${config.PORT}`;
    }
    if (bindHost && bindHost !== '0.0.0.0' && bindHost !== '::') {
        return `${localProtocol}://${config.BIND_HOST}:${config.PORT}`;
    }
    return `${localProtocol}://${config.LAN_IP}:${config.PORT}`;
}

function getLoopbackBaseUrl(protocol = getLocalProtocol()) {
    return `${protocol}://127.0.0.1:${config.PORT}`;
}

async function probeExistingNextraInstance(protocol = getLocalProtocol()) {
    return new Promise((resolve) => {
        const client = protocol === 'https' ? https : http;
        const requestOptions = {
            hostname: '127.0.0.1',
            port: config.PORT,
            path: '/api/config',
            timeout: 1500,
            headers: {
                accept: 'application/json',
            },
        };
        if (protocol === 'https') {
            requestOptions.rejectUnauthorized = false;
        }

        const req = client.get(
            requestOptions,
            (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    resolve(null);
                    return;
                }

                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    body += chunk;
                    if (body.length > 8192) {
                        body = body.slice(0, 8192);
                    }
                });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(body);
                        const looksLikeNextra = parsed
                            && typeof parsed === 'object'
                            && Object.prototype.hasOwnProperty.call(parsed, 'publicShareStatus')
                            && Object.prototype.hasOwnProperty.call(parsed, 'hostUploadMbps');
                        resolve(looksLikeNextra ? parsed : null);
                    } catch {
                        resolve(null);
                    }
                });
            }
        );

        req.on('timeout', () => req.destroy(new Error('probe timeout')));
        req.on('error', () => resolve(null));
    });
}

async function findRunningNextraProtocol() {
    const primaryProtocol = getLocalProtocol();
    const alternateProtocol = primaryProtocol === 'https' ? 'http' : 'https';

    if (await probeExistingNextraInstance(primaryProtocol)) {
        return primaryProtocol;
    }

    if (await probeExistingNextraInstance(alternateProtocol)) {
        return alternateProtocol;
    }

    return '';
}

async function exitIfAlreadyRunning() {
    const runningProtocol = await findRunningNextraProtocol();
    if (!runningProtocol) return false;

    console.log(`Nextra is already running at ${getLoopbackBaseUrl(runningProtocol)}.`);
    openBrowser(getHostPageUrl(runningProtocol));
    process.exit(0);
    return true;
}

function getShareBaseUrlFromHeaders(headers = {}, remoteAddress = '') {
    if (shouldTrustRequestForwardedHeaders(headers, remoteAddress, config.LOCAL_HTTPS)) {
        const forwardedProto = parseForwardedFirst(headers['x-forwarded-proto']);
        const forwardedHost = parseForwardedFirst(headers['x-forwarded-host']);
        const proto = (forwardedProto || '').toLowerCase();
        const hostParts = parseUrlHostParts(forwardedHost);
        if ((proto === 'http' || proto === 'https') && hostParts && !isLocalHostname(hostParts.hostname, config.LAN_IP)) {
            return `${proto}://${hostParts.hostWithPort}`;
        }
    }

    const hostHeader = typeof headers.host === 'string' ? headers.host : '';
    const hostParts = parseUrlHostParts(hostHeader);
    if (hostParts && !isLocalHostname(hostParts.hostname, config.LAN_IP)) {
        return `${getLocalProtocol()}://${hostParts.hostWithPort}`;
    }

    return '';
}

function getShareBaseUrlForSocket(socket) {
    if (runtimeShareBaseUrl) {
        return runtimeShareBaseUrl;
    }

    const manualShareBase = normalizeBaseUrl(config.SHARE_BASE_URL);
    if (manualShareBase) {
        return manualShareBase;
    }

    const headerBase = getShareBaseUrlFromHeaders(
        socket?.handshake?.headers || {},
        socket?.request?.socket?.remoteAddress || socket?.conn?.remoteAddress || socket?.handshake?.address || ''
    );
    if (headerBase) {
        return headerBase;
    }

    if (config.PUBLIC_IP && config.PUBLIC_IP !== config.LAN_IP) {
        return `${getLocalProtocol()}://${config.PUBLIC_IP}:${config.PORT}`;
    }

    return '';
}

function getSocketHandshakeIp(socket) {
    const remoteAddress = socket?.request?.socket?.remoteAddress
        || socket?.conn?.remoteAddress
        || socket?.handshake?.address
        || '';

    return getClientIpFromHeaders(
        socket?.handshake?.headers || {},
        remoteAddress,
        !!socket?.request?.socket?.encrypted
    );
}

function shouldExposeLanForSocket(socket) {
    if (config.EXPOSE_LAN_URL) return true;
    return isLocalClientIp(getSocketHandshakeIp(socket));
}

function getWhipHttpClientHost() {
    const host = (config.WHIP_BIND_HOST || '127.0.0.1').trim() || '127.0.0.1';
    if (host === '0.0.0.0' || host === '::' || host === '[::]' || host === 'localhost' || host === '::1' || host === '[::1]') {
        return '127.0.0.1';
    }
    return host;
}

function formatHostForUrl(host) {
    if (!host) return '127.0.0.1';
    if (host.includes(':') && !host.startsWith('[')) {
        return `[${host}]`;
    }
    return host;
}

function getWhipHttpBaseUrl() {
    return `http://${formatHostForUrl(getWhipHttpClientHost())}:${runtimeWhipHttpPort}`;
}

function buildSocketConfigPayload(socket) {
    return {
        hostUploadMbps: config.HOST_UPLOAD_MBPS,
        shareBaseUrl: getShareBaseUrlForSocket(socket),
        lanUrl: shouldExposeLanForSocket(socket) ? getLocalBaseUrl() : '',
        hasTurnServer: getHasTurnServer(),
        remoteMediaControlEnabled: config.ALLOW_REMOTE_MEDIA_CONTROL,
        publicAv1Supported: config.RTC_LISTEN_IP !== '127.0.0.1' && !!config.PUBLIC_IP,
        cloudflareTurnAutofillAvailable: config.hasCloudflareTurnCredentialSource(),
        mediaMaxChunkSize: config.MEDIA_MAX_CHUNK_SIZE,
        relayFlushIntervalMs: config.RELAY_FLUSH_INTERVAL_MS,
        relayVideoBitsPerSecond: config.RELAY_VIDEO_BITS_PER_SECOND,
        publicShareStatus,
        publicShareError,
        whipHttpHost: getWhipHttpClientHost(),
        whipHttpPort: runtimeWhipHttpPort,
        whipHttpStatus,
        whipHttpError,
        whipHttpUrl: getWhipHttpBaseUrl(),
    };
}

function emitServerConfigToSocket(socket) {
    if (!socket || typeof socket.emit !== 'function') return;
    socket.emit('server-config', buildSocketConfigPayload(socket));
}

function emitServerConfigToAll(io) {
    if (!io) return;
    io.sockets.sockets.forEach((socket) => emitServerConfigToSocket(socket));
}

function extractMetricsToken(req) {
    const authHeader = typeof req.headers.authorization === 'string'
        ? req.headers.authorization.trim()
        : '';
    if (authHeader.toLowerCase().startsWith('bearer ')) {
        return authHeader.slice(7).trim();
    }

    const headerToken = typeof req.headers['x-metrics-token'] === 'string'
        ? req.headers['x-metrics-token'].trim()
        : '';
    if (headerToken) return headerToken;

    return '';
}

function timingSafeStringEqual(a, b) {
    const left = Buffer.from(typeof a === 'string' ? a : '', 'utf-8');
    const right = Buffer.from(typeof b === 'string' ? b : '', 'utf-8');
    if (left.length === 0 || right.length === 0) return false;
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

function isMetricsTokenAuthorized(req) {
    const expected = config.METRICS_TOKEN;
    if (!expected) return false;
    const provided = extractMetricsToken(req);
    return timingSafeStringEqual(provided, expected);
}

async function loadCloudflareTurnCredentials() {
    const turnSource = config.getCloudflareTurnCredentialSource();
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 10_000);
    try {
        return await fetchCloudflareTurnCredentials({
            ...turnSource,
            signal: abortController.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

app.get('/api/config', (req, res) => {
    res.json({
        hostUploadMbps: config.HOST_UPLOAD_MBPS,
        shareBaseUrl: getShareBaseUrl(req),
        lanUrl: shouldExposeLanUrl(req) ? getLocalBaseUrl() : '',
        hasTurnServer: getHasTurnServer(),
        cloudflareTurnAutofillAvailable: config.hasCloudflareTurnCredentialSource(),
        // NOTE: ICE servers (with ephemeral TURN credentials) are intentionally
        // NOT exposed here. This endpoint is unauthenticated, so shipping TURN
        // credentials would hand them to any caller. Clients receive room-scoped
        // ICE servers via the create-send-transport / create-recv-transport socket
        // responses (getRoomIceServers), which require room membership first.
        mediaMaxChunkSize: config.MEDIA_MAX_CHUNK_SIZE,
        relayFlushIntervalMs: config.RELAY_FLUSH_INTERVAL_MS,
        relayVideoBitsPerSecond: config.RELAY_VIDEO_BITS_PER_SECOND,
        publicShareStatus,
        publicShareError,
        whipEnabled: config.WHIP_ENABLED,
        whipHttpHost: getWhipHttpClientHost(),
        whipHttpPort: runtimeWhipHttpPort,
        whipHttpStatus,
        whipHttpError,
        whipHttpUrl: getWhipHttpBaseUrl(),
        whepEnabled: config.WHEP_ENABLED,
    });
});

let cachedCloudflareTurnCredentials = null;
let cachedCloudflareTurnCredentialsExpiresAt = 0;
const cloudflareTurnMintByIp = new Map();

app.post('/api/cloudflare-turn-credentials', async (req, res) => {
    if (!isLocalClientIp(getRequestClientIp(req))) {
        res.status(403).json({ error: 'Cloudflare TURN autofill is only available to local or LAN hosts.' });
        return;
    }

    if (!config.hasCloudflareTurnCredentialSource()) {
        res.status(404).json({ error: 'Cloudflare TURN autofill is not configured on this server.' });
        return;
    }

    const requestOrigin = normalizeOrigin(req.headers.origin || '');
    if (!requestOrigin || !isAllowedSocketOrigin(requestOrigin)) {
        res.status(403).json({ error: 'A trusted same-origin request is required.' });
        return;
    }

    const clientIp = getRequestClientIp(req);
    const now = Date.now();
    const previousMint = cloudflareTurnMintByIp.get(clientIp) || 0;
    if (now - previousMint < 10_000) {
        res.status(429).json({ error: 'TURN credentials were requested too recently.' });
        return;
    }

    if (cachedCloudflareTurnCredentials && now < cachedCloudflareTurnCredentialsExpiresAt) {
        res.set('Cache-Control', 'no-store');
        res.json(cachedCloudflareTurnCredentials);
        return;
    }

    cloudflareTurnMintByIp.set(clientIp, now);

    try {
        const result = await loadCloudflareTurnCredentials();
        const payload = {
            provider: 'cloudflare',
            ttlSeconds: result.ttlSeconds,
            turnConfig: result.turnConfig,
        };
        cachedCloudflareTurnCredentials = payload;
        cachedCloudflareTurnCredentialsExpiresAt = now + Math.max(0, (result.ttlSeconds - 60) * 1000);
        res.set('Cache-Control', 'no-store');
        res.json(payload);
    } catch (err) {
        const statusCode = err?.name === 'AbortError' ? 504 : 502;
        res.status(statusCode).json({
            error: err?.message || 'Failed to fetch Cloudflare TURN credentials.',
        });
    }
});

app.get('/api/metrics', async (req, res) => {
    const clientIp = getRequestClientIp(req);
    const isLocalClient = isLocalClientIp(clientIp);
    if (!config.ALLOW_REMOTE_METRICS && !isLocalClient) {
        res.status(403).json({ error: 'Metrics access denied for remote clients.' });
        return;
    }

    if (!isLocalClient && config.METRICS_TOKEN && !isMetricsTokenAuthorized(req)) {
        res.status(401).json({ error: 'Metrics token required for remote access.' });
        return;
    }

    const rooms = getAllRoomStats();
    const includeSensitiveRoomFields = isLocalClient || isMetricsTokenAuthorized(req);
    const roomList = includeSensitiveRoomFields
        ? rooms
        : rooms.map(({ code: _code, hostSocketId: _hostSocketId, ...room }) => room);
    const totalViewers = rooms.reduce((sum, room) => sum + room.viewerCount, 0);
    const totalRelayViewers = rooms.reduce((sum, room) => sum + room.relayViewerCount, 0);
    const totalWhepViewers = rooms.reduce((sum, room) => sum + (room.whepViewerCount || 0), 0);
    const totalConsumers = rooms.reduce((sum, room) => sum + room.mediasoupConsumerCount, 0);
    let mediaWorkerResourceUsage = null;
    if (worker && !worker.closed) {
        try {
            mediaWorkerResourceUsage = await worker.getResourceUsage();
        } catch (err) {
            console.warn(`[Metrics] Could not sample mediasoup worker resource usage: ${err.message}`);
        }
    }

    const payload = {
        generatedAt: new Date().toISOString(),
        runtimeShareBaseUrl,
        process: {
            uptimeSec: Math.floor(process.uptime()),
            memory: process.memoryUsage(),
            cpuUsageMicroseconds: process.cpuUsage(),
            eventLoopDelayMs: {
                mean: Number.isFinite(eventLoopDelay.mean) ? eventLoopDelay.mean / 1e6 : 0,
                p95: eventLoopDelay.percentile(95) / 1e6,
                max: eventLoopDelay.max / 1e6,
            },
        },
        rooms: {
            active: rooms.length,
            totalViewers,
            totalRelayViewers,
            totalWhepViewers,
            totalMediasoupConsumers: totalConsumers,
            list: roomList,
            sensitiveFieldsIncluded: includeSensitiveRoomFields,
        },
        sockets: getSocketRuntimeMetrics(),
        fallbackRelay: {
            nvencProbe: getNvencProbeStatus(),
        },
        mediaWorker: {
            resourceUsage: mediaWorkerResourceUsage,
        },
    };
    res.json(payload);
    // Benchmark clients can request interval-local histogram values. Access is
    // already protected by the metrics authorization above; normal dashboard
    // reads retain the existing process-lifetime histogram semantics.
    if (req.query.resetEventLoopDelay === 'true') eventLoopDelay.reset();
});

app.get('/metrics', (req, res) => {
    if (!config.ENABLE_OPENMETRICS) {
        res.status(404).type('text/plain').send('OpenMetrics exporter is disabled.\n');
        return;
    }
    if (!config.METRICS_TOKEN) {
        res.status(503).type('text/plain').send('METRICS_TOKEN is required when OpenMetrics is enabled.\n');
        return;
    }
    if (!isMetricsTokenAuthorized(req)) {
        res.status(401).set('WWW-Authenticate', 'Bearer').type('text/plain').send('Metrics token required.\n');
        return;
    }

    const rooms = getAllRoomStats();
    const processMetrics = {
        uptimeSec: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        eventLoopDelayMs: {
            p95: eventLoopDelay.percentile(95) / 1e6,
        },
    };
    res.set('Cache-Control', 'no-store');
    res.type('application/openmetrics-text; version=1.0.0; charset=utf-8');
    res.send(renderOpenMetrics({
        processMetrics,
        rooms: {
            active: rooms.length,
            totalViewers: rooms.reduce((sum, room) => sum + room.viewerCount, 0),
            totalRelayViewers: rooms.reduce((sum, room) => sum + room.relayViewerCount, 0),
            totalWhepViewers: rooms.reduce((sum, room) => sum + (room.whepViewerCount || 0), 0),
            totalMediasoupConsumers: rooms.reduce((sum, room) => sum + room.mediasoupConsumerCount, 0),
        },
        sockets: getSocketRuntimeMetrics(),
    }));
});

app.get('/api/package-info', (req, res) => {
    if (!isLocalClientIp(getRequestClientIp(req))) {
        res.status(403).json({ error: 'Package information is only available locally.' });
        return;
    }
    const exists = (name) => fs.existsSync(path.join(__dirname, name));
    res.set('Cache-Control', 'no-store').json({
        version: require('./package.json').version,
        packaged: process.env.NEXTRA_PACKAGED === '1',
        artifacts: {
            license: exists('LICENSE'),
            notices: exists('THIRD_PARTY_NOTICES.md'),
            sourceInstructions: exists('SOURCE.md'),
            sbom: exists('SBOM.cdx.json'),
        },
    });
});

// Kept behind an explicit process-local test flag so release CI can exercise the
// real graceful-shutdown path without exposing a production control endpoint.
app.post('/api/test/shutdown', (req, res) => {
    if (process.env.NEXTRA_SMOKE_TEST !== '1' || !isLocalClientIp(getRequestClientIp(req))) {
        res.status(404).end();
        return;
    }
    if (!requestGracefulShutdown) {
        res.status(503).json({ error: 'Shutdown handler is not ready.' });
        return;
    }
    res.status(202).json({ status: 'shutting-down' });
    void requestGracefulShutdown('SMOKE_TEST');
});

app.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
});

app.get('/readyz', (_req, res) => {
    const ready = serviceReady && !!worker && !!ioServer;
    res.set('Cache-Control', 'no-store').status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not-ready',
        mediaWorker: !!worker,
        socketServer: !!ioServer,
        whip: whipHttpStatus,
        fallbackRelay: {
            nvencProbe: getNvencProbeStatus(),
        },
    });
});

const distDir = path.join(__dirname, 'dist');
const indexHtmlPath = path.join(distDir, 'index.html');
const buildRequiredCssPath = path.join(__dirname, 'public', 'build-required.css');
let indexHtmlTemplate = null;
let indexHtmlMtimeMs = 0;

function getIndexHtml(nonce) {
    // Re-read when dist/index.html changes on disk so an in-place rebuild (which
    // replaces the HTML and its hashed asset references) is picked up without a
    // server restart. Otherwise a cached old HTML would reference purged asset
    // filenames and 404 the entry chunk. The mtime stat is cheap and this path
    // only runs on HTML navigations (static assets are served separately).
    try {
        const mtimeMs = fs.statSync(indexHtmlPath).mtimeMs;
        if (!indexHtmlTemplate || mtimeMs !== indexHtmlMtimeMs) {
            indexHtmlTemplate = fs.readFileSync(indexHtmlPath, 'utf-8');
            indexHtmlMtimeMs = mtimeMs;
        }
    } catch {
        return indexHtmlTemplate ? indexHtmlTemplate.replace(/<script/g, `<script nonce="${nonce}"`) : null;
    }
    return indexHtmlTemplate.replace(/<script/g, `<script nonce="${nonce}"`);
}

app.use(express.static(distDir, {
    index: false,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.set('Cache-Control', 'no-store, max-age=0');
            res.set('Pragma', 'no-cache');
            res.set('Expires', '0');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            // Vite emits content-hashed filenames under /assets — safe to cache hard.
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
        }
    },
}));
// Kept outside dist so the source-tree error page remains styled precisely when
// the production bundle has not been built yet.
app.get('/build-required.css', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=86400').sendFile(buildRequiredCssPath);
});
// Unknown /api/* paths must return a JSON 404, not fall through to the SPA
// catch-all below (which would send a 200 HTML document and break callers doing
// res.json()). Every real /api route is registered above this point, so reaching
// here means the path is unknown. (WHIP/WHEP routers mount later at runtime, so
// they are deliberately NOT included here — intercepting them would break ingest.)
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
});
app.get('/{*splat}', (req, res) => {
    const requestPath = req.path || '';
    if (
        requestPath === '/api' || requestPath.startsWith('/api/')
        || requestPath === '/whip' || requestPath.startsWith('/whip/')
        || requestPath === '/whep' || requestPath.startsWith('/whep/')
        || requestPath === '/assets' || requestPath.startsWith('/assets/')
        || /\/[^/]+\.[A-Za-z0-9]{1,12}$/.test(requestPath)
    ) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    const html = getIndexHtml(res.locals.cspNonce);
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    if (html) {
        res.type('html').send(html);
    } else {
        // No built client found (dist/index.html missing). This happens when
        // running `npm start` from source without building first.
        res.status(503).type('html').send(
            '<!doctype html><meta charset="utf-8">'
            + '<title>Nextra - build required</title>'
            + '<link rel="stylesheet" href="/build-required.css">'
            + '<body>'
            + '<h1>Nextra is not built yet</h1>'
            + '<p>The production client bundle (<code>dist/</code>) was not found. '
            + 'This usually means <code>npm start</code> was run from source without building first.</p>'
            + '<p>Build it once, then start again:</p>'
            + '<pre>npm run build\nnpm start</pre>'
            + '<p>For development with hot reload, run <code>npm run dev</code> instead.</p>'
            + '</body>'
        );
    }
});

const connectionTracker = new Map(); // IP -> { count, resetAt }
const MAX_CONNECTIONS_PER_IP = config.MAX_CONNECTIONS_PER_IP;
const CONNECTION_WINDOW_MS = config.CONNECTION_WINDOW_MS;

function getSocketClientIp(rawSocket) {
    const req = rawSocket.request;
    const remoteAddress = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';

    return getClientIpFromHeaders(
        req?.headers || {},
        remoteAddress,
        !!req?.socket?.encrypted
    );
}

async function detectPublicIpIfEnabled() {
    if (config.PUBLIC_IP) {
        return;
    }

    if (!config.AUTO_DETECT_PUBLIC_IP) {
        return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
        const response = await fetch('https://api.ipify.org', { signal: controller.signal });
        const detected = (await response.text()).trim();
        if (detected) {
            config.PUBLIC_IP = detected;
        }
    } catch {
        console.warn('Could not auto-detect public IP (ipify request failed).');
    } finally {
        clearTimeout(timeout);
    }
}

async function maybeStartPublicTunnel() {
    const configuredShareBaseUrl = normalizeBaseUrl(config.SHARE_BASE_URL);
    const namedTunnelConfigured = !!config.CLOUDFLARED_TUNNEL_TOKEN;
    if (configuredShareBaseUrl && !namedTunnelConfigured) {
        publicShareStatus = 'manual';
        publicShareError = '';
        return;
    }

    if (!config.AUTO_PUBLIC_TUNNEL && !namedTunnelConfigured) {
        publicShareStatus = 'disabled';
        publicShareError = '';
        return;
    }

    if (config.PUBLIC_TUNNEL_PROVIDER !== 'cloudflared') {
        publicShareStatus = 'error';
        publicShareError = `Unsupported tunnel provider: ${config.PUBLIC_TUNNEL_PROVIDER}`;
        console.warn(`Unsupported PUBLIC_TUNNEL_PROVIDER: ${config.PUBLIC_TUNNEL_PROVIDER}. Skipping tunnel startup.`);
        emitServerConfigToAll(ioServer);
        return;
    }

    publicShareStatus = 'starting';
    publicShareError = '';
    emitServerConfigToAll(ioServer);

    try {
        const tunnel = await startCloudflareTunnel({
            port: config.PORT,
            localProtocol: getLocalProtocol(),
            explicitPath: config.CLOUDFLARED_PATH,
            timeoutMs: config.PUBLIC_TUNNEL_TIMEOUT_MS,
            noTlsVerify: config.PUBLIC_TUNNEL_NO_TLS_VERIFY,
            tunnelToken: config.CLOUDFLARED_TUNNEL_TOKEN,
            baseUrl: configuredShareBaseUrl,
        });

        runtimeShareBaseUrl = normalizeBaseUrl(tunnel.baseUrl);
        stopPublicTunnel = tunnel.stop;
        publicShareStatus = 'active';
        publicShareError = '';
        tunnelRestartAttempts = 0;
        console.log(`Public tunnel active: ${runtimeShareBaseUrl}`);
        emitServerConfigToAll(ioServer);

        tunnel.process.on('exit', () => {
            if (runtimeShareBaseUrl) {
                console.warn('Public tunnel closed. Public link is no longer available.');
            }
            runtimeShareBaseUrl = '';
            stopPublicTunnel = null;
            publicShareStatus = 'error';
            publicShareError = 'Built-in public tunnel closed.';
            emitServerConfigToAll(ioServer);
            if (serviceReady && (config.AUTO_PUBLIC_TUNNEL || config.CLOUDFLARED_TUNNEL_TOKEN) && !tunnelRestartTimer) {
                const delay = Math.min(60_000, 1_000 * (2 ** Math.min(tunnelRestartAttempts, 6)));
                tunnelRestartAttempts += 1;
                tunnelRestartTimer = setTimeout(() => {
                    tunnelRestartTimer = null;
                    void maybeStartPublicTunnel();
                }, delay);
            }
        });
    } catch (err) {
        publicShareStatus = 'error';
        publicShareError = err?.message || 'Built-in public tunnel failed to start.';
        console.warn(`Public tunnel unavailable: ${err.message}`);
        console.warn('Continuing in local/LAN mode. Set SHARE_BASE_URL manually or install cloudflared for auto internet links.');
        emitServerConfigToAll(ioServer);
    }
}

let worker = null;
let connectionCleanupInterval = null;

function cleanupGlobalResources() {
    serviceReady = false;
    if (tunnelRestartTimer) {
        clearTimeout(tunnelRestartTimer);
        tunnelRestartTimer = null;
    }
    stopRoomCleanup();
    stopJoinCleanup();
    if (connectionCleanupInterval) {
        clearInterval(connectionCleanupInterval);
        connectionCleanupInterval = null;
    }

    if (whipHttpServer) {
        try { whipHttpServer.close(); } catch { }
        whipHttpServer = null;
    }

    if (worker) {
        try { worker.close(); } catch { }
        worker = null;
    }

    if (stopPublicTunnel) {
        try { stopPublicTunnel(); } catch { }
        stopPublicTunnel = null;
    }

    ioServer = null;
    runtimeShareBaseUrl = '';
    publicShareStatus = config.CLOUDFLARED_TUNNEL_TOKEN
        ? 'starting'
        : (normalizeBaseUrl(config.SHARE_BASE_URL) ? 'manual' : (config.AUTO_PUBLIC_TUNNEL ? 'starting' : 'disabled'));
    publicShareError = '';
    runtimeWhipHttpPort = config.WHIP_HTTP_PORT;
    whipHttpStatus = config.WHIP_ENABLED ? 'starting' : 'disabled';
    whipHttpError = '';
}

async function handleAppServerError(err) {
    console.error(`${getLocalProtocol().toUpperCase()} server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
        const runningProtocol = await findRunningNextraProtocol();
        if (runningProtocol) {
            console.log(`Nextra is already running at ${getLoopbackBaseUrl(runningProtocol)}.`);
            openBrowser(getHostPageUrl(runningProtocol));
            cleanupGlobalResources();
            process.exit(0);
            return;
        }

        console.error(`Port ${config.PORT} is already in use on ${config.BIND_HOST}.`);
        cleanupGlobalResources();
        process.exit(1);
        return;
    }

    cleanupGlobalResources();
    process.exit(1);
}

function setWhipHttpRuntimeState(status, error = '') {
    whipHttpStatus = status;
    whipHttpError = error;
    if (ioServer) {
        emitServerConfigToAll(ioServer);
    }
}

function listenServer(server, port, host) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            server.removeListener('error', onError);
            server.removeListener('listening', onListening);
        };
        const onError = (err) => {
            cleanup();
            reject(err);
        };
        const onListening = () => {
            cleanup();
            resolve();
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

async function startWhipHttpServer(whipRouter) {
    if (!whipRouter) {
        setWhipHttpRuntimeState('disabled');
        return;
    }

    setWhipHttpRuntimeState('starting');

    const whipApp = express();
    whipApp.use((req, res, next) => {
        console.log(`[WHIP-HTTP] ${req.method} ${req.url} from ${req.ip}`);
        next();
    });
    whipApp.use('/whip', whipRouter);

    try {
        const resolvedPort = await findAvailablePort({
            preferredPort: config.WHIP_HTTP_PORT,
            host: config.WHIP_BIND_HOST,
            reservedPorts: [config.PORT],
            maxAttempts: 25,
        });

        const server = http.createServer(whipApp);
        await listenServer(server, resolvedPort, config.WHIP_BIND_HOST);
        whipHttpServer = server;
        runtimeWhipHttpPort = resolvedPort;
        if (resolvedPort !== config.WHIP_HTTP_PORT) {
            console.warn(`[Startup] WHIP HTTP port ${config.WHIP_HTTP_PORT} was unavailable; using ${resolvedPort}.`);
        }

        server.on('error', (err) => {
            const message = `WHIP HTTP server failed: ${err.message}`;
            console.warn(`${message} - OBS auto-start is disabled until this is fixed.`);
            setWhipHttpRuntimeState('error', message);
        });

        setWhipHttpRuntimeState('ready');
        console.log(`   WHIP:    ${getWhipHttpBaseUrl()}/whip/broadcast/<roomCode>`);
        console.log('');
    } catch (err) {
        const message = `WHIP HTTP server failed: ${err.message}`;
        console.warn(`${message} - OBS auto-start is disabled until this is fixed.`);
        runtimeWhipHttpPort = config.WHIP_HTTP_PORT;
        setWhipHttpRuntimeState('error', message);
        console.log('');
    }
}

(async () => {
    await exitIfAlreadyRunning();
    await detectPublicIpIfEnabled();

    console.log(`LAN IP: ${config.LAN_IP}`);
    if (config.PUBLIC_IP) {
        console.log(`Public IP: ${config.PUBLIC_IP}`);
    } else {
        console.log('Public IP: not set (use SHARE_BASE_URL or enable AUTO_DETECT_PUBLIC_IP)');
    }
    if (config.TRUST_X_FORWARDED_HEADERS) {
        console.log('Forwarded header trust: enabled for loopback proxy peers only.');
    }
    if (config.WHIP_ALLOW_INSECURE_REMOTE
        && config.WHIP_BIND_HOST.toLowerCase() !== 'localhost'
        && !isLoopbackIp(config.WHIP_BIND_HOST)) {
        console.warn('[Security] Plaintext WHIP is bound beyond loopback by explicit acknowledgement. Protect it with an encrypted VPN or TLS reverse proxy.');
    }

    let appServer = null;
    let isShuttingDown = false;
    if (config.LOCAL_HTTPS) {
        const { cert, key } = await getOrCreateCert();
        appServer = https.createServer({ cert, key }, app);
    } else {
        appServer = http.createServer(app);
    }

    const result = await createMediasoupWorker();
    worker = result.worker;
    console.log(`Mediasoup Worker PID: ${worker.pid}`);

    // Resolve and pin FFmpeg before any capability probe or relay process uses
    // it. This prevents later PATH changes from selecting a different binary.
    let ffmpegAvailable = false;
    if (config.WHIP_ENABLED) {
        try {
            const resolvedFfmpegPath = resolveExecutablePath(config.FFMPEG_PATH);
            if (!resolvedFfmpegPath) throw new Error(`could not resolve ${config.FFMPEG_PATH}`);
            const versionOutput = execFileSync(resolvedFfmpegPath, ['-version'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            const version = String(versionOutput).split(/\r?\n/, 1)[0].trim() || 'version unknown';
            config.FFMPEG_PATH = resolvedFfmpegPath;
            ffmpegAvailable = true;
            console.log(`[Startup] FFmpeg found — OBS fallback available (${version}; ${resolvedFfmpegPath})`);
        } catch (err) {
            console.warn(`[Startup] FFmpeg not found — OBS fallback will not work (${err.message})`);
        }
    }

    // Resolve the one-time encoder capability check in the background so the
    // first fallback viewer does not wait up to the probe timeout. NVENC is an
    // optimization, not a readiness dependency: libx264 remains the fallback.
    if (config.WHIP_ENABLED && ffmpegAvailable) {
        warmNvencProbe()
            .then((available) => {
                console.log(`[Startup] FFmpeg NVENC relay encoder: ${available ? 'available' : 'unavailable; libx264 will be used'}`);
            })
            .catch((err) => {
                console.warn(`[Startup] FFmpeg NVENC probe failed: ${err.message}`);
            });
    }

    // If the mediasoup worker subprocess dies, the media engine is gone and every
    // room is dead. Rather than leave clients stuck, restart the whole process so
    // viewers and OBS reconnect on their own (browser-capture hosts re-share).
    setWorkerDeathHandler(() => {
        const recoveryAction = decideWorkerDeathAction({
            isShuttingDown,
            uptimeSeconds: process.uptime(),
        });
        if (recoveryAction === 'ignore') return;

        if (recoveryAction === 'exit') {
            console.error('[recovery] Media engine crashed during startup - not auto-restarting to avoid a crash loop.');
            cleanupGlobalResources();
            process.exit(1);
            return;
        }

        console.error('[recovery] Media engine (mediasoup worker) crashed. Restarting Nextra automatically; viewers and OBS reconnect on their own.');

        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            try {
                const { spawn } = require('child_process');
                spawn(process.execPath, process.argv.slice(1), {
                    detached: true,
                    stdio: 'inherit',
                    cwd: process.cwd(),
                    env: process.env,
                }).unref();
            } catch (err) {
                console.error('[recovery] Failed to relaunch automatically:', err.message);
            }
            process.exit(0);
        };

        // Release listeners (frees the port) before the replacement process binds.
        cleanupGlobalResources();
        try {
            appServer.close(() => finish());
            setTimeout(finish, 2000).unref();
        } catch {
            finish();
        }
    });

    // Mount WHIP routes on the main app and a separate HTTP server.
    // OBS cannot connect to self-signed HTTPS reliably, so we expose WHIP over HTTP.
    // Media is still encrypted via DTLS/WebRTC.
    let whipRouter = null;
    if (config.WHIP_ENABLED) {
        whipRouter = createWhipRouter(result.router, { isAllowedOrigin: isAllowedSocketOrigin });
        app.use('/whip', whipRouter);
    }

    // Mount WHEP routes on the main browser-facing server.
    if (config.WHEP_ENABLED) {
        const whepRouter = createWhepRouter(result.router, { getClientIp: getRequestClientIp, isAllowedOrigin: isAllowedSocketOrigin });
        app.use('/whep', whepRouter);
        console.log('   WHEP:    /whep/watch/<roomCode>');
    }

    const io = new Server(appServer, {
        path: config.SOCKET_PATH,
        maxHttpBufferSize: config.SOCKET_MAX_HTTP_BUFFER_SIZE,
        pingInterval: config.SOCKET_PING_INTERVAL_MS,
        pingTimeout: config.SOCKET_PING_TIMEOUT_MS,
        allowRequest: (req, callback) => {
            const validation = validateSocketHandshakeRequest(req);
            if (!validation.ok) {
                console.warn(validation.reason);
                return callback(validation.reason, false);
            }

            return callback(null, true);
        },
        cors: {
            origin: (origin, cb) => {
                if (!origin) {
                    return cb(null, true);
                }

                if (isAllowedSocketOrigin(origin)) {
                    return cb(null, true);
                }

                cb(new Error('Origin not allowed'));
            },
            methods: ['GET', 'POST'],
        },
    });
    ioServer = io;
    setWhipIo(io);

    startRoomCleanup({
        onStaleRoom: (room) => destroyRoomWithReason(io, room.code, 'Room timed out', false),
    });

    io.engine.on('connection', (rawSocket) => {
        const ip = getSocketClientIp(rawSocket);
        const now = Date.now();
        const record = connectionTracker.get(ip) || { count: 0, resetAt: now + CONNECTION_WINDOW_MS };

        if (now > record.resetAt) {
            record.count = 0;
            record.resetAt = now + CONNECTION_WINDOW_MS;
        }

        record.count += 1;
        connectionTracker.set(ip, record);

        if (record.count > MAX_CONNECTIONS_PER_IP) {
            console.warn(`Rate limited socket connection from ${ip} (${record.count} in current window)`);
            rawSocket.close();
        }
    });

    io.on('connection', (socket) => {
        emitServerConfigToSocket(socket);
        socket.on('request-server-config', () => {
            emitServerConfigToSocket(socket);
        });
    });

    connectionCleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [ip, record] of connectionTracker) {
            if (now > record.resetAt) connectionTracker.delete(ip);
        }
    }, 300000);

    registerSocketHandlers(io, result.router, { getClientIp: getSocketHandshakeIp });
    startJoinCleanup();

    appServer.on('error', (err) => {
        void handleAppServerError(err);
    });

    appServer.listen(config.PORT, config.BIND_HOST, () => {
        serviceReady = true;
        console.log(`\nNextra running (${getLocalProtocol().toUpperCase()}):`);
        console.log(`   Bind:    ${config.BIND_HOST}:${config.PORT}`);
        console.log(`   Mode:    ${isDevMode ? 'development (Vite dev origins enabled)' : 'production'}`);
        console.log(`   Media:   RTC listen ${config.RTC_LISTEN_IP}${config.RTC_LISTEN_IP === '127.0.0.1' ? ' (local only)' : `, announce ${config.PUBLIC_IP || config.LAN_IP}`}`);
        console.log(`   Local:   ${getLocalProtocol()}://127.0.0.1:${config.PORT}`);
        console.log(`   Access:  ${getLocalBaseUrl()}`);
        const manualShareBase = normalizeBaseUrl(config.SHARE_BASE_URL);
        if (config.CLOUDFLARED_TUNNEL_TOKEN) {
            console.log(`   Public:  starting named cloudflared tunnel for ${manualShareBase}...`);
        } else if (manualShareBase) {
            console.log(`   Public:  ${manualShareBase}`);
        } else if (config.PUBLIC_IP && config.PUBLIC_IP !== config.LAN_IP) {
            console.log(`   Public:  ${getLocalProtocol()}://${config.PUBLIC_IP}:${config.PORT}`);
        } else if (config.AUTO_PUBLIC_TUNNEL) {
            console.log('   Public:  starting automatic cloudflared tunnel...');
        } else {
            console.log('   Public:  configured via SHARE_BASE_URL only');
        }
        console.log(`   UDP:     ${config.RTC_MIN_PORT}-${config.RTC_MAX_PORT}`);

        // Start HTTP server for WHIP (OBS rejects self-signed HTTPS certs).
        void startWhipHttpServer(whipRouter);

        void maybeStartPublicTunnel();
        openBrowser(getHostPageUrl());
    });

    async function shutdown(signal) {
        if (isShuttingDown) return;
        isShuttingDown = true;
        serviceReady = false;
        console.log(`\n${signal} received. Shutting down gracefully...`);
        if (ioServer) {
            ioServer.emit('server-restarting', { reconnectAfterMs: 1500 });
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        cleanupGlobalResources();

        appServer.close(() => {
            console.log('Server closed.');
            process.exit(0);
        });

        // Force exit if open connections (e.g. the prewarmed relay or socket.io
        // clients) keep the server from closing. This is an intentional shutdown,
        // so exit 0 — a non-zero code is misreported as a startup failure.
        setTimeout(() => process.exit(0), 5000);
    }

    requestGracefulShutdown = shutdown;

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    // Windows console-close (SIGHUP) and Ctrl+Break (SIGBREAK) take the same
    // shutdown path so the worker dying during teardown is flagged as an
    // intentional stop and never triggers the auto-restart.
    process.on('SIGHUP', () => shutdown('SIGHUP'));
    process.on('SIGBREAK', () => shutdown('SIGBREAK'));
})().catch((err) => {
    console.error(`Fatal startup error: ${err?.stack || err?.message || err}`);
    cleanupGlobalResources();
    process.exit(1);
});

