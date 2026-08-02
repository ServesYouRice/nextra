function normalizeIp(ip) {
    if (!ip || typeof ip !== 'string') return 'unknown';
    if (ip.startsWith('::ffff:')) return ip.slice(7);
    return ip;
}

function parseForwardedFirst(value) {
    if (!value || typeof value !== 'string') return '';
    return value.split(',')[0].trim();
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

function isLoopbackIp(ip) {
    const normalized = normalizeIp(ip).toLowerCase();
    return normalized === '::1'
        || normalized === '[::1]'
        || /^127\.\d+\.\d+\.\d+$/.test(normalized);
}

function isLocalHostname(hostname, lanIp = '') {
    const name = normalizeIp(hostname).toLowerCase();
    const normalizedLanIp = normalizeIp(lanIp).toLowerCase();
    if (!name || name === 'unknown') return true;
    if (name === 'localhost' || name === '::1' || name === '[::1]') return true;
    if (normalizedLanIp && name === normalizedLanIp) return true;
    return isLocalClientIp(name);
}

function shouldTrustForwardedHeaders(remoteAddress, trustForwardedHeaders = false) {
    if (!trustForwardedHeaders) return false;
    return isLoopbackIp(remoteAddress);
}

function getTrustedForwardedClientIp(headers = {}, remoteAddress = '', trustForwardedHeaders = false) {
    if (!shouldTrustForwardedHeaders(remoteAddress, trustForwardedHeaders)) {
        return '';
    }

    const cfConnectingIp = parseForwardedFirst(headers['cf-connecting-ip']);
    if (cfConnectingIp) return normalizeIp(cfConnectingIp);

    const forwardedFor = parseForwardedFirst(headers['x-forwarded-for']);
    if (forwardedFor) return normalizeIp(forwardedFor);

    return '';
}

function ipv4ToInteger(ip) {
    const octets = normalizeIp(ip).split('.');
    if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
        return null;
    }
    return octets.reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function isIpInTrustedLan(ip, trustedLanCidrs = '') {
    const normalized = normalizeIp(ip).toLowerCase();
    const entries = String(trustedLanCidrs || '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
    return entries.some((entry) => {
        if (!entry.includes('/')) return normalizeIp(entry).toLowerCase() === normalized;
        const [network, prefixText] = entry.split('/');
        const addressValue = ipv4ToInteger(normalized);
        const networkValue = ipv4ToInteger(network);
        const prefix = Number(prefixText);
        if (addressValue == null || networkValue == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
            return false;
        }
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        return (addressValue & mask) === (networkValue & mask);
    });
}

function classifyClient({ ip = '', trustedLanCidrs = '', viaKnownProxy = false } = {}) {
    const normalizedIp = normalizeIp(ip || 'unknown');
    if (viaKnownProxy) return { kind: 'known-proxy', ip: normalizedIp };
    if (isLoopbackIp(normalizedIp)) return { kind: 'loopback', ip: normalizedIp };
    if (isIpInTrustedLan(normalizedIp, trustedLanCidrs)) return { kind: 'trusted-lan', ip: normalizedIp };
    return { kind: 'remote', ip: normalizedIp };
}

function timingSafeTokenEqual(provided, expected) {
    const left = Buffer.from(typeof provided === 'string' ? provided : '', 'utf8');
    const right = Buffer.from(typeof expected === 'string' ? expected : '', 'utf8');
    if (left.length === 0 || right.length === 0 || left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

module.exports = {
    normalizeIp,
    parseForwardedFirst,
    isLocalClientIp,
    isLoopbackIp,
    isLocalHostname,
    shouldTrustForwardedHeaders,
    getTrustedForwardedClientIp,
    isIpInTrustedLan,
    classifyClient,
    timingSafeTokenEqual,
};
const crypto = require('crypto');
