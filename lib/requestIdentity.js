const {
    getCloudflareClientIp,
    getTrustedForwardedClientIp,
    isLoopbackIp,
    normalizeIp,
    parseForwardedFirst,
    resolveTrustedHopCount,
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
 * public share and tunnel origins in use now; `getTrustForwardedHeaders` the TRUST_X_FORWARDED_HEADERS setting;
 * the optional `getTrustProxy` the TRUST_PROXY setting, whose hop count says how many proxies to skip from the right
 * of X-Forwarded-For (one when it is left out).
 *
 * CF-Connecting-IP names the client only in a Cloudflare mode: `getManagedTunnelOrigin` returns the URL of the
 * cloudflared tunnel Nextra itself launched while it runs ('' otherwise), and `getTrustCloudflareClientIp` the
 * TRUST_CLOUDFLARE_CONNECTING_IP setting. A SHARE_BASE_URL alone is no such mode: it may front any proxy.
 *
 * Every request the tunnel or a same-host proxy relays arrives from loopback, so loopback alone never proves the
 * host. Missing proxy evidence used to mean full local trust: a request through the public link without Origin or
 * Referer was classified as the local operator.
 */
function createRequestIdentity({
    getKnownPublicShareOrigins,
    getTrustForwardedHeaders,
    getTrustProxy = () => false,
    getManagedTunnelOrigin = () => '',
    getTrustCloudflareClientIp = () => false,
}) {
    function knownShareOrigins() {
        return getKnownPublicShareOrigins().map((origin) => normalizeOrigin(origin)).filter(Boolean);
    }

    function isKnownPublicShareOrigin(origin) {
        const normalized = normalizeOrigin(origin);
        return !!normalized && knownShareOrigins().includes(normalized);
    }

    /** The share hosts, compared without a scheme: a plain-HTTP listener behind the tunnel sees https traffic. */
    function isAddressedToHostOf(headers, origins) {
        const shareHosts = origins.map((origin) => new URL(origin).host.toLowerCase());
        return [headers.host, parseForwardedFirst(headers['x-forwarded-host'])]
            .map((value) => parseUrlHostParts(value))
            .some((parts) => parts && shareHosts.includes(parts.hostWithPort.toLowerCase()));
    }

    /** Whether the request names one of these origins in its Host, X-Forwarded-Host, Origin or Referer. */
    function isAddressedTo(headers, origins) {
        if (origins.length === 0) return false;
        if (isAddressedToHostOf(headers, origins)) return true;
        return [normalizeOrigin(headers.origin), normalizeOrigin(headers.referer || headers.referrer)]
            .some((origin) => !!origin && origins.includes(origin));
    }

    function isKnownPublicShareRequest(headers = {}) {
        return isAddressedTo(headers, knownShareOrigins());
    }

    /**
     * Whether Cloudflare relayed this request, so that its CF-Connecting-IP is Cloudflare's record of the viewer: a
     * loopback request under TRUST_CLOUDFLARE_CONNECTING_IP, or one addressed to the tunnel Nextra launched and runs.
     */
    function isCloudflareClientIpTrusted(headers, normalizedRemote) {
        if (!isLoopbackIp(normalizedRemote)) return false;
        if (getTrustCloudflareClientIp() === true) return true;
        const tunnelOrigin = normalizeOrigin(getManagedTunnelOrigin());
        return !!tunnelOrigin && isAddressedTo(headers, [tunnelOrigin]);
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
        // CF-Connecting-IP is read only in a Cloudflare mode: a request addressed to the tunnel Nextra launched, whose
        // cloudflared relays Cloudflare's value, or TRUST_CLOUDFLARE_CONNECTING_IP. Any other same-host proxy (one
        // behind SHARE_BASE_URL included) can relay a client's copy unchanged, so there X-Forwarded-For decides, and a
        // relayed request it cannot name is 'unknown', never the loopback peer.
        const trustCloudflare = isCloudflareClientIpTrusted(headers, normalizedRemote);
        const forwardedIp = getTrustedForwardedClientIp(headers, normalizedRemote, trustForwarded, {
            trustedHopCount: resolveTrustedHopCount(getTrustProxy()),
            trustCloudflareClientIp: trustCloudflare,
        });
        if (forwardedIp) return forwardedIp;
        // Only a relay on this machine can vouch for cf-connecting-ip; a direct client could choose its own identity.
        if (!isRelayedFromLoopback(headers, normalizedRemote)) return normalizedRemote;
        // A relay forwarded headers are not trusted from. In a Cloudflare mode cf-connecting-ip is the viewer's
        // address, and the 'public-share:' prefix gives each viewer its own rate-limit bucket that never matches
        // isLocalClientIp. Otherwise the header is the client's own choice, so all such requests share one bucket.
        const tunnelViewerIp = trustCloudflare ? getCloudflareClientIp(headers) : '';
        return tunnelViewerIp ? `public-share:${tunnelViewerIp}` : 'public-share-proxy';
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
