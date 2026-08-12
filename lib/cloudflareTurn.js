const DEFAULT_CLOUDFLARE_TURN_BASE_URL = 'https://rtc.live.cloudflare.com';
const DEFAULT_CLOUDFLARE_TURN_TTL_SECONDS = 21_600;
const MIN_CLOUDFLARE_TURN_TTL_SECONDS = 60;
const MAX_CLOUDFLARE_TURN_TTL_SECONDS = 86_400;

function normalizeCloudflareTurnValue(value) {
    return String(value || '').trim();
}

function hasCloudflareTurnCredentialSource(source = {}) {
    return Boolean(
        normalizeCloudflareTurnValue(source.keyId)
        && normalizeCloudflareTurnValue(source.apiToken)
    );
}

function normalizeCloudflareTurnTtlSeconds(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_CLOUDFLARE_TURN_TTL_SECONDS;
    return Math.min(
        MAX_CLOUDFLARE_TURN_TTL_SECONDS,
        Math.max(MIN_CLOUDFLARE_TURN_TTL_SECONDS, parsed)
    );
}

function normalizeCloudflareTurnBaseUrl(value) {
    const raw = normalizeCloudflareTurnValue(value) || DEFAULT_CLOUDFLARE_TURN_BASE_URL;
    return raw.replace(/\/+$/, '');
}

function isBrowserBlockedTurnUrl(url) {
    return /^(turn|turns):[^?]*:53(?:[/?]|$)/i.test(normalizeCloudflareTurnValue(url));
}

function normalizeCloudflareIceServersPayload(payload = {}) {
    if (Array.isArray(payload?.iceServers)) return payload.iceServers;
    if (Array.isArray(payload?.result?.iceServers)) return payload.result.iceServers;
    return [];
}

function extractCloudflareTurnConfig(payload = {}) {
    const iceServers = normalizeCloudflareIceServersPayload(payload);
    let username = '';
    let credential = '';
    const urls = [];

    iceServers.forEach((server) => {
        const serverUrls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
        const turnUrls = serverUrls
            .map((url) => normalizeCloudflareTurnValue(url))
            .filter((url) => /^turns?:/i.test(url))
            .filter((url) => !isBrowserBlockedTurnUrl(url));

        if (turnUrls.length === 0) return;

        urls.push(...turnUrls);

        if (!username) username = normalizeCloudflareTurnValue(server?.username);
        if (!credential) credential = normalizeCloudflareTurnValue(server?.credential);
    });

    const uniqueUrls = Array.from(new Set(urls));
    if (uniqueUrls.length === 0) {
        throw new Error('Cloudflare did not return any browser-safe TURN URLs.');
    }
    if (!username || !credential) {
        throw new Error('Cloudflare did not return TURN username/credential fields.');
    }

    return {
        urls: uniqueUrls,
        authType: 'static',
        username,
        credential,
    };
}

async function readCloudflareErrorMessage(response) {
    let payload = null;
    try {
        payload = await response.json();
    } catch {
        // Keep the null fallback for non-JSON error responses.
    }

    const errorMessage = payload?.errors?.[0]?.message
        || payload?.error
        || payload?.message
        || response.statusText
        || `HTTP ${response.status}`;

    return {
        payload,
        errorMessage,
    };
}

async function fetchCloudflareTurnCredentials({
    keyId,
    apiToken,
    ttlSeconds = DEFAULT_CLOUDFLARE_TURN_TTL_SECONDS,
    baseUrl = DEFAULT_CLOUDFLARE_TURN_BASE_URL,
    fetchImpl = globalThis.fetch,
    signal,
} = {}) {
    if (typeof fetchImpl !== 'function') {
        throw new Error('This runtime does not support fetch().');
    }
    if (!hasCloudflareTurnCredentialSource({ keyId, apiToken })) {
        throw new Error('Cloudflare TURN is not configured on this server.');
    }

    const requestUrl = `${normalizeCloudflareTurnBaseUrl(baseUrl)}/v1/turn/keys/${encodeURIComponent(
        normalizeCloudflareTurnValue(keyId)
    )}/credentials/generate-ice-servers`;
    const ttl = normalizeCloudflareTurnTtlSeconds(ttlSeconds);

    const response = await fetchImpl(requestUrl, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${normalizeCloudflareTurnValue(apiToken)}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({ ttl }),
        signal,
    });

    if (!response.ok) {
        const { errorMessage } = await readCloudflareErrorMessage(response);
        throw new Error(`Cloudflare TURN request failed: ${errorMessage}`);
    }

    const payload = await response.json();
    return {
        ttlSeconds: ttl,
        turnConfig: extractCloudflareTurnConfig(payload),
        payload,
    };
}

module.exports = {
    DEFAULT_CLOUDFLARE_TURN_BASE_URL,
    DEFAULT_CLOUDFLARE_TURN_TTL_SECONDS,
    MIN_CLOUDFLARE_TURN_TTL_SECONDS,
    MAX_CLOUDFLARE_TURN_TTL_SECONDS,
    hasCloudflareTurnCredentialSource,
    normalizeCloudflareTurnTtlSeconds,
    normalizeCloudflareTurnBaseUrl,
    isBrowserBlockedTurnUrl,
    extractCloudflareTurnConfig,
    fetchCloudflareTurnCredentials,
};
