'use strict';

// Host sign-in over HTTP: POST /api/operator/session trades the host password (OPERATOR_TOKEN) for a session
// cookie, DELETE ends the session. server.js mounts the router and supplies what a request means on this server
// (who the client is, whether it came over HTTPS, whether it is same-origin); the rules live here.

const express = require('express');
const { timingSafeTokenEqual } = require('./network');
const {
    buildClearedOperatorSessionCookie,
    buildOperatorSessionCookie,
    readOperatorSessionIds,
} = require('./operatorSessions');

const SIGN_IN_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const SIGN_IN_MAX_FAILURES_PER_CLIENT = 5;
// The body is one password. The setting it is compared with is far shorter than this.
const SIGN_IN_BODY_LIMIT = '4kb';

/**
 * Counts failures per key in a sliding window. A key that has `maxFailures` failures inside the last `windowMs`
 * is blocked until the oldest of them is `windowMs` old.
 *
 * - `retryAfterMs(key)` is 0 while the key may try, else the wait in milliseconds.
 * - `recordFailure(key)` adds one failure. Callers check `retryAfterMs` first and record nothing while a key is
 *   blocked, so a key never holds more than `maxFailures` times.
 * - `clear(key)` forgets the key (a success).
 *
 * Expired times are dropped on every call that touches a key, and every key is swept on each recorded failure, so
 * the map holds only keys that failed inside the window.
 */
function createFailureLimiter({ maxFailures, windowMs, now = () => Date.now() }) {
    const failures = new Map();

    function liveTimes(key, at) {
        const times = (failures.get(key) || []).filter((time) => at - time < windowMs);
        if (times.length > 0) failures.set(key, times);
        else failures.delete(key);
        return times;
    }

    return {
        retryAfterMs(key) {
            const at = now();
            const times = liveTimes(key, at);
            if (times.length < maxFailures) return 0;
            return times[times.length - maxFailures] + windowMs - at;
        },
        recordFailure(key) {
            const at = now();
            for (const other of [...failures.keys()]) liveTimes(other, at);
            failures.set(key, [...liveTimes(key, at), at].slice(-maxFailures));
        },
        clear(key) {
            failures.delete(key);
        },
        get size() {
            return failures.size;
        },
    };
}

/**
 * The router for /api/operator/session.
 *
 * POST with JSON `{ "password": "..." }` signs a host in. In order:
 * - 409 `not_configured` when no host password is set (`getOperatorToken()` is empty).
 * - 400 `https_required` unless the request came over HTTPS or from a client that is already local. A password
 *   must not cross plain HTTP, and the answer does not depend on the password, so nothing is learned from it.
 * - 403 `forbidden_origin` unless the Origin header is the request's own origin or a known public share origin.
 * - 415 `json_required` for any other content type; 400 `invalid_json` for a body that does not parse.
 * - 429 `too_many_attempts` with Retry-After while this client has 5 failures in 10 minutes. The check comes
 *   before the comparison: a blocked client learns nothing about a guess, right or wrong. There is no limit across
 *   all clients on purpose: the password is at least 32 high-entropy characters, so guessing it is hopeless at any
 *   rate, while a shared ceiling would let anyone lock the real host out by failing on purpose.
 * - 401 `wrong_password`, which counts as a failure for that client.
 * - 204 with the session cookie. Success clears that client's failures.
 *
 * DELETE ends the session named by the request's cookie and clears the cookie: 204, also when there was none.
 * It needs the same Origin check, so another site cannot sign a host out.
 *
 * Options:
 * - `sessions`: the store from createOperatorSessions.
 * - `getOperatorToken()`: the host password, '' when hosting from another computer is off.
 * - `isLocalClient(req)`: the request is the operator's own (this machine or a trusted LAN).
 * - `isSecureRequest(req)`: direct TLS, or X-Forwarded-Proto: https from a trusted proxy.
 * - `isSameOriginRequest(req)`: the Origin rule above.
 * - `getClientId(req)`: the rate-limit identity (the forwarded client address, never a proxy's).
 * - `now`: injectable clock for tests.
 */
function createOperatorSessionRouter({
    sessions,
    getOperatorToken,
    isLocalClient,
    isSecureRequest,
    isSameOriginRequest,
    getClientId,
    now = () => Date.now(),
}) {
    const clientFailures = createFailureLimiter({
        maxFailures: SIGN_IN_MAX_FAILURES_PER_CLIENT,
        windowMs: SIGN_IN_FAILURE_WINDOW_MS,
        now,
    });
    const router = express.Router();

    router.use((_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    function refuseBeforeBody(req, res, next) {
        if (!getOperatorToken()) {
            res.status(409).json({ error: 'not_configured' });
            return;
        }
        if (!isLocalClient(req) && !isSecureRequest(req)) {
            res.status(400).json({ error: 'https_required' });
            return;
        }
        if (!isSameOriginRequest(req)) {
            res.status(403).json({ error: 'forbidden_origin' });
            return;
        }
        if (!req.is('application/json')) {
            res.status(415).json({ error: 'json_required' });
            return;
        }
        next();
    }

    router.post('/', refuseBeforeBody, express.json({ limit: SIGN_IN_BODY_LIMIT }), (req, res) => {
        const clientId = String(getClientId(req) || 'unknown');
        const retryAfterMs = clientFailures.retryAfterMs(clientId);
        if (retryAfterMs > 0) {
            const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
            res.set('Retry-After', String(retryAfterSeconds));
            res.status(429).json({ error: 'too_many_attempts', retryAfterSeconds });
            return;
        }

        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!timingSafeTokenEqual(password, getOperatorToken())) {
            clientFailures.recordFailure(clientId);
            // The client identity only: never the password that was tried.
            console.warn(`[Operator] Host sign-in failed for ${clientId}.`);
            res.status(401).json({ error: 'wrong_password' });
            return;
        }

        clientFailures.clear(clientId);
        const id = sessions.create();
        res.append('Set-Cookie', buildOperatorSessionCookie(id, { secure: isSecureRequest(req) }));
        console.log(`[Operator] Host signed in from ${clientId}.`);
        res.status(204).end();
    });

    router.delete('/', (req, res) => {
        if (!isSameOriginRequest(req)) {
            res.status(403).json({ error: 'forbidden_origin' });
            return;
        }
        for (const id of readOperatorSessionIds(req.headers.cookie)) sessions.revoke(id);
        res.append('Set-Cookie', buildClearedOperatorSessionCookie({ secure: isSecureRequest(req) }));
        res.status(204).end();
    });

    // The body parser's refusals: a body that is not JSON, or is larger than a password can be. Nothing was
    // compared, so it is no failure. Any other error is not this router's to answer.
    router.use((err, _req, res, next) => {
        if (res.headersSent || typeof err?.type !== 'string') {
            next(err);
            return;
        }
        const tooLarge = err.status === 413;
        res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'body_too_large' : 'invalid_json' });
    });

    return router;
}

module.exports = {
    SIGN_IN_FAILURE_WINDOW_MS,
    SIGN_IN_MAX_FAILURES_PER_CLIENT,
    createFailureLimiter,
    createOperatorSessionRouter,
};
