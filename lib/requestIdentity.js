const {
    getTrustedForwardedClientIp,
    isLoopbackIp,
    normalizeIp,
    parseForwardedFirst,
    shouldTrustForwardedHeaders,
} = require('./network');

function parseUrlHostParts(hostValue) {
    if (!hostValue || typeof hostValue !== 'string') return null;
    const trimmed = hostValue.trim();
    if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes(' ')) return null;

    try {
        const parsed = new URL(`https://${trimmed}`);
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

/**
 * Headers Cloudflare adds to every request it relays, the built-in quick tunnel included. A client cannot remove
 * them from a request that passes through Cloudflare, so a loopback peer that carries one is a relay, not the host.
 */
function hasCloudflareProxyEvidence(headers = {}) {
    if (parseForwardedFirst(headers['cf-connecting-ip'])) return true;
    if (typeof headers['cf-ray'] === 'string' && headers['cf-ray'].trim()) return true;
    const cdnLoop = headers['cdn-loop'];
    return typeof cdnLoop === 'string' && cdnLoop.toLowerCase().includes('cloudflare');
}

/**
 * Who a request or socket comes from, for operator checks and rate limits. `getKnownPublicShareOrigins` returns the
 * public share and tunnel origins in use now; `getTrustForwardedHeaders` the TRUST_X_FORWARDED_HEADERS setting.
 *
 * Every request the tunnel or a same-host proxy relays arrives from loopback, so loopback alone never proves the
 * host. Missing proxy evidence used to mean full local trust: a request through the public link without Origin or
 * Referer was classified as the local operator.
 */
function createRequestIdentity({ getKnownPublicShareOrigins, getTrustForwardedHeaders }) {
    function knownShareOrigins() {
        return getKnownPublicShareOrigins().map((origin) => normalizeOrigin(origin)).filter(Boolean);
    }

    function isKnownPublicShareOrigin(origin) {
        const normalized = normalizeOrigin(origin);
        return !!normalized && knownShareOrigins().includes(normalized);
    }

    /** The share hosts, compared without a scheme: a plain-HTTP listener behind the tunnel sees https traffic. */
    function isKnownPublicShareHost(headers) {
        const shareHosts = knownShareOrigins().map((origin) => new URL(origin).host.toLowerCase());
        return [headers.host, parseForwardedFirst(headers['x-forwarded-host'])]
            .map((value) => parseUrlHostParts(value))
            .some((parts) => parts && shareHosts.includes(parts.hostWithPort.toLowerCase()));
    }

    function isKnownPublicShareRequest(headers = {}) {
        if (isKnownPublicShareHost(headers)) return true;
        return [normalizeOrigin(headers.origin), normalizeOrigin(headers.referer || headers.referrer)]
            .some((origin) => isKnownPublicShareOrigin(origin));
    }

    /** A request relayed to this listener by the tunnel or another proxy on this machine, never the host itself. */
    function isRelayedFromLoopback(headers = {}, remoteAddress = '') {
        return isLoopbackIp(normalizeIp(remoteAddress || 'unknown'))
            && (hasCloudflareProxyEvidence(headers) || isKnownPublicShareRequest(headers));
    }

    function shouldTrustRequestForwardedHeaders(headers = {}, remoteAddress = '') {
        if (shouldTrustForwardedHeaders(remoteAddress, getTrustForwardedHeaders())) return true;
        return isLoopbackIp(normalizeIp(remoteAddress || 'unknown')) && isKnownPublicShareRequest(headers);
    }

    function getClientIpFromHeaders(headers = {}, remoteAddress = '') {
        const normalizedRemote = normalizeIp(remoteAddress || 'unknown');
        const trustForwarded = shouldTrustRequestForwardedHeaders(headers, normalizedRemote);
        const forwardedIp = getTrustedForwardedClientIp(headers, normalizedRemote, trustForwarded);
        if (forwardedIp) return forwardedIp;
        // Only a relay on this machine can vouch for cf-connecting-ip; a direct client could choose its own identity.
        if (!isRelayedFromLoopback(headers, normalizedRemote)) return normalizedRemote;
        // The tunnel sets cf-connecting-ip to the viewer's address. The 'public-share:' prefix gives each viewer its
        // own rate-limit bucket and never matches isLocalClientIp, so it is never local.
        const tunnelViewerIp = parseForwardedFirst(headers['cf-connecting-ip']);
        return tunnelViewerIp ? `public-share:${normalizeIp(tunnelViewerIp)}` : 'public-share-proxy';
    }

    return {
        isKnownPublicShareOrigin,
        isKnownPublicShareRequest,
        isRelayedFromLoopback,
        shouldTrustRequestForwardedHeaders,
        getClientIpFromHeaders,
    };
}

module.exports = {
    createRequestIdentity,
    hasCloudflareProxyEvidence,
    normalizeOrigin,
    parseUrlHostParts,
};
