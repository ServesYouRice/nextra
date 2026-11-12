// The host sign-in session store (lib/operatorSessions.js): what a session id is, how long it lives, how many
// there can be, and the cookie that carries it.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    OPERATOR_SESSION_COOKIE,
    OPERATOR_SESSION_TTL_MS,
    MAX_OPERATOR_SESSIONS,
    createOperatorSessions,
    readOperatorSessionIds,
    buildOperatorSessionCookie,
    buildClearedOperatorSessionCookie,
} = require('../lib/operatorSessions');

function fakeClock(start = 1_700_000_000_000) {
    let at = start;
    return {
        now: () => at,
        advance: (ms) => { at += ms; },
    };
}

test('the documented limits: a 12-hour lifetime, 32 sessions, a cookie named nextra_host', () => {
    assert.equal(OPERATOR_SESSION_TTL_MS, 12 * 60 * 60 * 1000);
    assert.equal(MAX_OPERATOR_SESSIONS, 32);
    assert.equal(OPERATOR_SESSION_COOKIE, 'nextra_host');
});

test('create returns 32 random bytes as base64url, different every time', () => {
    const sessions = createOperatorSessions();
    const ids = Array.from({ length: 50 }, () => sessions.create());
    for (const id of ids) {
        assert.match(id, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(Buffer.from(id, 'base64url').length, 32);
    }
    assert.equal(new Set(ids).size, ids.length);
});

test('create takes the id from the random source it is given, 32 bytes at a time', () => {
    const asked = [];
    const sessions = createOperatorSessions({
        randomBytes: (size) => {
            asked.push(size);
            return Buffer.alloc(size, 0xab);
        },
    });
    assert.equal(sessions.create(), Buffer.alloc(32, 0xab).toString('base64url'));
    assert.deepEqual(asked, [32]);
});

test('isValid accepts only an id the store created and still holds', () => {
    const sessions = createOperatorSessions();
    const id = sessions.create();
    assert.equal(sessions.isValid(id), true);
    assert.equal(sessions.isValid(id), true, 'a lookup must not use the session up');

    const other = createOperatorSessions().create();
    for (const candidate of [other, '', undefined, null, 42, {}, [id], id.slice(1), `${id}x`, ` ${id}`, id.toLowerCase() === id ? id.toUpperCase() : id.toLowerCase()]) {
        assert.equal(sessions.isValid(candidate), false, `accepted ${String(candidate)}`);
    }
});

test('revoke ends one session and leaves the others', () => {
    const sessions = createOperatorSessions();
    const first = sessions.create();
    const second = sessions.create();
    assert.equal(sessions.revoke(first), true);
    assert.equal(sessions.isValid(first), false);
    assert.equal(sessions.isValid(second), true);
    // Revoking again, or revoking something that never was a session, is a no-op.
    assert.equal(sessions.revoke(first), false);
    assert.equal(sessions.revoke('not-a-session'), false);
    assert.equal(sessions.revoke(undefined), false);
    assert.equal(sessions.size, 1);
});

test('a session ends 12 hours after it was created, however much it is used', () => {
    const clock = fakeClock();
    const sessions = createOperatorSessions({ now: clock.now });
    const id = sessions.create();

    // Used every hour: the lifetime is absolute, so use does not extend it.
    for (let hour = 1; hour < 12; hour += 1) {
        clock.advance(60 * 60 * 1000);
        assert.equal(sessions.isValid(id), true, `expired after ${hour} hours`);
    }
    clock.advance(60 * 60 * 1000 - 1);
    assert.equal(sessions.isValid(id), true, 'expired a millisecond early');
    clock.advance(1);
    assert.equal(sessions.isValid(id), false, 'still valid at 12 hours');
    assert.equal(sessions.size, 0, 'the expired session was kept');
    assert.equal(sessions.revoke(id), false);
});

test('expired sessions are pruned when a session is created and when the store is counted', () => {
    const clock = fakeClock();
    const sessions = createOperatorSessions({ now: clock.now, ttlMs: 1000 });
    sessions.create();
    sessions.create();
    clock.advance(600);
    const young = sessions.create();
    assert.equal(sessions.size, 3);
    clock.advance(500);
    // The first two are 1100 ms old, the third 500 ms.
    assert.equal(sessions.size, 1);
    const fresh = sessions.create();
    assert.equal(sessions.size, 2);
    assert.equal(sessions.isValid(young), true);
    assert.equal(sessions.isValid(fresh), true);
    sessions.prune();
    assert.equal(sessions.size, 2);
});

test('at most 32 sessions are live: one more drops the oldest', () => {
    const clock = fakeClock();
    const sessions = createOperatorSessions({ now: clock.now });
    const ids = [];
    for (let index = 0; index < MAX_OPERATOR_SESSIONS; index += 1) {
        ids.push(sessions.create());
        clock.advance(1000);
    }
    assert.equal(sessions.size, 32);
    assert.ok(ids.every((id) => sessions.isValid(id)));

    const extra = sessions.create();
    assert.equal(sessions.size, 32);
    assert.equal(sessions.isValid(ids[0]), false, 'the oldest session survived the cap');
    assert.ok(ids.slice(1).every((id) => sessions.isValid(id)), 'a session other than the oldest was dropped');
    assert.equal(sessions.isValid(extra), true);

    // A revoked session frees its place: the next sign-in drops nobody.
    sessions.revoke(ids[5]);
    const afterRevoke = sessions.create();
    assert.equal(sessions.size, 32);
    assert.equal(sessions.isValid(ids[1]), true);
    assert.equal(sessions.isValid(afterRevoke), true);
});

test('a small cap is honoured too', () => {
    const sessions = createOperatorSessions({ maxSessions: 2 });
    const [a, b, c] = [sessions.create(), sessions.create(), sessions.create()];
    assert.deepEqual([a, b, c].map((id) => sessions.isValid(id)), [false, true, true]);
});

test('the store never logs a session id', (t) => {
    const logged = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
        t.mock.method(console, method, (...args) => { logged.push(args.join(' ')); });
    }
    const clock = fakeClock();
    const sessions = createOperatorSessions({ now: clock.now, maxSessions: 2 });
    const ids = [sessions.create(), sessions.create(), sessions.create()];
    ids.forEach((id) => sessions.isValid(id));
    sessions.revoke(ids[1]);
    clock.advance(OPERATOR_SESSION_TTL_MS);
    sessions.prune();
    sessions.isValid(ids[2]);
    assert.deepEqual(logged, []);
});

test('readOperatorSessionIds finds the session cookie among others', () => {
    const id = createOperatorSessions().create();
    const other = createOperatorSessions().create();
    assert.deepEqual(readOperatorSessionIds(`nextra_host=${id}`), [id]);
    assert.deepEqual(readOperatorSessionIds(`theme=dark; nextra_host=${id}; lang=en`), [id]);
    assert.deepEqual(readOperatorSessionIds(`theme=dark;nextra_host=${id}`), [id]);
    assert.deepEqual(readOperatorSessionIds(`  nextra_host = ${id} `), [id]);
    // Every value under the name, in order, once each: a stale cookie must not hide the live one.
    assert.deepEqual(readOperatorSessionIds(`nextra_host=${other}; nextra_host=${id}; nextra_host=${other}`), [other, id]);
    assert.deepEqual(readOperatorSessionIds([`nextra_host=${id}`, `nextra_host=${other}`]), [id, other]);
});

test('readOperatorSessionIds ignores other cookies and values that are not session ids', () => {
    const id = createOperatorSessions().create();
    for (const header of [
        undefined, null, '', 42, {},
        'theme=dark',
        'nextra_host',
        'nextra_host=',
        'nextra_host=short',
        `nextra_host=${id}extra`,
        `nextra_host="${id}"`,
        `nextra_hostx=${id}`,
        `xnextra_host=${id}`,
        `NEXTRA_HOST=${id}`,
        `other=nextra_host=${id}`,
    ]) {
        assert.deepEqual(readOperatorSessionIds(header), [], `read a session from ${String(header)}`);
    }
});

test('the session cookie is HttpOnly, SameSite=Strict, site-wide and 12 hours long, and Secure over HTTPS only', () => {
    const id = createOperatorSessions().create();
    assert.equal(
        buildOperatorSessionCookie(id),
        `nextra_host=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    );
    assert.equal(
        buildOperatorSessionCookie(id, { secure: true }),
        `nextra_host=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200; Secure`,
    );
    assert.equal(buildOperatorSessionCookie(id, { secure: false }), buildOperatorSessionCookie(id));
});

test('the clearing cookie removes it under the same path', () => {
    assert.equal(buildClearedOperatorSessionCookie(), 'nextra_host=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    assert.equal(
        buildClearedOperatorSessionCookie({ secure: true }),
        'nextra_host=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure',
    );
});
