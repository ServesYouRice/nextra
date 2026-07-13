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

module.exports = {
    normalizeIp,
    parseForwardedFirst,
    isLocalClientIp,
    isLoopbackIp,
    isLocalHostname,
    shouldTrustForwardedHeaders,
    getTrustedForwardedClientIp,
};
