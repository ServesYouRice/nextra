// The WHIP address the Host page gives OBS, by hand or through auto-configuration.
//
// OBS runs on the host's own computer. When that computer is the one running
// Nextra, OBS reaches the plaintext WHIP listener on loopback (WHIP_BIND_HOST,
// WHIP_HTTP_PORT). When the host signed in from another computer, that
// listener is out of reach; with PUBLIC_WHIP_ENABLED the server also serves
// WHIP on its public origin, and OBS uses the HTTPS address the page itself was
// opened on. A page on plain HTTP, or on this machine or a private address
// (where HTTPS means a self-signed certificate OBS does not accept), keeps the
// loopback listener.

function formatHostForUrl(host) {
    const value = String(host || '127.0.0.1').trim() || '127.0.0.1';
    return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
}

function isLocalHostname(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    return host === ''
        || host === 'localhost'
        || host.endsWith('.localhost')
        || host === '::1'
        || /^127\./.test(host)
        || /^10\./.test(host)
        || /^192\.168\./.test(host)
        || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
        || /^(fc|fd)[0-9a-f]*:/.test(host)
        || /^fe80:/.test(host);
}

/**
 * The public HTTPS origin OBS should send WHIP to, or '' when it should use the loopback listener.
 * @param {{ publicWhipEnabled?: boolean, pageOrigin?: string }} options
 */
export function publicWhipOrigin({ publicWhipEnabled = false, pageOrigin = '' } = {}) {
    if (publicWhipEnabled !== true) return '';
    let url;
    try {
        url = new URL(String(pageOrigin || ''));
    } catch {
        return '';
    }
    if (url.protocol !== 'https:' || isLocalHostname(url.hostname)) return '';
    return url.origin;
}

/**
 * The WHIP broadcast URL for a room.
 * @param {string} code room code
 * @param {{ publicWhipEnabled?: boolean, pageOrigin?: string, whipHttpHost?: string, whipHttpPort?: number }} options
 */
export function buildWhipBroadcastUrl(code, { publicWhipEnabled = false, pageOrigin = '', whipHttpHost = '127.0.0.1', whipHttpPort = 3001 } = {}) {
    const path = `/whip/broadcast/${code}`;
    const origin = publicWhipOrigin({ publicWhipEnabled, pageOrigin });
    if (origin) return `${origin}${path}`;
    return `http://${formatHostForUrl(whipHttpHost)}:${whipHttpPort}${path}`;
}
