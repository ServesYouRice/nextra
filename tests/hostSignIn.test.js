// The host page's side of the host sign-in (src/lib/hostSignIn.mjs): how it reads its operator rights from
// /api/config, what it sends to /api/operator/session, and what it tells the host when the server refuses.
// tests/browser/host-sign-in.spec.mjs drives the panel itself in a browser.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/lib/hostSignIn.mjs');

/** A fetch stand-in that records each call and answers with what the test hands it. */
function fakeFetch(answer) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        calls.push({ url, options });
        if (answer instanceof Error) throw answer;
        const { status = 200, body, headers = {} } = typeof answer === 'function' ? answer(url, options) : answer;
        return {
            status,
            ok: status >= 200 && status < 300,
            headers: { get: (name) => headers[name.toLowerCase()] ?? null },
            json: async () => {
                if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
                return body;
            },
        };
    };
    return { calls, fetchImpl };
}

test('readOperatorAccess reads the three flags of /api/config', async () => {
    const { readOperatorAccess } = await load();
    // The host's own machine.
    assert.deepEqual(
        readOperatorAccess({ operatorAuthorized: true, operatorSignInAvailable: false, operatorSession: false }),
        { authorized: true, signInAvailable: false, session: false },
    );
    // Another computer, host password set.
    assert.deepEqual(
        readOperatorAccess({ operatorAuthorized: false, operatorSignInAvailable: true, operatorSession: false }),
        { authorized: false, signInAvailable: true, session: false },
    );
    // Another computer, no host password.
    assert.deepEqual(
        readOperatorAccess({ operatorAuthorized: false, operatorSignInAvailable: false, operatorSession: false }),
        { authorized: false, signInAvailable: false, session: false },
    );
    // Signed in.
    assert.deepEqual(
        readOperatorAccess({ operatorAuthorized: true, operatorSignInAvailable: true, operatorSession: true }),
        { authorized: true, signInAvailable: true, session: true },
    );
    // Only real booleans count, and a session without rights is no session.
    assert.deepEqual(
        readOperatorAccess({ operatorAuthorized: false, operatorSignInAvailable: 'yes', operatorSession: true }),
        { authorized: false, signInAvailable: false, session: false },
    );
});

test('readOperatorAccess assumes a host may host until the server says otherwise', async () => {
    const { ASSUMED_OPERATOR_ACCESS, readOperatorAccess } = await load();
    assert.deepEqual(ASSUMED_OPERATOR_ACCESS, { authorized: true, signInAvailable: false, session: false });
    // No answer, or one from a server that does not send the flags: the page stays as it always was.
    for (const config of [undefined, null, '', 'nope', {}, { whepEnabled: true }, { operatorAuthorized: 'true' }, { operatorAuthorized: 1 }]) {
        assert.equal(readOperatorAccess(config), ASSUMED_OPERATOR_ACCESS, JSON.stringify(config));
    }
    assert.ok(Object.isFrozen(ASSUMED_OPERATOR_ACCESS));
});

test('formatRetryDelay says when to try again', async () => {
    const { formatRetryDelay } = await load();
    assert.equal(formatRetryDelay(1), 'in 1 second');
    assert.equal(formatRetryDelay(45), 'in 45 seconds');
    assert.equal(formatRetryDelay(59.2), 'in about 1 minute');
    assert.equal(formatRetryDelay(60), 'in about 1 minute');
    assert.equal(formatRetryDelay(61), 'in about 2 minutes');
    assert.equal(formatRetryDelay(600), 'in about 10 minutes');
    assert.equal(formatRetryDelay('300'), 'in about 5 minutes');
    for (const unknown of [0, -5, NaN, undefined, null, 'soon']) {
        assert.equal(formatRetryDelay(unknown), 'in a few minutes', String(unknown));
    }
});

test('describeSignInFailure has a clear message for each refusal', async () => {
    const { describeSignInFailure, HOST_SIGN_IN_HTTPS_REQUIRED, HOST_SIGN_IN_UNAVAILABLE } = await load();
    assert.match(describeSignInFailure({ status: 401, error: 'wrong_password' }), /not the host password/i);
    assert.equal(
        describeSignInFailure({ status: 429, error: 'too_many_attempts', retryAfterSeconds: 420 }),
        'Too many sign-in attempts. Try again in about 7 minutes.',
    );
    assert.equal(
        describeSignInFailure({ status: 429, error: 'too_many_attempts', retryAfterSeconds: 30 }),
        'Too many sign-in attempts. Try again in 30 seconds.',
    );
    assert.equal(describeSignInFailure({ status: 429 }), 'Too many sign-in attempts. Try again in a few minutes.');
    assert.equal(describeSignInFailure({ status: 400, error: 'https_required' }), HOST_SIGN_IN_HTTPS_REQUIRED);
    assert.match(HOST_SIGN_IN_HTTPS_REQUIRED, /HTTPS/);
    assert.match(HOST_SIGN_IN_HTTPS_REQUIRED, /https:\/\//);
    assert.equal(describeSignInFailure({ status: 409, error: 'not_configured' }), HOST_SIGN_IN_UNAVAILABLE);
    assert.match(HOST_SIGN_IN_UNAVAILABLE, /switched off on this server/);
    assert.match(describeSignInFailure({ status: 403, error: 'forbidden_origin' }), /did not accept a sign-in from this address/);
    assert.match(describeSignInFailure({}), /Could not reach the server/);
    assert.match(describeSignInFailure(), /Could not reach the server/);
    assert.equal(describeSignInFailure({ status: 500 }), 'Sign-in failed (HTTP 500). Try again in a moment.');
    assert.equal(describeSignInFailure({ status: 400, error: 'invalid_json' }), 'Sign-in failed (HTTP 400). Try again in a moment.');
    // No message echoes a password or leaks a technical body.
    for (const failure of [{ status: 401 }, { status: 429 }, { status: 400, error: 'https_required' }, { status: 500 }]) {
        assert.doesNotMatch(describeSignInFailure(failure), /undefined|null|\[object/);
    }
});

test('signInAsHost posts the password as JSON to the session route and nowhere else', async () => {
    const { signInAsHost } = await load();
    const { calls, fetchImpl } = fakeFetch({ status: 204 });
    const password = 'host-sign-in-page-password-0123456789abcdef';
    assert.deepEqual(await signInAsHost(password, { fetchImpl, pageProtocol: 'https:' }), { ok: true });

    assert.equal(calls.length, 1);
    const [{ url, options }] = calls;
    // In the body of a same-origin POST: never in the URL, where logs and history keep it.
    assert.equal(url, '/api/operator/session');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { password });
    assert.ok(!Object.values(options.headers).some((value) => String(value).includes(password)), 'the password was put in a header');
});

test('signInAsHost never sends the password from a page on plain HTTP', async () => {
    const { signInAsHost, canSendHostPassword, HOST_SIGN_IN_HTTPS_REQUIRED } = await load();
    assert.equal(canSendHostPassword('https:'), true);
    for (const pageProtocol of ['http:', 'file:', '', undefined, 'HTTPS']) {
        assert.equal(canSendHostPassword(pageProtocol), false, String(pageProtocol));
        const { calls, fetchImpl } = fakeFetch({ status: 204 });
        const result = await signInAsHost('secret', { fetchImpl, pageProtocol });
        assert.deepEqual(result, { ok: false, reason: 'https_required', message: HOST_SIGN_IN_HTTPS_REQUIRED });
        assert.equal(calls.length, 0, `the password was sent from a ${pageProtocol} page`);
    }
});

test('signInAsHost turns each refusal into a reason and a message', async () => {
    const { signInAsHost, HOST_SIGN_IN_HTTPS_REQUIRED } = await load();
    const attempt = (answer) => signInAsHost('guess', { fetchImpl: fakeFetch(answer).fetchImpl, pageProtocol: 'https:' });

    const wrong = await attempt({ status: 401, body: { error: 'wrong_password' } });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, 'wrong_password');
    assert.match(wrong.message, /not the host password/i);

    // The wait comes from the body, or from Retry-After when the body has none.
    const limited = await attempt({ status: 429, body: { error: 'too_many_attempts', retryAfterSeconds: 540 }, headers: { 'retry-after': '540' } });
    assert.equal(limited.reason, 'too_many_attempts');
    assert.equal(limited.message, 'Too many sign-in attempts. Try again in about 9 minutes.');
    const limitedByHeader = await attempt({ status: 429, body: { error: 'too_many_attempts' }, headers: { 'retry-after': '90' } });
    assert.equal(limitedByHeader.message, 'Too many sign-in attempts. Try again in about 2 minutes.');
    const limitedBare = await attempt({ status: 429 });
    assert.equal(limitedBare.reason, 'http_429');
    assert.equal(limitedBare.message, 'Too many sign-in attempts. Try again in a few minutes.');

    const https = await attempt({ status: 400, body: { error: 'https_required' } });
    assert.equal(https.reason, 'https_required');
    assert.equal(https.message, HOST_SIGN_IN_HTTPS_REQUIRED);

    const off = await attempt({ status: 409, body: { error: 'not_configured' } });
    assert.equal(off.reason, 'not_configured');
    assert.match(off.message, /switched off on this server/);

    const html = await attempt({ status: 502 });
    assert.equal(html.reason, 'http_502');
    assert.equal(html.message, 'Sign-in failed (HTTP 502). Try again in a moment.');

    const offline = await attempt(new TypeError('Failed to fetch'));
    assert.deepEqual(offline, { ok: false, reason: 'unreachable', message: 'Could not reach the server. Check your connection and try again.' });
    // A 200 is not the documented success: only the 204 that sets the cookie is.
    assert.equal((await attempt({ status: 200, body: {} })).ok, false);
});

test('signOutHost deletes the session and reports a failure in words', async () => {
    const { signOutHost } = await load();
    const { calls, fetchImpl } = fakeFetch({ status: 204 });
    assert.deepEqual(await signOutHost({ fetchImpl }), { ok: true });
    assert.equal(calls[0].url, '/api/operator/session');
    assert.equal(calls[0].options.method, 'DELETE');
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.equal(calls[0].options.body, undefined);

    const refused = await signOutHost({ fetchImpl: fakeFetch({ status: 403, body: { error: 'forbidden_origin' } }).fetchImpl });
    assert.deepEqual(refused, { ok: false, message: 'Could not sign out (HTTP 403). Try again in a moment.' });
    const offline = await signOutHost({ fetchImpl: fakeFetch(new TypeError('Failed to fetch')).fetchImpl });
    assert.deepEqual(offline, { ok: false, message: 'Could not sign out. Check your connection and try again.' });
});

test('fetchHostConfig reads /api/config without a cache and yields null when it cannot', async () => {
    const { fetchHostConfig, readOperatorAccess, ASSUMED_OPERATOR_ACCESS } = await load();
    const config = { whepEnabled: false, operatorAuthorized: false, operatorSignInAvailable: true, operatorSession: false };
    const controller = new AbortController();
    const { calls, fetchImpl } = fakeFetch({ status: 200, body: config });
    assert.deepEqual(await fetchHostConfig({ fetchImpl, signal: controller.signal }), config);
    assert.equal(calls[0].url, '/api/config');
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.equal(calls[0].options.signal, controller.signal);

    for (const answer of [{ status: 500, body: {} }, { status: 200 }, new TypeError('Failed to fetch')]) {
        const result = await fetchHostConfig({ fetchImpl: fakeFetch(answer).fetchImpl });
        assert.equal(result, null);
        // An unreadable config leaves the page as a local host has always seen it.
        assert.equal(readOperatorAccess(result), ASSUMED_OPERATOR_ACCESS);
    }
});
