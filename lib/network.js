const net = require('net');

function normalizeIp(ip) {
    if (!ip || typeof ip !== 'string') return 'unknown';
    if (ip.startsWith('::ffff:')) return ip.slice(7);
    return ip;
}

function parseForwardedFirst(value) {
    if (!value || typeof value !== 'string') return '';
    return value.split(',')[0].trim();
}

function splitForwardedEntries(value) {
    if (!value || typeof value !== 'string') return [];
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * The last entry of a comma-separated forwarded header: the address the nearest proxy appended. The entries to its
 * left were written by the client or by hops further out, so this is the only one a single trusted proxy vouches for.
 */
function parseForwardedLast(value) {
    const entries = splitForwardedEntries(value);
    return entries.length > 0 ? entries[entries.length - 1] : '';
}

/**
 * The number of proxy hops between the client and this server that may be trusted, from the TRUST_PROXY setting:
 * a whole number of at least 1 is used as it is; true, false, 0 and address or subnet lists count as one hop.
 */
function resolveTrustedHopCount(trustProxy) {
    return Number.isInteger(trustProxy) && trustProxy >= 1 ? trustProxy : 1;
}

/**
 * The client address in an X-Forwarded-For value when `trustedHopCount` proxies sit in front of this server (as in
 * Express's numeric `trust proxy`, counting the connecting peer): 1 is the rightmost entry, 2 the one before it.
 * Returns '' when the chain is shorter than the trusted hops, because then nothing vouches for a client.
 */
function parseForwardedClient(value, trustedHopCount = 1) {
    const entries = splitForwardedEntries(value);
    const index = entries.length - resolveTrustedHopCount(trustedHopCount);
    return index >= 0 ? entries[index] : '';
}

function hasHeaderValue(value) {
    if (Array.isArray(value)) return true;
    return typeof value === 'string' && value.trim() !== '';
}

/**
 * True when the request shows it was relayed by a proxy or CDN: any of the headers they add is present. Used to tell
 * a proxied request whose client cannot be named (the result must fail closed) from a direct local one.
 */
function hasForwardingEvidence(headers = {}) {
    const source = headers && typeof headers === 'object' ? headers : {};
    if (['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'cf-ray'].some((name) => hasHeaderValue(source[name]))) {
        return true;
    }
    const cdnLoop = Array.isArray(source['cdn-loop']) ? source['cdn-loop'].join(',') : source['cdn-loop'];
    return typeof cdnLoop === 'string' && cdnLoop.toLowerCase().includes('cloudflare');
}

function toValidIp(value) {
    const normalized = normalizeIp(value);
    return net.isIP(normalized) !== 0 ? normalized : '';
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

/**
 * The client address a loopback proxy vouches for, or a marker that none can be named.
 *
 * - '' when forwarded headers are not trusted, the peer is not loopback, or the request carries no forwarding header:
 *   the caller keeps using the connection's own address (a browser on this machine).
 * - An address when X-Forwarded-For has a usable entry at the trusted position, counted from the right.
 *   `options.trustedHopCount` is the number of proxies in front of this server (see parseForwardedClient).
 * - 'unknown' when the request was relayed but no usable address is vouched for. It classifies as remote.
 *
 * Callers must treat every non-empty result as the client identity, 'unknown' included, and must not replace it
 * with the TCP peer: for a relayed request that peer is the proxy's own loopback address.
 *
 * CF-Connecting-IP is a header the client can send and any local reverse proxy passes on unchanged, so it is read
 * only when `options.trustCloudflareClientIp === true`: the caller knows Cloudflare's tunnel relayed the request
 * (Nextra's own cloudflared tunnel, or an explicit operator setting). It must be a single valid address.
 */
function getTrustedForwardedClientIp(headers = {}, remoteAddress = '', trustForwardedHeaders = false, options = {}) {
    if (!shouldTrustForwardedHeaders(remoteAddress, trustForwardedHeaders)) {
        return '';
    }

    const source = headers && typeof headers === 'object' ? headers : {};
    const { trustedHopCount = 1, trustCloudflareClientIp = false } = options || {};

    if (trustCloudflareClientIp === true) {
        const cloudflareIp = typeof source['cf-connecting-ip'] === 'string' ? toValidIp(source['cf-connecting-ip'].trim()) : '';
        if (cloudflareIp) return cloudflareIp;
    }

    const forwardedIp = toValidIp(parseForwardedClient(source['x-forwarded-for'], trustedHopCount));
    if (forwardedIp) return forwardedIp;

    return hasForwardingEvidence(source) ? 'unknown' : '';
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
        // A network needs a valid IPv4 address and a decimal prefix of 1 to 32. An empty, zero or malformed prefix
        // (Number('') is 0) would otherwise become a mask that matches every address.
        const [network, prefixText, ...extra] = entry.split('/');
        if (extra.length > 0 || !/^\d{1,2}$/.test(prefixText)) return false;
        const addressValue = ipv4ToInteger(normalized);
        const networkValue = ipv4ToInteger(network);
        const prefix = Number(prefixText);
        if (addressValue == null || networkValue == null || prefix < 1 || prefix > 32) {
            return false;
        }
        const mask = (0xffffffff << (32 - prefix)) >>> 0;
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
    parseForwardedLast,
    parseForwardedClient,
    resolveTrustedHopCount,
    hasForwardingEvidence,
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
