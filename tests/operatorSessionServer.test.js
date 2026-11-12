// Host sign-in on the real server: a host on another computer trades the host password (OPERATOR_TOKEN) for a
// session cookie at POST /api/operator/session, and that session then authorizes wherever the operator token or a
// local client does: /api/config's flags, /api/metrics, the TURN mint route and room creation over Socket.IO.
//
// The remote host arrives the way a reverse proxy relays it: from loopback, addressed to SHARE_BASE_URL, with
// X-Forwarded-For and X-Forwarded-Proto. tests/operatorSignIn.test.js covers the routes' rules with a fake clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io: createSocketClient } = require('socket.io-client');
const { claimServerPorts } = require('./serverPorts');

const projectRoot = path.resolve(__dirname, '..');
const PASSWORD = 'operator-session-host-password-0123456789abcdef';
const SHARE = 'https://stream.example.com';
const SHARE_HOST = 'stream.example.com';
// Allowed for sockets and the TURN route (EXTRA_ALLOWED_ORIGINS), but neither this server's origin nor a share origin.
const OTHER_ALLOWED_ORIGIN = 'https://tools.example.org';
const SESSION_COOKIE = /^nextra_host=([A-Za-z0-9_-]{43}); HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200(; Secure)?$/;

function startFakeCloudflare() {
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                iceServers: [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'turn-user', credential: 'turn-credential' }],
            }));
        });
    });
    return new Promise((resolve) => {
        upstream.listen(0, '127.0.0.1', () => resolve({
            baseUrl: `http://127.0.0.1:${upstream.address().port}`,
            close: () => new Promise((done) => upstream.close(done)),
        }));
    });
}

async function startServer(t, env = {}) {
    const { port, rtcPort } = await claimServerPorts();
    const baseUrl = `http://127.0.0.1:${port}`;
    const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nextra-operator-session-dist-'));
    await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><div id="root"></div>');
    let output = '';
    const child = spawn(process.execPath, ['server.js'], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            NODE_ENV: 'test',
            APP_ENV: 'test',
            PORT: String(port),
            BIND_HOST: '127.0.0.1',
            LAN_IP: '127.0.0.1',
            RTC_LISTEN_IP: '127.0.0.1',
            RTC_MIN_PORT: String(rtcPort),
            RTC_MAX_PORT: String(rtcPort),
            LOCAL_HTTPS: 'false',
            OPEN_BROWSER: 'false',
            AUTO_DETECT_PUBLIC_IP: 'false',
            AUTO_PUBLIC_TUNNEL: 'false',
            CLOUDFLARED_TUNNEL_TOKEN: '',
            SHARE_BASE_URL: SHARE,
            EXTRA_ALLOWED_ORIGINS: OTHER_ALLOWED_ORIGIN,
            WHIP_ENABLED: 'false',
            WHEP_ENABLED: 'false',
            OPERATOR_TOKEN: PASSWORD,
            OPERATOR_HOSTNAMES: '',
            TRUSTED_LAN_CIDRS: '',
            TRUSTED_PROXY_CIDRS: '',
            TRUST_PROXY: '',
            TRUST_X_FORWARDED_HEADERS: 'false',
            TRUST_CLOUDFLARE_CONNECTING_IP: 'false',
            NEXTRA_SMOKE_TEST: '1',
            NEXTRA_TEST_DIST_DIR: distDir,
            LOG_LEVEL: 'info',
            ...env,
        },
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    t.after(async () => {
        if (child.exitCode === null) {
            child.kill();
            await new Promise((resolve) => child.once('exit', resolve));
        }
        await fs.rm(distDir, { recursive: true, force: true });
    });
    const deadline = Date.now() + 25_000;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`server exited before readiness (code ${child.exitCode})\n${output}`);
        try {
            if ((await fetch(`${baseUrl}/readyz`)).ok) break;
        } catch {
            // The listener may not exist yet while mediasoup initializes.
        }
        if (Date.now() > deadline) throw new Error(`server did not become ready\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    /** A request from this machine with exactly these headers; fetch() cannot set Host, which a proxy forwards. */
    function send({ method = 'GET', pathname, headers = {}, body } = {}) {
        return new Promise((resolve, reject) => {
            const request = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (response) => {
                let text = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => { text += chunk; });
                response.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(text); } catch { /* an empty body */ }
                    resolve({ status: response.statusCode, headers: response.headers, json, cookies: response.headers['set-cookie'] || [] });
                });
            });
            request.once('error', reject);
            request.end(body);
        });
    }

    return { port, baseUrl, send, getOutput: () => output };
}

/** What a reverse proxy in front of SHARE_BASE_URL sends for a visitor at `client`. */
function viaShare(client, extra = {}) {
    return { host: SHARE_HOST, 'x-forwarded-for': client, 'x-forwarded-proto': 'https', ...extra };
}

function connectSocket(baseUrl, extraHeaders) {
    return new Promise((resolve, reject) => {
        const socket = createSocketClient(baseUrl, { transports: ['websocket'], extraHeaders, reconnection: false, timeout: 5_000 });
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', (err) => {
            socket.close();
            reject(err);
        });
    });
}

function socketRequest(socket, event, payload = {}) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), 5_000);
        socket.emit(event, payload, (response) => {
            clearTimeout(timeout);
            resolve(response);
        });
    });
}

test('a remote host signs in with the host password and the session authorizes requests and sockets', { concurrency: false, timeout: 90_000 }, async (t) => {
    const cloudflare = await startFakeCloudflare();
    t.after(() => cloudflare.close());
    const { port, baseUrl, send, getOutput } = await startServer(t, {
        CLOUDFLARE_TURN_KEY_ID: 'operator-session-test-key',
        CLOUDFLARE_TURN_API_TOKEN: 'operator-session-test-token',
        CLOUDFLARE_TURN_API_BASE_URL: cloudflare.baseUrl,
    });
    const sockets = [];
    t.after(() => sockets.forEach((socket) => socket.close()));
    const local = { host: `127.0.0.1:${port}` };
    const signIn = (password, headers) => send({
        method: 'POST',
        pathname: '/api/operator/session',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ password }),
    });
    const configFor = async (headers) => (await send({ pathname: '/api/config', headers })).json;
    const metrics = async (headers) => (await send({ pathname: '/api/metrics', headers })).status;
    const mint = async (headers) => (await send({ method: 'POST', pathname: '/api/cloudflare-turn-credentials', headers })).status;

    // --- Before anyone signs in ---------------------------------------------------------------------------------
    // The host's own browser: operator rights, no sign-in offered, no session.
    const localConfig = await configFor(local);
    assert.equal(localConfig.operatorAuthorized, true);
    assert.equal(localConfig.operatorSignInAvailable, false);
    assert.equal(localConfig.operatorSession, false);
    assert.equal(localConfig.cloudflareTurnAutofillAvailable, true);
    // A visitor through the proxy: no rights, sign-in offered.
    const visitorResponse = await send({ pathname: '/api/config', headers: viaShare('203.0.113.10') });
    assert.equal(visitorResponse.headers['cache-control'], 'no-store');
    assert.equal(visitorResponse.json.operatorAuthorized, false);
    assert.equal(visitorResponse.json.operatorSignInAvailable, true);
    assert.equal(visitorResponse.json.operatorSession, false);
    assert.equal(visitorResponse.json.cloudflareTurnAutofillAvailable, false);
    // The password is in no response; the flags are all a client can tell.
    assert.ok(!JSON.stringify(visitorResponse.json).includes(PASSWORD));
    assert.equal(Object.hasOwn(visitorResponse.json, 'operatorToken'), false);
    // The operator token header still works, and is not a session.
    const tokenConfig = await configFor(viaShare('203.0.113.10', { 'x-nextra-operator-token': PASSWORD }));
    assert.equal(tokenConfig.operatorAuthorized, true);
    assert.equal(tokenConfig.operatorSession, false);
    assert.equal(await metrics(viaShare('203.0.113.10')), 403);

    // --- Refusals -----------------------------------------------------------------------------------------------
    // Plain HTTP: the proxy did not say https.
    const plain = await signIn(PASSWORD, { host: SHARE_HOST, 'x-forwarded-for': '203.0.113.11', origin: SHARE });
    assert.equal(plain.status, 400);
    assert.deepEqual(plain.json, { error: 'https_required' });
    assert.deepEqual(plain.cookies, []);
    // "https" from a proxy whose headers are not trusted (no share address, TRUST_X_FORWARDED_HEADERS off) is not HTTPS.
    const claimedHttps = await signIn(PASSWORD, { ...local, 'x-forwarded-for': '203.0.113.12', 'x-forwarded-proto': 'https', origin: baseUrl });
    assert.equal(claimedHttps.status, 400);
    assert.deepEqual(claimedHttps.json, { error: 'https_required' });
    // Another site, or no Origin at all.
    for (const origin of ['https://attacker.example', OTHER_ALLOWED_ORIGIN, 'http://stream.example.com', undefined]) {
        const crossOrigin = await signIn(PASSWORD, viaShare('203.0.113.13', origin ? { origin } : {}));
        assert.equal(crossOrigin.status, 403, `origin ${origin}`);
        assert.deepEqual(crossOrigin.json, { error: 'forbidden_origin' });
        assert.deepEqual(crossOrigin.cookies, []);
    }
    // Not JSON: what a cross-site HTML form could send.
    const form = await send({
        method: 'POST',
        pathname: '/api/operator/session',
        headers: viaShare('203.0.113.14', { origin: SHARE, 'content-type': 'application/x-www-form-urlencoded' }),
        body: `password=${PASSWORD}`,
    });
    assert.equal(form.status, 415);
    // Wrong password.
    const wrong = await signIn('not-the-host-password', viaShare('203.0.113.15', { origin: SHARE }));
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.json, { error: 'wrong_password' });
    assert.deepEqual(wrong.cookies, []);
    assert.equal(wrong.headers['cache-control'], 'no-store');
    // Only POST and DELETE exist.
    const getSession = await send({ pathname: '/api/operator/session', headers: viaShare('203.0.113.15') });
    assert.equal(getSession.status, 404);
    assert.deepEqual(getSession.json, { error: 'Not found' });

    // --- The failure limit follows the forwarded client, not the proxy ----------------------------------------
    for (let attempt = 1; attempt <= 5; attempt += 1) {
        assert.equal((await signIn('guess', viaShare('203.0.113.20', { origin: SHARE }))).status, 401, `failure ${attempt}`);
    }
    const limited = await signIn(PASSWORD, viaShare('203.0.113.20', { origin: SHARE }));
    assert.equal(limited.status, 429, 'the sixth attempt was let through');
    assert.equal(limited.json.error, 'too_many_attempts');
    const retryAfter = Number(limited.headers['retry-after']);
    assert.ok(retryAfter > 590 && retryAfter <= 600, `Retry-After ${limited.headers['retry-after']} is not about ten minutes`);
    assert.equal(limited.json.retryAfterSeconds, retryAfter);
    assert.deepEqual(limited.cookies, []);
    // A spoofed leftmost X-Forwarded-For entry is no new identity.
    assert.equal((await signIn(PASSWORD, viaShare('198.51.100.1, 203.0.113.20', { origin: SHARE }))).status, 429);
    // Every client arrives from the same proxy address; another one is not blocked.
    assert.equal((await signIn('guess', viaShare('203.0.113.21', { origin: SHARE }))).status, 401);

    // --- Sign-in ------------------------------------------------------------------------------------------------
    const signedIn = await signIn(PASSWORD, viaShare('203.0.113.30', { origin: SHARE }));
    assert.equal(signedIn.status, 204);
    assert.equal(signedIn.headers['cache-control'], 'no-store');
    assert.equal(signedIn.cookies.length, 1);
    const cookieMatch = SESSION_COOKIE.exec(signedIn.cookies[0]);
    assert.ok(cookieMatch, `unexpected Set-Cookie: ${signedIn.cookies[0]}`);
    assert.equal(cookieMatch[2], '; Secure', 'a session set over HTTPS must be Secure');
    const sessionId = cookieMatch[1];
    const cookie = `nextra_host=${sessionId}`;

    // The session authorizes requests.
    const hostConfig = await configFor(viaShare('203.0.113.30', { cookie }));
    assert.equal(hostConfig.operatorAuthorized, true);
    assert.equal(hostConfig.operatorSignInAvailable, true);
    assert.equal(hostConfig.operatorSession, true);
    assert.equal(hostConfig.cloudflareTurnAutofillAvailable, true);
    assert.equal(await metrics(viaShare('203.0.113.30', { cookie })), 200);
    assert.equal(await metrics(viaShare('203.0.113.30', { cookie, origin: SHARE })), 200);
    assert.equal(await metrics(viaShare('203.0.113.30', { cookie: `theme=dark; ${cookie}; lang=en` })), 200);
    // A read that names another origin is refused; so is a cookie that is no session.
    assert.equal(await metrics(viaShare('203.0.113.30', { cookie, origin: 'https://attacker.example' })), 403);
    assert.equal(await metrics(viaShare('203.0.113.30', { cookie: `nextra_host=${'A'.repeat(43)}` })), 403);
    assert.equal(await metrics(viaShare('203.0.113.30', { cookie: `other=${sessionId}` })), 403);
    // What the browser itself says about the request counts too: a page on a sibling subdomain is the same site,
    // so SameSite=Strict lets the cookie through, but it is not this server's page.
    assert.equal(await metrics(viaShare('203.0.113.30', { cookie, 'sec-fetch-site': 'same-origin' })), 200);
    assert.equal(await metrics(viaShare('203.0.113.30', { cookie, 'sec-fetch-site': 'none' })), 200);
    assert.equal(await metrics(viaShare('203.0.113.30', { cookie, 'sec-fetch-site': 'same-site' })), 403, 'a same-site page read operator metrics with the session');
    assert.equal(await metrics(viaShare('203.0.113.30', { cookie, 'sec-fetch-site': 'cross-site' })), 403);
    // The operator token is a secret the caller holds, so it is not subject to this.
    assert.equal(await metrics(viaShare('203.0.113.30', { 'x-nextra-operator-token': PASSWORD, 'sec-fetch-site': 'cross-site' })), 200);
    const crossOriginConfig = await configFor(viaShare('203.0.113.30', { cookie, origin: 'https://attacker.example' }));
    assert.equal(crossOriginConfig.operatorAuthorized, false);
    assert.equal(crossOriginConfig.operatorSession, false);

    // The TURN mint route changes state, so a session alone needs the same-origin proof.
    assert.equal(await mint(viaShare('203.0.113.31', { origin: SHARE })), 403, 'minted without any authorization');
    assert.equal(await mint(viaShare('203.0.113.32', { cookie })), 403, 'a session without Origin minted TURN credentials');
    assert.equal(await mint(viaShare('203.0.113.33', { cookie, origin: 'https://attacker.example' })), 403);
    assert.equal(await mint(viaShare('203.0.113.34', { cookie, origin: OTHER_ALLOWED_ORIGIN })), 403, 'a session rode an origin that is not this server\'s');
    assert.equal(await mint(viaShare('203.0.113.37', { cookie, origin: SHARE, 'sec-fetch-site': 'same-site' })), 403);
    assert.equal(await mint(viaShare('203.0.113.35', { cookie, origin: SHARE })), 200);
    // The operator token keeps the rule it had: any allowed origin.
    assert.equal(await mint(viaShare('203.0.113.36', { 'x-nextra-operator-token': PASSWORD, origin: OTHER_ALLOWED_ORIGIN })), 200);

    // The session authorizes a socket whose handshake carries it, from this server's page only.
    const hostSocket = await connectSocket(baseUrl, { Origin: SHARE, Cookie: cookie, 'x-forwarded-for': '203.0.113.40', 'x-forwarded-proto': 'https' });
    sockets.push(hostSocket);
    const created = await socketRequest(hostSocket, 'create-room', { ingestMode: 'browser' });
    assert.equal(created.success, true, `a signed-in host could not create a room: ${created.error}`);

    const noCookie = await connectSocket(baseUrl, { Origin: SHARE, 'x-forwarded-for': '203.0.113.41', 'x-forwarded-proto': 'https' });
    sockets.push(noCookie);
    const deniedNoCookie = await socketRequest(noCookie, 'create-room', { ingestMode: 'browser' });
    assert.equal(deniedNoCookie.success, false);
    assert.match(deniedNoCookie.error, /Operator authorization/);

    const badCookie = await connectSocket(baseUrl, { Origin: SHARE, Cookie: `nextra_host=${'B'.repeat(43)}`, 'x-forwarded-for': '203.0.113.42' });
    sockets.push(badCookie);
    assert.equal((await socketRequest(badCookie, 'create-room', { ingestMode: 'browser' })).success, false);

    // An allowed socket origin that is not this server's own: the handshake is accepted, the cookie is not.
    const otherOrigin = await connectSocket(baseUrl, {
        Origin: OTHER_ALLOWED_ORIGIN, Cookie: cookie, 'x-forwarded-for': '203.0.113.43', 'x-forwarded-proto': 'https', 'x-forwarded-host': SHARE_HOST,
    });
    sockets.push(otherOrigin);
    const deniedOtherOrigin = await socketRequest(otherOrigin, 'create-room', { ingestMode: 'browser' });
    assert.equal(deniedOtherOrigin.success, false, 'a session authorized a socket opened from another origin');
    assert.match(deniedOtherOrigin.error, /Operator authorization/);
    // The token in the payload still works there, as before.
    assert.equal((await socketRequest(otherOrigin, 'create-room', { ingestMode: 'browser', operatorToken: PASSWORD })).success, true);

    // --- A local client -----------------------------------------------------------------------------------------
    // It needs no session, may sign in over plain HTTP, and its rights are not "from a session".
    const localSignIn = await signIn(PASSWORD, { ...local, origin: baseUrl });
    assert.equal(localSignIn.status, 204);
    const localCookieMatch = SESSION_COOKIE.exec(localSignIn.cookies[0]);
    assert.ok(localCookieMatch, `unexpected Set-Cookie: ${localSignIn.cookies[0]}`);
    assert.equal(localCookieMatch[2], undefined, 'a cookie set over plain HTTP must not be Secure');
    const localWithSession = await configFor({ ...local, cookie: `nextra_host=${localCookieMatch[1]}` });
    assert.equal(localWithSession.operatorAuthorized, true);
    assert.equal(localWithSession.operatorSession, false);
    assert.equal(localWithSession.operatorSignInAvailable, false);

    // --- Sign-out -----------------------------------------------------------------------------------------------
    const signOut = (headers) => send({ method: 'DELETE', pathname: '/api/operator/session', headers });
    // Another site cannot end the session.
    const crossSignOut = await signOut(viaShare('203.0.113.30', { cookie, origin: 'https://attacker.example' }));
    assert.equal(crossSignOut.status, 403);
    assert.equal(await metrics(viaShare('203.0.113.30', { cookie })), 200);

    const signedOut = await signOut(viaShare('203.0.113.30', { cookie, origin: SHARE }));
    assert.equal(signedOut.status, 204);
    assert.deepEqual(signedOut.cookies, ['nextra_host=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure']);
    assert.equal(await metrics(viaShare('203.0.113.30', { cookie })), 403, 'the session survived sign-out');
    const afterSignOut = await configFor(viaShare('203.0.113.30', { cookie }));
    assert.equal(afterSignOut.operatorAuthorized, false);
    assert.equal(afterSignOut.operatorSession, false);
    // The socket that was opened with the session loses its rights with it; the room it made is not touched.
    const afterSignOutRoom = await socketRequest(hostSocket, 'create-room', { ingestMode: 'browser' });
    assert.equal(afterSignOutRoom.success, false, 'a socket kept operator rights after its session was signed out');
    assert.match(afterSignOutRoom.error, /Operator authorization/);
    // The other session (the local client's) is its own.
    assert.equal(await metrics(viaShare('203.0.113.30', { cookie: `nextra_host=${localCookieMatch[1]}` })), 200);

    // --- Nothing secret reached the log -------------------------------------------------------------------------
    const output = getOutput();
    assert.ok(!output.includes(PASSWORD), 'the host password was logged');
    assert.ok(!output.includes('not-the-host-password'), 'a password that was tried was logged');
    assert.ok(!output.includes(sessionId) && !output.includes(localCookieMatch[1]), 'a session id was logged');
    assert.match(output, /Host sign-in failed for 203\.0\.113\.15/);
    assert.match(output, /Host signed in from 203\.0\.113\.30/);
});

test('without OPERATOR_TOKEN there is no host sign-in: 409, and the page is told it is unavailable', { concurrency: false, timeout: 60_000 }, async (t) => {
    const { port, send } = await startServer(t, { OPERATOR_TOKEN: '' });
    const response = await send({
        method: 'POST',
        pathname: '/api/operator/session',
        headers: viaShare('203.0.113.50', { origin: SHARE, 'content-type': 'application/json' }),
        body: JSON.stringify({ password: '' }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(response.json, { error: 'not_configured' });
    assert.deepEqual(response.cookies, []);

    const visitor = (await send({ pathname: '/api/config', headers: viaShare('203.0.113.50') })).json;
    assert.equal(visitor.operatorAuthorized, false);
    assert.equal(visitor.operatorSignInAvailable, false);
    assert.equal(visitor.operatorSession, false);
    // A cookie shaped like a session is nothing here.
    const withCookie = (await send({ pathname: '/api/config', headers: viaShare('203.0.113.50', { cookie: `nextra_host=${'C'.repeat(43)}` }) })).json;
    assert.equal(withCookie.operatorAuthorized, false);
    assert.equal((await send({ pathname: '/api/metrics', headers: viaShare('203.0.113.50', { cookie: `nextra_host=${'C'.repeat(43)}` }) })).status, 403);

    // The host's own browser is what it always was.
    const localConfig = (await send({ pathname: '/api/config', headers: { host: `127.0.0.1:${port}` } })).json;
    assert.equal(localConfig.operatorAuthorized, true);
    assert.equal(localConfig.operatorSignInAvailable, false);
    assert.equal(localConfig.operatorSession, false);
    assert.equal((await send({ pathname: '/api/metrics', headers: { host: `127.0.0.1:${port}` } })).status, 200);
});
