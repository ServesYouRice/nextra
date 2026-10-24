const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { __testing } = require('../lib/tunnel');

const { launchCloudflaredCandidate } = __testing;

function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.signals = [];
    child.kill = (signal) => {
        child.signals.push(signal);
        child.signalCode = signal;
        return true;
    };
    return child;
}

function launch(child, timeoutMs = 5000) {
    return launchCloudflaredCandidate('cloudflared', ['tunnel'], timeoutMs, { spawn: () => child });
}

function nextTurn() {
    return new Promise((resolve) => setImmediate(resolve));
}

async function emit(stream, text) {
    stream.write(text);
    await nextTurn();
}

// Resolves with 'pending' when the launch has not settled once the streams have drained.
async function settledState(promise) {
    await nextTurn();
    return Promise.race([
        promise.then((value) => ({ value }), (error) => ({ error })),
        nextTurn().then(() => 'pending'),
    ]);
}

// Fails the test, instead of hanging it, when the launch did not resolve.
async function resolved(promise) {
    const state = await settledState(promise);
    assert.notEqual(state, 'pending', 'the launch is still waiting for a public URL');
    assert.equal(state.error, undefined, state.error && state.error.message);
    return state.value;
}

test('a trycloudflare URL split across two stdout chunks is recognized', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const launched = launch(child);

    await emit(child.stdout, 'INF |  https://abc-');
    assert.equal(await settledState(launched), 'pending', 'an incomplete URL prefix must not resolve');
    await emit(child.stdout, 'def.trycloudflare.com\n');

    const tunnel = await resolved(launched);
    assert.equal(tunnel.baseUrl, 'https://abc-def.trycloudflare.com');
    assert.equal(tunnel.process, child);
    assert.equal(tunnel.command, 'cloudflared');
});

test('a trycloudflare URL split across two stderr chunks is recognized', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const launched = launch(child);

    await emit(child.stderr, '2026-10-24T10:00:00Z INF |  https://quiet-river-');
    await emit(child.stderr, 'one-two.trycloudflare.com  |\n');

    assert.equal((await resolved(launched)).baseUrl, 'https://quiet-river-one-two.trycloudflare.com');
});

test('a URL cut at the domain suffix resolves only once it is complete', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const launched = launch(child);

    await emit(child.stderr, 'https://abc-def.trycloudflare.co');
    assert.equal(await settledState(launched), 'pending');
    await emit(child.stderr, 'm\n');

    assert.equal((await resolved(launched)).baseUrl, 'https://abc-def.trycloudflare.com');
});

test('a URL spread over many one-character chunks is recognized', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const launched = launch(child);

    for (const character of 'noise https://a-b-c.trycloudflare.com ok') {
        await emit(child.stdout, character);
    }

    assert.equal((await resolved(launched)).baseUrl, 'https://a-b-c.trycloudflare.com');
});

test('a split URL resolves to the lowercase URL', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const launched = launch(child);

    await emit(child.stdout, 'HTTPS://ABC-');
    await emit(child.stdout, 'DEF.TryCloudflare.COM\n');

    assert.equal((await resolved(launched)).baseUrl, 'https://abc-def.trycloudflare.com');
});

test('a URL contained in one chunk is still recognized', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const launched = launch(child);

    await emit(child.stderr, 'INF |  https://one-chunk.trycloudflare.com  |\n');

    assert.equal((await resolved(launched)).baseUrl, 'https://one-chunk.trycloudflare.com');
});

test('the scanned text is kept per stream: stdout and stderr halves never join', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const launched = launch(child, 1000);
    const outcome = launched.then((value) => ({ value }), (error) => ({ error }));

    await emit(child.stdout, 'https://abc-');
    await emit(child.stderr, 'def.trycloudflare.com\n');
    await emit(child.stdout, 'x');
    assert.equal(await settledState(launched), 'pending');

    t.mock.timers.tick(1000);
    const { error } = await outcome;
    assert.match(error.message, /did not return a public URL within 1000ms/);
});

test('the scanned tail is bounded: a prefix older than the bound is forgotten', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { URL_SCAN_TAIL_CHARS } = __testing;
    assert.ok(Number.isInteger(URL_SCAN_TAIL_CHARS) && URL_SCAN_TAIL_CHARS >= 128 && URL_SCAN_TAIL_CHARS <= 4096);

    const child = fakeChild();
    const launched = launch(child, 1000);
    const outcome = launched.then((value) => ({ value }), (error) => ({ error }));

    await emit(child.stdout, `https://${'a'.repeat(URL_SCAN_TAIL_CHARS)}`);
    await emit(child.stdout, '.trycloudflare.com\n');
    assert.equal(await settledState(launched), 'pending');

    t.mock.timers.tick(1000);
    const { error } = await outcome;
    assert.match(error.message, /did not return a public URL/);
});

test('a URL is found after a large amount of earlier output', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const launched = launch(child);

    await emit(child.stderr, `${'log line without a link\n'.repeat(5000)}https://late-`);
    await emit(child.stderr, 'url.trycloudflare.com\n');

    assert.equal((await resolved(launched)).baseUrl, 'https://late-url.trycloudflare.com');
});

test('output without a URL times out, stops the child and rejects', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const launched = launch(child, 2000);
    const outcome = launched.then((value) => ({ value }), (error) => ({ error }));

    await emit(child.stdout, 'INF Starting tunnel\n');
    await emit(child.stderr, 'INF Requesting new quick Tunnel on trycloudflare.com...\n');
    t.mock.timers.tick(2000);

    const { error } = await outcome;
    assert.equal(error.message, 'cloudflared did not return a public URL within 2000ms');
    assert.deepEqual(child.signals, ['SIGTERM']);
});

test('the timeout does not fire after a split URL was recognized', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const launched = launch(child, 2000);

    await emit(child.stdout, 'https://abc-');
    await emit(child.stdout, 'def.trycloudflare.com\n');
    const tunnel = await resolved(launched);
    t.mock.timers.tick(5000);

    assert.deepEqual(child.signals, []);
    tunnel.stop();
    assert.deepEqual(child.signals, ['SIGTERM']);
});

test('an exit before any URL rejects with the exit code', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const launched = launch(child);
    const outcome = launched.then((value) => ({ value }), (error) => ({ error }));

    await emit(child.stdout, 'https://abc-');
    child.emit('exit', 1, null);

    const { error } = await outcome;
    assert.equal(error.message, 'cloudflared exited before publishing tunnel URL (code=1, signal=none)');
});

test('output after the URL is only logged, and only when DEBUG_TUNNEL is set', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const warnings = [];
    t.mock.method(console, 'warn', (message) => { warnings.push(message); });
    const before = process.env.DEBUG_TUNNEL;
    t.after(() => {
        if (before === undefined) delete process.env.DEBUG_TUNNEL;
        else process.env.DEBUG_TUNNEL = before;
    });
    process.env.DEBUG_TUNNEL = '1';

    const child = fakeChild();
    const launched = launch(child);
    await emit(child.stderr, 'https://abc-');
    await emit(child.stderr, 'def.trycloudflare.com\n');
    await resolved(launched);
    assert.deepEqual(warnings, []);

    await emit(child.stdout, '  connection registered\n');
    await emit(child.stderr, 'https://abc-');
    assert.deepEqual(warnings, ['[tunnel-debug] connection registered', '[tunnel-debug] https://abc-']);

    delete process.env.DEBUG_TUNNEL;
    await emit(child.stdout, 'silent\n');
    assert.equal(warnings.length, 2);
});
