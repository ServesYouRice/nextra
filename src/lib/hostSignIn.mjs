// Host sign-in, as the host page sees it: what /api/config says about this browser's operator rights, and the
// exchange with /api/operator/session. The host password is handed to fetch and nowhere else: not to storage, not
// to a URL, not to the log. The server answers with an HttpOnly cookie that page script cannot read.

// What the host page assumes until /api/config has answered, and when it cannot be read: this browser may host.
// A host on the machine running Nextra, or on a trusted LAN, then sees the page exactly as before; a browser
// without the rights is corrected by the answer, and the server refuses its room either way.
export const ASSUMED_OPERATOR_ACCESS = Object.freeze({ authorized: true, signInAvailable: false, session: false });

/**
 * The operator flags of an /api/config answer:
 * - `authorized`: this browser has operator rights, by any means;
 * - `signInAvailable`: the server has a host password and this browser is not already local;
 * - `session`: the rights come from a sign-in session, so "Sign out" means something.
 * An answer without the flags (no answer, or a server from before host sign-in) is the assumption above.
 */
export function readOperatorAccess(config) {
    if (!config || typeof config !== 'object' || typeof config.operatorAuthorized !== 'boolean') {
        return ASSUMED_OPERATOR_ACCESS;
    }
    const authorized = config.operatorAuthorized;
    return {
        authorized,
        signInAvailable: config.operatorSignInAvailable === true,
        session: authorized && config.operatorSession === true,
    };
}

/** "in 45 seconds", "in about 7 minutes": when a blocked sign-in may be tried again. */
export function formatRetryDelay(seconds) {
    const wait = Math.ceil(Number(seconds));
    if (!Number.isFinite(wait) || wait <= 0) return 'in a few minutes';
    if (wait < 60) return `in ${wait} second${wait === 1 ? '' : 's'}`;
    const minutes = Math.ceil(wait / 60);
    return `in about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export const HOST_SIGN_IN_HTTPS_REQUIRED = 'Signing in needs HTTPS, so the host password is never sent unencrypted. Open this page with https:// and try again.';
export const HOST_SIGN_IN_UNAVAILABLE = 'Hosting from another computer is switched off on this server.';
const HOST_SIGN_IN_UNREACHABLE = 'Could not reach the server. Check your connection and try again.';

/** What to tell the host when a sign-in was refused. `error` is the code in the server's JSON answer. */
export function describeSignInFailure({ status, error, retryAfterSeconds } = {}) {
    if (status === 401 || error === 'wrong_password') {
        return 'That is not the host password. Check it and try again.';
    }
    if (status === 429 || error === 'too_many_attempts') {
        return `Too many sign-in attempts. Try again ${formatRetryDelay(retryAfterSeconds)}.`;
    }
    if (error === 'https_required') return HOST_SIGN_IN_HTTPS_REQUIRED;
    if (status === 409 || error === 'not_configured') return HOST_SIGN_IN_UNAVAILABLE;
    if (status === 403 || error === 'forbidden_origin') {
        return 'The server did not accept a sign-in from this address. Open Nextra at its own address and try again.';
    }
    if (!status) return HOST_SIGN_IN_UNREACHABLE;
    return `Sign-in failed (HTTP ${status}). Try again in a moment.`;
}

/** Whether this page may send the host password at all: only a page loaded over HTTPS. */
export function canSendHostPassword(pageProtocol) {
    return pageProtocol === 'https:';
}

async function readJson(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

/**
 * Sends the host password to the server. Resolves to `{ ok: true }` once the session cookie is set, else to
 * `{ ok: false, reason, message }` with a message for the host.
 *
 * A page on plain HTTP sends nothing: the server would refuse the sign-in, but by then the password would already
 * have crossed the network unencrypted. (A host on the machine running Nextra never gets here; it needs no sign-in.)
 */
export async function signInAsHost(password, { fetchImpl = globalThis.fetch, pageProtocol = globalThis.location?.protocol } = {}) {
    if (!canSendHostPassword(pageProtocol)) {
        return { ok: false, reason: 'https_required', message: HOST_SIGN_IN_HTTPS_REQUIRED };
    }
    let response;
    try {
        response = await fetchImpl('/api/operator/session', {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
            body: JSON.stringify({ password }),
        });
    } catch {
        return { ok: false, reason: 'unreachable', message: HOST_SIGN_IN_UNREACHABLE };
    }
    if (response.status === 204) return { ok: true };

    const body = await readJson(response);
    const error = typeof body?.error === 'string' ? body.error : '';
    const retryAfterSeconds = Number(body?.retryAfterSeconds) || Number(response.headers?.get?.('retry-after')) || 0;
    return {
        ok: false,
        reason: error || `http_${response.status}`,
        message: describeSignInFailure({ status: response.status, error, retryAfterSeconds }),
    };
}

/** Ends this browser's host session. Resolves to `{ ok: true }` or `{ ok: false, message }`. */
export async function signOutHost({ fetchImpl = globalThis.fetch } = {}) {
    try {
        const response = await fetchImpl('/api/operator/session', {
            method: 'DELETE',
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
        });
        if (response.status === 204) return { ok: true };
        return { ok: false, message: `Could not sign out (HTTP ${response.status}). Try again in a moment.` };
    } catch {
        return { ok: false, message: 'Could not sign out. Check your connection and try again.' };
    }
}

/** /api/config as this browser sees it now, or null when it cannot be read. Never from a cache: a sign-in changes it. */
export async function fetchHostConfig({ fetchImpl = globalThis.fetch, signal } = {}) {
    try {
        const response = await fetchImpl('/api/config', {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
            signal,
        });
        return response.ok ? await response.json() : null;
    } catch {
        return null;
    }
}
