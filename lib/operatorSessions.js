'use strict';

// Host sign-in sessions. A host on another computer proves the host password (OPERATOR_TOKEN) once and then holds a
// session id in an HttpOnly cookie, so the password itself is never kept where page script can read it.
//
// Sessions live in memory only: a restart signs every remote host out, which is fine because it ends every room too.

const crypto = require('node:crypto');

const OPERATOR_SESSION_COOKIE = 'nextra_host';
const OPERATOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_OPERATOR_SESSIONS = 32;
const SESSION_ID_BYTES = 32;
// 32 random bytes as base64url: 43 characters, no padding.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isSessionIdShaped(id) {
    return typeof id === 'string' && SESSION_ID_PATTERN.test(id);
}

/**
 * An in-memory store of host sign-in sessions.
 *
 * - `create()` returns a new id: 32 random bytes as base64url. It is the only place the id exists on the server;
 *   the store keeps its SHA-256 digest, so a memory dump or a lookup's timing gives away no usable id, and the id
 *   is never logged.
 * - A session ends `ttlMs` after it was created (12 hours), however much it is used: there is no sliding renewal.
 * - At most `maxSessions` are live (32). One more drops the oldest, so sign-ins cannot grow the store.
 * - An expired session is removed when it is looked up, and all of them whenever a session is created.
 *
 * `now` and `randomBytes` are injectable for tests.
 */
function createOperatorSessions({
    ttlMs = OPERATOR_SESSION_TTL_MS,
    maxSessions = MAX_OPERATOR_SESSIONS,
    now = () => Date.now(),
    randomBytes = crypto.randomBytes,
} = {}) {
    // Digest -> expiry. A Map iterates in insertion order, so its first entry is the oldest session.
    const sessions = new Map();

    function digestOf(id) {
        return crypto.createHash('sha256').update(id, 'utf8').digest('hex');
    }

    function prune() {
        const at = now();
        for (const [digest, expiresAt] of sessions) {
            if (expiresAt <= at) sessions.delete(digest);
        }
    }

    function create() {
        prune();
        while (sessions.size >= maxSessions) {
            sessions.delete(sessions.keys().next().value);
        }
        const id = randomBytes(SESSION_ID_BYTES).toString('base64url');
        sessions.set(digestOf(id), now() + ttlMs);
        return id;
    }

    function isValid(id) {
        if (!isSessionIdShaped(id)) return false;
        const digest = digestOf(id);
        const expiresAt = sessions.get(digest);
        if (expiresAt === undefined) return false;
        if (expiresAt <= now()) {
            sessions.delete(digest);
            return false;
        }
        return true;
    }

    /** Ends a session. True when it was live. */
    function revoke(id) {
        if (!isSessionIdShaped(id)) return false;
        return sessions.delete(digestOf(id));
    }

    return {
        create,
        isValid,
        revoke,
        prune,
        get size() {
            prune();
            return sessions.size;
        },
    };
}

/**
 * The values a Cookie header carries under the session cookie's name, in header order, without duplicates. More
 * than one is possible (a stale cookie left under another path), so callers accept a request when any of them is a
 * live session. Values that are not shaped like a session id are dropped here.
 */
function readOperatorSessionIds(cookieHeader) {
    const text = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;
    if (typeof text !== 'string' || !text) return [];
    const ids = [];
    for (const pair of text.split(';')) {
        const separator = pair.indexOf('=');
        if (separator === -1) continue;
        if (pair.slice(0, separator).trim() !== OPERATOR_SESSION_COOKIE) continue;
        const value = pair.slice(separator + 1).trim();
        if (isSessionIdShaped(value) && !ids.includes(value)) ids.push(value);
    }
    return ids;
}

function sessionCookieAttributes(maxAgeSeconds, secure) {
    // HttpOnly keeps page script (and anything injected into it) from reading the id. SameSite=Strict keeps the
    // browser from attaching it to any request another site starts, navigations included. Secure, on an HTTPS
    // request, keeps it off plain HTTP afterwards.
    return `HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

/** The Set-Cookie value that hands a new session to the browser. `secure` is whether the request came over HTTPS. */
function buildOperatorSessionCookie(id, { secure = false, ttlMs = OPERATOR_SESSION_TTL_MS } = {}) {
    return `${OPERATOR_SESSION_COOKIE}=${id}; ${sessionCookieAttributes(Math.floor(ttlMs / 1000), secure)}`;
}

/** The Set-Cookie value that removes the session cookie from the browser. */
function buildClearedOperatorSessionCookie({ secure = false } = {}) {
    return `${OPERATOR_SESSION_COOKIE}=; ${sessionCookieAttributes(0, secure)}`;
}

module.exports = {
    OPERATOR_SESSION_COOKIE,
    OPERATOR_SESSION_TTL_MS,
    MAX_OPERATOR_SESSIONS,
    createOperatorSessions,
    readOperatorSessionIds,
    buildOperatorSessionCookie,
    buildClearedOperatorSessionCookie,
};
