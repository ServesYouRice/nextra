// server.js - Entry point: Express + Socket.io + Mediasoup (HTTPS)
const express = require('express');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Server } = require('socket.io');
const helmet = require('helmet');
const config = require('./config');
const { createMediasoupWorker } = require('./lib/mediasoup');
const {
    registerSocketHandlers,
    startJoinCleanup,
    stopJoinCleanup,
    getSocketRuntimeMetrics,
} = require('./lib/socket');
const { startRoomCleanup, stopRoomCleanup, getAllRoomStats } = require('./lib/rooms');
const { getOrCreateCert } = require('./lib/https');
const { startCloudflareQuickTunnel } = require('./lib/tunnel');

const app = express();
let runtimeShareBaseUrl = '';
let stopPublicTunnel = null;
let ioServer = null;
let publicShareStatus = normalizeBaseUrl(config.SHARE_BASE_URL) ? 'manual' : (config.AUTO_PUBLIC_TUNNEL ? 'starting' : 'disabled');
let publicShareError = '';

if (config.TRUST_PROXY !== false) {
    app.set('trust proxy', config.TRUST_PROXY);
}

app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
});

app.use((req, res, next) => {
    helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", `'nonce-${res.locals.cspNonce}'`],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
                fontSrc: ["'self'", 'https://fonts.gstatic.com'],
                connectSrc: ["'self'", 'ws:', 'wss:'],
                imgSrc: ["'self'", 'data:', 'blob:'],
                mediaSrc: ["'self'", 'blob:'],
                workerSrc: ["'self'", 'blob:'],
            },
        },
        crossOriginEmbedderPolicy: false,
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
        hsts: { maxAge: 31536000, includeSubDomains: false },
    })(req, res, next);
});

function normalizeIp(ip) {
    if (!ip || typeof ip !== 'string') return 'unknown';
    if (ip.startsWith('::ffff:')) return ip.slice(7);
    return ip;
}

function parseForwardedFirst(value) {
    if (!value || typeof value !== 'string') return '';
    return value.split(',')[0].trim();
}

function isLocalHostname(hostname) {
    const name = (hostname || '').toLowerCase();
    if (!name) return true;
    if (name === 'localhost' || name === '::1' || name === '[::1]') return true;
    if (name === config.LAN_IP || name === '127.0.0.1') return true;
    if (/^127\.\d+\.\d+\.\d+$/.test(name)) return true;
    if (/^10\.\d+\.\d+\.\d+$/.test(name)) return true;
    if (/^192\.168\.\d+\.\d+$/.test(name)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(name)) return true;
    return false;
}

function isLocalClientIp(ip) {
    const normalized = normalizeIp(ip).toLowerCase();
    if (!normalized || normalized === 'unknown') return false;
    if (normalized === '::1' || normalized === '[::1]') return true;
    if (/^127\.\d+\.\d+\.\d+$/.test(normalized)) return true;
    if (/^10\.\d+\.\d+\.\d+$/.test(normalized)) return true;
    if (/^192\.168\.\d+\.\d+$/.test(normalized)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(normalized)) return true;
    if (/^(fc|fd)[0-9a-f:]+$/.test(normalized)) return true;
    if (/^fe80:[0-9a-f:]+$/.test(normalized)) return true;
    return false;
}

function getRemoteAddressFromReq(req) {
    return normalizeIp(
        req?.socket?.remoteAddress
        || req?.connection?.remoteAddress
        || 'unknown'
    );
}

function shouldTrustForwardedHeaders(remoteAddress) {
    if (!config.TRUST_X_FORWARDED_HEADERS) return false;
    return isLocalClientIp(normalizeIp(remoteAddress));
}

function getRequestClientIp(req) {
    if (shouldTrustForwardedHeaders(getRemoteAddressFromReq(req))) {
        const forwardedFor = parseForwardedFirst(req.headers['x-forwarded-for']);
        if (forwardedFor) return normalizeIp(forwardedFor);
    }

    return normalizeIp(
        req.socket?.remoteAddress
        || req.connection?.remoteAddress
        || 'unknown'
    );
}

function shouldExposeLanUrl(req) {
    if (config.EXPOSE_LAN_URL) return true;
    return isLocalClientIp(getRequestClientIp(req));
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

function isAllowedSocketOrigin(origin) {
    const normalized = normalizeOrigin(origin);
    if (!normalized) return false;

    const allowed = getAllowedOrigins();
    if (allowed.has(normalized)) return true;

    return config.ALLOW_TRYCLOUDFLARE_ORIGINS
        && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(normalized);
}

function getSocketRequestHostOrigin(req) {
    const remoteAddress = getRemoteAddressFromReq(req);
    let proto = req?.socket?.encrypted ? 'https' : 'http';

    if (shouldTrustForwardedHeaders(remoteAddress)) {
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
    const origins = new Set([
        `https://localhost:${config.PORT}`,
        `https://127.0.0.1:${config.PORT}`,
    ]);

    if (config.LAN_IP) {
        origins.add(`https://${config.LAN_IP}:${config.PORT}`);
    }

    if (config.PUBLIC_IP && config.PUBLIC_IP !== config.LAN_IP) {
        origins.add(`https://${config.PUBLIC_IP}:${config.PORT}`);
    }

    if (process.env.NODE_ENV !== 'production') {
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

    if (shouldTrustForwardedHeaders(getRemoteAddressFromReq(req))) {
        const forwardedProto = parseForwardedFirst(req.headers['x-forwarded-proto']);
        const forwardedHost = parseForwardedFirst(req.headers['x-forwarded-host']);
        const proto = (forwardedProto || '').toLowerCase();
        const hostParts = parseUrlHostParts(forwardedHost);
        if ((proto === 'http' || proto === 'https') && hostParts && !isLocalHostname(hostParts.hostname)) {
            return `${proto}://${hostParts.hostWithPort}`;
        }
    }

    const reqProto = req.protocol === 'https' ? 'https' : 'http';
    const hostHeader = req.get('host') || '';
    const hostParts = parseUrlHostParts(hostHeader);
    if (hostParts && !isLocalHostname(hostParts.hostname)) {
        return `${reqProto}://${hostParts.hostWithPort}`;
    }

    if (config.PUBLIC_IP && config.PUBLIC_IP !== config.LAN_IP) {
        return `https://${config.PUBLIC_IP}:${config.PORT}`;
    }

    return '';
}

function getLocalBaseUrl() {
    const bindHost = (config.BIND_HOST || '').toLowerCase();
    if (bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1' || bindHost === '[::1]') {
        return `https://localhost:${config.PORT}`;
    }
    if (bindHost && bindHost !== '0.0.0.0' && bindHost !== '::') {
        return `https://${config.BIND_HOST}:${config.PORT}`;
    }
    return `https://${config.LAN_IP}:${config.PORT}`;
}

function getShareBaseUrlFromHeaders(headers = {}, remoteAddress = '') {
    if (shouldTrustForwardedHeaders(remoteAddress)) {
        const forwardedProto = parseForwardedFirst(headers['x-forwarded-proto']);
        const forwardedHost = parseForwardedFirst(headers['x-forwarded-host']);
        const proto = (forwardedProto || '').toLowerCase();
        const hostParts = parseUrlHostParts(forwardedHost);
        if ((proto === 'http' || proto === 'https') && hostParts && !isLocalHostname(hostParts.hostname)) {
            return `${proto}://${hostParts.hostWithPort}`;
        }
    }

    const hostHeader = typeof headers.host === 'string' ? headers.host : '';
    const hostParts = parseUrlHostParts(hostHeader);
    if (hostParts && !isLocalHostname(hostParts.hostname)) {
        return `https://${hostParts.hostWithPort}`;
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
        return `https://${config.PUBLIC_IP}:${config.PORT}`;
    }

    return '';
}

function getSocketHandshakeIp(socket) {
    if (shouldTrustForwardedHeaders(
        socket?.request?.socket?.remoteAddress || socket?.conn?.remoteAddress || socket?.handshake?.address || ''
    )) {
        const forwardedFor = parseForwardedFirst(socket?.handshake?.headers?.['x-forwarded-for']);
        if (forwardedFor) return normalizeIp(forwardedFor);
    }

    return normalizeIp(
        socket?.handshake?.address
        || socket?.request?.socket?.remoteAddress
        || socket?.conn?.remoteAddress
        || 'unknown'
    );
}

function shouldExposeLanForSocket(socket) {
    if (config.EXPOSE_LAN_URL) return true;
    return isLocalClientIp(getSocketHandshakeIp(socket));
}

function buildSocketConfigPayload(socket) {
    return {
        hostUploadMbps: config.HOST_UPLOAD_MBPS,
        shareBaseUrl: getShareBaseUrlForSocket(socket),
        lanUrl: shouldExposeLanForSocket(socket) ? getLocalBaseUrl() : '',
        relayFlushIntervalMs: config.RELAY_FLUSH_INTERVAL_MS,
        relayVideoBitsPerSecond: config.RELAY_VIDEO_BITS_PER_SECOND,
        publicShareStatus,
        publicShareError,
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

    if (typeof req.query?.token === 'string') {
        return req.query.token.trim();
    }

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

app.get('/api/config', (req, res) => {
    res.json({
        hostUploadMbps: config.HOST_UPLOAD_MBPS,
        shareBaseUrl: getShareBaseUrl(req),
        lanUrl: shouldExposeLanUrl(req) ? getLocalBaseUrl() : '',
        relayFlushIntervalMs: config.RELAY_FLUSH_INTERVAL_MS,
        relayVideoBitsPerSecond: config.RELAY_VIDEO_BITS_PER_SECOND,
        publicShareStatus,
        publicShareError,
    });
});

app.get('/api/metrics', (req, res) => {
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
    const totalConsumers = rooms.reduce((sum, room) => sum + room.mediasoupConsumerCount, 0);

    res.json({
        generatedAt: new Date().toISOString(),
        runtimeShareBaseUrl,
        rooms: {
            active: rooms.length,
            totalViewers,
            totalRelayViewers,
            totalMediasoupConsumers: totalConsumers,
            list: roomList,
            sensitiveFieldsIncluded: includeSensitiveRoomFields,
        },
        sockets: getSocketRuntimeMetrics(),
    });
});

const indexHtmlPath = path.join(__dirname, 'dist', 'index.html');
let indexHtmlTemplate = null;

function getIndexHtml(nonce) {
    if (!indexHtmlTemplate) {
        try {
            indexHtmlTemplate = fs.readFileSync(indexHtmlPath, 'utf-8');
        } catch {
            return null;
        }
    }
    return indexHtmlTemplate.replace(/<script/g, `<script nonce="${nonce}"`);
}

app.use(express.static(path.join(__dirname, 'dist')));
app.get('/{*splat}', (req, res) => {
    const html = getIndexHtml(res.locals.cspNonce);
    if (html) {
        res.type('html').send(html);
    } else {
        res.sendFile(indexHtmlPath);
    }
});

const connectionTracker = new Map(); // IP -> { count, resetAt }
const MAX_CONNECTIONS_PER_IP = config.MAX_CONNECTIONS_PER_IP;
const CONNECTION_WINDOW_MS = config.CONNECTION_WINDOW_MS;

function getSocketClientIp(rawSocket) {
    const req = rawSocket.request;
    if (shouldTrustForwardedHeaders(req?.socket?.remoteAddress || req?.connection?.remoteAddress || '')) {
        const forwardedFor = parseForwardedFirst(req?.headers?.['x-forwarded-for']);
        if (forwardedFor) return normalizeIp(forwardedFor);
    }

    return normalizeIp(
        req?.socket?.remoteAddress
        || req?.connection?.remoteAddress
        || req?.connection?.socket?.remoteAddress
        || 'unknown'
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
    if (normalizeBaseUrl(config.SHARE_BASE_URL)) {
        publicShareStatus = 'manual';
        publicShareError = '';
        return;
    }

    if (!config.AUTO_PUBLIC_TUNNEL) {
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
        const tunnel = await startCloudflareQuickTunnel({
            port: config.PORT,
            explicitPath: config.CLOUDFLARED_PATH,
            timeoutMs: config.PUBLIC_TUNNEL_TIMEOUT_MS,
            noTlsVerify: config.PUBLIC_TUNNEL_NO_TLS_VERIFY,
        });

        runtimeShareBaseUrl = normalizeBaseUrl(tunnel.baseUrl);
        stopPublicTunnel = tunnel.stop;
        publicShareStatus = 'active';
        publicShareError = '';
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
    stopRoomCleanup();
    stopJoinCleanup();
    if (connectionCleanupInterval) {
        clearInterval(connectionCleanupInterval);
        connectionCleanupInterval = null;
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
    publicShareStatus = normalizeBaseUrl(config.SHARE_BASE_URL) ? 'manual' : (config.AUTO_PUBLIC_TUNNEL ? 'starting' : 'disabled');
    publicShareError = '';
}

(async () => {
    await detectPublicIpIfEnabled();

    console.log(`LAN IP: ${config.LAN_IP}`);
    if (config.PUBLIC_IP) {
        console.log(`Public IP: ${config.PUBLIC_IP}`);
    } else {
        console.log('Public IP: not set (use SHARE_BASE_URL or enable AUTO_DETECT_PUBLIC_IP)');
    }
    if (config.TRUST_X_FORWARDED_HEADERS) {
        console.log('Forwarded header trust: enabled for local/private proxy peers only.');
    }

    const { cert, key } = await getOrCreateCert();
    const httpsServer = https.createServer({ cert, key }, app);

    const result = await createMediasoupWorker();
    worker = result.worker;
    console.log(`Mediasoup Worker PID: ${worker.pid}`);

    startRoomCleanup();

    const io = new Server(httpsServer, {
        path: config.SOCKET_PATH,
        maxHttpBufferSize: config.SOCKET_MAX_HTTP_BUFFER_SIZE,
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

    registerSocketHandlers(io, result.router);
    startJoinCleanup();

    httpsServer.on('error', (err) => {
        console.error(`HTTPS server error: ${err.message}`);
        if (err.code === 'EADDRINUSE') {
            console.error(`Port ${config.PORT} is already in use on ${config.BIND_HOST}.`);
        }
        cleanupGlobalResources();
        process.exit(1);
    });

    httpsServer.listen(config.PORT, config.BIND_HOST, () => {
        console.log('\nNextra running (HTTPS):');
        console.log(`   Bind:    ${config.BIND_HOST}:${config.PORT}`);
        console.log(`   Local:   https://localhost:${config.PORT}`);
        console.log(`   Access:  ${getLocalBaseUrl()}`);
        const manualShareBase = normalizeBaseUrl(config.SHARE_BASE_URL);
        if (manualShareBase) {
            console.log(`   Public:  ${manualShareBase}`);
        } else if (config.PUBLIC_IP && config.PUBLIC_IP !== config.LAN_IP) {
            console.log(`   Public:  https://${config.PUBLIC_IP}:${config.PORT}`);
        } else if (config.AUTO_PUBLIC_TUNNEL) {
            console.log('   Public:  starting automatic cloudflared tunnel...');
        } else {
            console.log('   Public:  configured via SHARE_BASE_URL only');
        }
        console.log(`   UDP:     ${config.RTC_MIN_PORT}-${config.RTC_MAX_PORT}\n`);

        void maybeStartPublicTunnel();
    });

    async function shutdown(signal) {
        console.log(`\n${signal} received. Shutting down gracefully...`);
        cleanupGlobalResources();

        httpsServer.close(() => {
            console.log('Server closed.');
            process.exit(0);
        });

        setTimeout(() => process.exit(1), 5000);
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
})().catch((err) => {
    console.error(`Fatal startup error: ${err?.stack || err?.message || err}`);
    cleanupGlobalResources();
    process.exit(1);
});

