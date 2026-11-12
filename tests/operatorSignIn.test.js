// The host sign-in routes (lib/operatorSignIn.js) on their own: POST and DELETE /api/operator/session with the
// server's view of a request (local, HTTPS, same-origin, client identity) stubbed, and the clock under the test's
// control so the 10-minute failure window can be walked through. tests/operatorSessionServer.test.js runs the same
// routes inside the real server.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { createOperatorSessions, readOperatorSessionIds } = require('../lib/operatorSessions');
const {
    SIGN_IN_FAILURE_WINDOW_MS,
    SIGN_IN_MAX_FAILURES_PER_CLIENT,
    createFailureLimiter,
    createOperatorSessionRouter,
} = require('../lib/operatorSignIn');

const PASSWORD = 'sign-in-router-host-password-0123456789abcdef';
const ORIGIN = 'https://nextra.example.com';
const MINUTE = 60 * 1000;

function fakeClock(start = 1_700_000_000_000) {
    let at = start;
    return {
        now: () => at,
        advance: (ms) => { at += ms; },
    };
}

test('the documented limit: 5 failures per client in 10 minutes', () => {
    assert.equal(SIGN_IN_MAX_FAILURES_PER_CLIENT, 5);
    assert.equal(SIGN_IN_FAILURE_WINDOW_MS, 10 * MINUTE);
});

test('createFailureLimiter blocks a key at the limit until its oldest failure leaves the window', () => {
    const clock = fakeClock();
    const limiter = createFailureLimiter({ maxFailures: 3, windowMs: 1000, now: clock.now });
    assert.equal(limiter.retryAfterMs('a'), 0);
    limiter.recordFailure('a');
    clock.advance(100);
    limiter.recordFailure('a');
    assert.equal(limiter.retryAfterMs('a'), 0, 'blocked below the limit');
    clock.advance(100);
    limiter.recordFailure('a');
    // Three failures at 0, 100 and 200 ms: blocked until the first is 1000 ms old.
    assert.equal(limiter.retryAfterMs('a'), 800);
    assert.equal(limiter.retryAfterMs('b'), 0, 'another key was blocked');
    clock.advance(799);
    assert.equal(limiter.retryAfterMs('a'), 1);
    clock.advance(1);
    assert.equal(limiter.retryAfterMs('a'), 0);
    // The window slides: one more failure now joins the two still inside it.
    limiter.recordFailure('a');
    assert.equal(limiter.retryAfterMs('a'), 100);
});

test('createFailureLimiter forgets a cleared key and keys whose failures have expired', () => {
    const clock = fakeClock();
    const limiter = createFailureLimiter({ maxFailures: 2, windowMs: 1000, now: clock.now });
    limiter.recordFailure('a');
    limiter.recordFailure('a');
    limiter.recordFailure('b');
    assert.equal(limiter.size, 2);
    limiter.clear('a');
    assert.equal(limiter.retryAfterMs('a'), 0);
    assert.equal(limiter.size, 1);
    limiter.clear('never-seen');
    clock.advance(1000);
    // Recording for one key sweeps the others, so keys that never return do not stay.
    limiter.recordFailure('c');
    assert.equal(limiter.size, 1);
    clock.advance(1000);
    assert.equal(limiter.retryAfterMs('c'), 0);
    assert.equal(limiter.size, 0);
});

/**
 * The router in a bare Express app. The stubs read the request's own headers, so each test states what the server
 * would have concluded about it: x-test-local (the operator's own machine), x-test-insecure (plain HTTP),
 * x-test-client (the rate-limit identity).
 */
async function startApp(t, { token = PASSWORD } = {}) {
    const clock = fakeClock();
    const state = { token };
    const sessions = createOperatorSessions({ now: clock.now });
    const app = express();
    app.use('/api/operator/session', createOperatorSessionRouter({
        sessions,
        getOperatorToken: () => state.token,
        isLocalClient: (req) => req.headers['x-test-local'] === '1',
        isSecureRequest: (req) => req.headers['x-test-insecure'] !== '1',
        isSameOriginRequest: (req) => req.headers.origin === ORIGIN,
        getClientId: (req) => req.headers['x-test-client'] || 'client-a',
        now: clock.now,
    }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();

    function send({ method = 'POST', headers = {}, body } = {}) {
        return new Promise((resolve, reject) => {
            const request = http.request({ host: '127.0.0.1', port, path: '/api/operator/session', method, headers }, (response) => {
                let text = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => { text += chunk; });
                response.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(text); } catch { /* an empty body */ }
                    resolve({ status: response.statusCode, headers: response.headers, text, json, cookies: response.headers['set-cookie'] || [] });
                });
            });
            request.once('error', reject);
            request.end(body);
        });
    }

    /** A sign-in from Nextra's own page over HTTPS, unless the headers say otherwise. */
    function signIn(password, headers = {}) {
        return send({
            headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ password }),
        });
    }

    return { clock, state, sessions, send, signIn };
}

function sessionIdOf(response) {
    assert.equal(response.cookies.length, 1, 'expected exactly one Set-Cookie header');
    const [id] = readOperatorSessionIds(response.cookies[0].split(';')[0]);
    return id;
}

test('the right password signs in: 204, no body, and a session cookie for a live session', async (t) => {
    const { sessions, signIn } = await startApp(t);
    const response = await signIn(PASSWORD);
    assert.equal(response.status, 204);
    assert.equal(response.text, '');
    assert.equal(response.headers['cache-control'], 'no-store');
    const id = sessionIdOf(response);
    assert.equal(sessions.isValid(id), true);
    assert.equal(response.cookies[0], `nextra_host=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200; Secure`);

    // Each sign-in is its own session.
    const again = await signIn(PASSWORD);
    assert.notEqual(sessionIdOf(again), id);
    assert.equal(sessions.size, 2);
});

test('a client that is already local may sign in over plain HTTP, and its cookie is not marked Secure', async (t) => {
    const { sessions, signIn } = await startApp(t);
    const response = await signIn(PASSWORD, { 'x-test-local': '1', 'x-test-insecure': '1' });
    assert.equal(response.status, 204);
    const id = sessionIdOf(response);
    assert.equal(sessions.isValid(id), true);
    assert.equal(response.cookies[0], `nextra_host=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
});

test('without a host password every sign-in is refused with 409 not_configured', async (t) => {
    const { sessions, signIn, send } = await startApp(t, { token: '' });
    for (const response of [
        await signIn(PASSWORD),
        await signIn(''),
        // Refused before anything else about the request is looked at.
        await signIn(PASSWORD, { origin: 'https://attacker.example', 'x-test-insecure': '1' }),
        await send({ headers: { 'content-type': 'text/plain' }, body: 'x' }),
    ]) {
        assert.equal(response.status, 409);
        assert.deepEqual(response.json, { error: 'not_configured' });
        assert.deepEqual(response.cookies, []);
    }
    assert.equal(sessions.size, 0);
});

test('a password does not cross plain HTTP: 400 https_required, whatever the password', async (t) => {
    const { sessions, signIn } = await startApp(t);
    for (const password of [PASSWORD, 'wrong']) {
        const response = await signIn(password, { 'x-test-insecure': '1' });
        assert.equal(response.status, 400);
        assert.deepEqual(response.json, { error: 'https_required' });
        assert.deepEqual(response.cookies, []);
    }
    assert.equal(sessions.size, 0);
    // Refused before the comparison, so these were no failed attempts.
    for (let attempt = 0; attempt < 8; attempt += 1) await signIn('wrong', { 'x-test-insecure': '1' });
    assert.equal((await signIn(PASSWORD)).status, 204);
});

test('a request that is not same-origin is refused with 403 and costs the client nothing', async (t) => {
    const { sessions, signIn, send } = await startApp(t);
    for (const origin of ['https://attacker.example', 'http://nextra.example.com', 'null', '']) {
        const response = await signIn(PASSWORD, { origin });
        assert.equal(response.status, 403, `origin "${origin}"`);
        assert.deepEqual(response.json, { error: 'forbidden_origin' });
        assert.deepEqual(response.cookies, []);
    }
    const noOrigin = await send({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(noOrigin.status, 403);
    assert.equal(sessions.size, 0);
    for (let attempt = 0; attempt < 8; attempt += 1) await signIn('wrong', { origin: 'https://attacker.example' });
    assert.equal((await signIn(PASSWORD)).status, 204);
});

test('only a JSON body is accepted', async (t) => {
    const { sessions, send } = await startApp(t);
    const post = (headers, body) => send({ headers: { origin: ORIGIN, ...headers }, body });
    const form = `password=${encodeURIComponent(PASSWORD)}`;
    for (const response of [
        // What an HTML form on another site can send without a preflight.
        await post({ 'content-type': 'application/x-www-form-urlencoded' }, form),
        await post({ 'content-type': 'text/plain' }, JSON.stringify({ password: PASSWORD })),
        await post({ 'content-type': 'multipart/form-data; boundary=x' }, form),
        await post({}, JSON.stringify({ password: PASSWORD })),
    ]) {
        assert.equal(response.status, 415);
        assert.deepEqual(response.json, { error: 'json_required' });
        assert.deepEqual(response.cookies, []);
    }
    // A JSON request without a body carries no password.
    const empty = await post({ 'content-type': 'application/json' }, undefined);
    assert.notEqual(empty.status, 204);
    assert.deepEqual(empty.cookies, []);

    const malformed = await post({ 'content-type': 'application/json' }, '{"password":');
    assert.equal(malformed.status, 400);
    assert.deepEqual(malformed.json, { error: 'invalid_json' });
    const tooLarge = await post({ 'content-type': 'application/json' }, JSON.stringify({ password: 'x'.repeat(8192) }));
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(tooLarge.json, { error: 'body_too_large' });
    assert.equal(sessions.size, 0);

    // A charset parameter is still JSON.
    const withCharset = await post({ 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ password: PASSWORD }));
    assert.equal(withCharset.status, 204);
});

test('a wrong, missing or non-text password is 401 wrong_password and sets no cookie', async (t) => {
    const { sessions, send, signIn } = await startApp(t);
    const post = (body, client) => send({
        headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-test-client': client },
        body: JSON.stringify(body),
    });
    const responses = [
        await signIn('wrong', { 'x-test-client': 'c1' }),
        await signIn(PASSWORD.slice(0, -1), { 'x-test-client': 'c1' }),
        await signIn(`${PASSWORD}x`, { 'x-test-client': 'c1' }),
        await signIn('', { 'x-test-client': 'c1' }),
        await post({}, 'c2'),
        await post({ password: null }, 'c2'),
        await post({ password: [PASSWORD] }, 'c2'),
        await post({ password: { toString: 'x' } }, 'c2'),
        await post([PASSWORD], 'c3'),
        await post({ Password: PASSWORD }, 'c3'),
    ];
    for (const response of responses) {
        assert.equal(response.status, 401);
        assert.deepEqual(response.json, { error: 'wrong_password' });
        assert.deepEqual(response.cookies, []);
        assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.equal(sessions.size, 0);
});

test('five failures in ten minutes block that client, right password included, until the window passes', async (t) => {
    const { clock, sessions, signIn } = await startApp(t);
    const asA = { 'x-test-client': 'client-a' };
    const asB = { 'x-test-client': 'client-b' };

    for (let attempt = 1; attempt <= 5; attempt += 1) {
        assert.equal((await signIn('wrong', asA)).status, 401, `attempt ${attempt}`);
        clock.advance(MINUTE);
    }
    // Failures at minutes 0 to 4; it is now minute 5. The oldest leaves the window at minute 10.
    const blocked = await signIn(PASSWORD, asA);
    assert.equal(blocked.status, 429);
    assert.deepEqual(blocked.json, { error: 'too_many_attempts', retryAfterSeconds: 300 });
    assert.equal(blocked.headers['retry-after'], '300');
    assert.deepEqual(blocked.cookies, []);
    assert.equal(sessions.size, 0, 'a blocked client was signed in');

    // Another client is not affected.
    assert.equal((await signIn('wrong', asB)).status, 401);
    assert.equal((await signIn(PASSWORD, asB)).status, 204);

    // Blocked attempts are not failures: they do not push the end of the block further out.
    clock.advance(4 * MINUTE);
    const stillBlocked = await signIn('wrong', asA);
    assert.equal(stillBlocked.status, 429);
    assert.equal(stillBlocked.headers['retry-after'], '60');
    clock.advance(MINUTE - 1);
    assert.equal((await signIn(PASSWORD, asA)).headers['retry-after'], '1');
    clock.advance(1);
    assert.equal((await signIn(PASSWORD, asA)).status, 204, 'still blocked after the window passed');
});

test('a successful sign-in clears that client\'s failures', async (t) => {
    const { signIn } = await startApp(t);
    for (let attempt = 0; attempt < 4; attempt += 1) assert.equal((await signIn('wrong')).status, 401);
    assert.equal((await signIn(PASSWORD)).status, 204);
    // Four more failures would have been eight without the reset.
    for (let attempt = 0; attempt < 4; attempt += 1) assert.equal((await signIn('wrong')).status, 401);
    assert.equal((await signIn(PASSWORD)).status, 204);
});

test('other clients failing, however often, never block a host who has not failed', async (t) => {
    const { clock, sessions, signIn } = await startApp(t);
    // Sixty failures from fifteen clients, four each, so none reaches its own limit of five. A limit across all
    // clients would let anyone lock the real host out by failing on purpose; the password is too long to guess.
    for (let client = 0; client < 15; client += 1) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            assert.equal((await signIn('wrong', { 'x-test-client': `attacker-${client}` })).status, 401);
            clock.advance(1000);
        }
    }
    assert.equal((await signIn(PASSWORD, { 'x-test-client': 'the-real-host' })).status, 204);
    assert.equal(sessions.size, 1);
    // Each attacker is still held to its own limit.
    assert.equal((await signIn('wrong', { 'x-test-client': 'attacker-0' })).status, 401);
    assert.equal((await signIn(PASSWORD, { 'x-test-client': 'attacker-0' })).status, 429);
});

test('neither the password tried nor the session id is ever logged', async (t) => {
    const logged = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
        t.mock.method(console, method, (...args) => { logged.push(args.map(String).join(' ')); });
    }
    const { signIn, send } = await startApp(t);
    const guess = 'a-guess-that-must-not-reach-the-log-0123456789';
    await signIn(guess);
    const signedIn = await signIn(PASSWORD);
    const id = sessionIdOf(signedIn);
    await send({ method: 'DELETE', headers: { origin: ORIGIN, cookie: `nextra_host=${id}` } });

    const all = logged.join('\n');
    assert.ok(logged.length >= 2, 'a failed and a successful sign-in are both logged');
    assert.ok(!all.includes(guess), 'the password that was tried was logged');
    assert.ok(!all.includes(PASSWORD), 'the host password was logged');
    assert.ok(!all.includes(id), 'the session id was logged');
    assert.match(all, /client-a/, 'the log does not say which client it was');
});

test('DELETE ends the session, clears the cookie and answers 204', async (t) => {
    const { sessions, signIn, send } = await startApp(t);
    const id = sessionIdOf(await signIn(PASSWORD));
    const other = sessionIdOf(await signIn(PASSWORD));

    const response = await send({ method: 'DELETE', headers: { origin: ORIGIN, cookie: `theme=dark; nextra_host=${id}` } });
    assert.equal(response.status, 204);
    assert.equal(response.text, '');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.cookies, ['nextra_host=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure']);
    assert.equal(sessions.isValid(id), false);
    assert.equal(sessions.isValid(other), true, 'signing out ended someone else\'s session');

    // Signing out twice, or without a session, is the same answer.
    for (const cookie of [`nextra_host=${id}`, 'nextra_host=garbage', undefined]) {
        const again = await send({ method: 'DELETE', headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
        assert.equal(again.status, 204);
        assert.equal(again.cookies.length, 1);
    }
    // Over plain HTTP (a local client) the clearing cookie matches the one that was set: no Secure.
    const plain = await send({ method: 'DELETE', headers: { origin: ORIGIN, 'x-test-insecure': '1' } });
    assert.deepEqual(plain.cookies, ['nextra_host=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0']);
    assert.equal(sessions.isValid(other), true);
});

test('another site cannot sign a host out', async (t) => {
    const { sessions, signIn, send } = await startApp(t);
    const id = sessionIdOf(await signIn(PASSWORD));
    for (const origin of ['https://attacker.example', undefined]) {
        const response = await send({ method: 'DELETE', headers: { ...(origin ? { origin } : {}), cookie: `nextra_host=${id}` } });
        assert.equal(response.status, 403);
        assert.deepEqual(response.json, { error: 'forbidden_origin' });
        assert.deepEqual(response.cookies, []);
    }
    assert.equal(sessions.isValid(id), true);
});

test('sign-out works when no host password is set, and other methods are not handled here', async (t) => {
    const { send } = await startApp(t, { token: '' });
    assert.equal((await send({ method: 'DELETE', headers: { origin: ORIGIN } })).status, 204);
    // The server's own /api 404 answers these; this bare app has none, so Express's default does.
    for (const method of ['GET', 'PUT', 'PATCH']) {
        assert.equal((await send({ method, headers: { origin: ORIGIN } })).status, 404, method);
    }
});
