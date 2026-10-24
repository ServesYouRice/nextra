'use strict';

// scripts/smoke-packaged.js talks to a packaged executable over HTTP. Every one of those
// calls must be bounded by its timeout across the response headers AND the body: fetch
// resolves once the headers arrive, so a server that sends headers and then stalls used to
// leave a stage pending forever, and the cleanup after the stages never ran.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const smoke = require('../scripts/smoke-packaged.js');

// The checkout may use CRLF line endings; the source scan below looks for "\n".
const scriptSource = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'smoke-packaged.js'), 'utf8')
    .split('\r\n').join('\n');

// Slack on top of the timeout for a slow, busy machine. A stalled read that is not bounded
// never comes back at all, so the margin only has to be far below "forever".
const MARGIN_MS = 2000;

const sockets = new Set();

const server = http.createServer((req, res) => {
    switch (req.url) {
    case '/ok-json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready' }));
        return;
    case '/missing-json':
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'nope' }));
        return;
    case '/ok-text':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<div id="root"></div>');
        return;
    case '/not-json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('<html>');
        return;
    case '/headers-only-then-stall':
        // Headers go out at once; the body never starts and never ends.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.flushHeaders();
        return;
    case '/partial-body-then-stall':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"status":');
        return;
    case '/no-headers':
        // Not even the headers arrive.
        return;
    default:
        res.writeHead(404);
        res.end();
    }
});
server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
});

let baseUrl;

test.before(async () => {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
});

async function timed(promise) {
    const startedAt = Date.now();
    try {
        return { value: await promise, ms: Date.now() - startedAt };
    } catch (error) {
        return { error, ms: Date.now() - startedAt };
    }
}

test('requiring smoke-packaged.js exports its helpers and does not run the smoke', async () => {
    for (const name of [
        'fetchWithTimeout', 'isReadyBody', 'waitReady', 'checkStaticShell', 'checkSocketHandshake',
        'checkPackageInfo', 'checkMediaWorkerReplacement', 'checkGracefulShutdown', 'runStages', 'cleanup', 'main',
    ]) {
        assert.equal(typeof smoke[name], 'function', name);
    }
    // main() would reject here (there is no packaged executable) and set a failing exit code.
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(process.exitCode, 1);
});

test('fetchWithTimeout returns the status, ok flag and parsed body of a finished response', async () => {
    const json = await smoke.fetchWithTimeout(`${baseUrl}/ok-json`, {}, 2000, 'json');
    assert.deepEqual(json, { status: 200, ok: true, body: { status: 'ready' } });

    const missing = await smoke.fetchWithTimeout(`${baseUrl}/missing-json`, {}, 2000, 'json');
    assert.deepEqual(missing, { status: 404, ok: false, body: { error: 'nope' } });

    const text = await smoke.fetchWithTimeout(`${baseUrl}/ok-text`, {}, 2000, 'text');
    assert.deepEqual(text, { status: 200, ok: true, body: '<div id="root"></div>' });

    const none = await smoke.fetchWithTimeout(`${baseUrl}/ok-json`, {}, 2000, 'none');
    assert.deepEqual(none, { status: 200, ok: true, body: null });

    // The read mode defaults to 'none', and the options (method) still reach fetch.
    const post = await smoke.fetchWithTimeout(`${baseUrl}/ok-json`, { method: 'POST' }, 2000);
    assert.deepEqual(post, { status: 200, ok: true, body: null });
});

test('fetchWithTimeout rejects a body that is not JSON, as response.json() did', async () => {
    await assert.rejects(smoke.fetchWithTimeout(`${baseUrl}/not-json`, {}, 2000, 'json'), SyntaxError);
});

test('fetchWithTimeout rejects an unknown read mode before it sends anything', async () => {
    await assert.rejects(smoke.fetchWithTimeout(`${baseUrl}/ok-json`, {}, 2000, 'blob'), TypeError);
});

test('the JSON read gives up at the timeout when the server sends headers and never ends the body', async () => {
    for (const route of ['headers-only-then-stall', 'partial-body-then-stall']) {
        const { error, ms } = await timed(smoke.fetchWithTimeout(`${baseUrl}/${route}`, {}, 300, 'json'));
        assert.ok(error, `${route}: the read must reject`);
        assert.equal(error.name, 'AbortError', `${route}: ${error.name}: ${error.message}`);
        assert.ok(ms >= 250 && ms < 300 + MARGIN_MS, `${route}: rejected after ${ms} ms`);
    }
});

test('the text read gives up at the timeout when the server sends headers and never ends the body', async () => {
    for (const route of ['headers-only-then-stall', 'partial-body-then-stall']) {
        const { error, ms } = await timed(smoke.fetchWithTimeout(`${baseUrl}/${route}`, {}, 300, 'text'));
        assert.ok(error, `${route}: the read must reject`);
        assert.equal(error.name, 'AbortError', `${route}: ${error.name}: ${error.message}`);
        assert.ok(ms >= 250 && ms < 300 + MARGIN_MS, `${route}: rejected after ${ms} ms`);
    }
});

test('a call that does not read the body returns at the headers and drops a body that never ends', async () => {
    for (const route of ['headers-only-then-stall', 'partial-body-then-stall']) {
        const { value, error, ms } = await timed(smoke.fetchWithTimeout(`${baseUrl}/${route}`, {}, 5000, 'none'));
        assert.equal(error, undefined, route);
        assert.deepEqual(value, { status: 200, ok: true, body: null }, route);
        assert.ok(ms < 5000, `${route}: took ${ms} ms`);
    }
});

test('a server that never sends headers is still cut off at the timeout', async () => {
    const { error, ms } = await timed(smoke.fetchWithTimeout(`${baseUrl}/no-headers`, {}, 300, 'json'));
    assert.ok(error);
    assert.equal(error.name, 'AbortError');
    assert.ok(ms >= 250 && ms < 300 + MARGIN_MS, `rejected after ${ms} ms`);
});

test('an unreachable server is a rejection, not a hang', async () => {
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address();
    await new Promise((resolve) => closed.close(resolve));
    await assert.rejects(smoke.fetchWithTimeout(`http://127.0.0.1:${port}/readyz`, {}, 1000, 'json'));
});

test('isReadyBody accepts a ready body whose required components are all ready', () => {
    assert.equal(smoke.isReadyBody({ status: 'ready' }), true);
    assert.equal(smoke.isReadyBody({ status: 'ready', components: { a: { required: true, status: 'ready' } } }), true);
    assert.equal(smoke.isReadyBody({ status: 'ready', components: { a: { required: false, status: 'starting' } } }), true);
    assert.equal(smoke.isReadyBody({ status: 'ready', components: { a: { required: true, status: 'starting' } } }), false);
    assert.equal(smoke.isReadyBody({ status: 'starting' }), false);
    assert.equal(smoke.isReadyBody(null), false);
});

test('no stage reads a response body outside the bounded fetchWithTimeout helper', () => {
    // Drop the helper's own definition: that is the one place allowed to call these.
    const start = scriptSource.indexOf('async function fetchWithTimeout');
    const end = scriptSource.indexOf('\n}\n', start) + 3;
    assert.ok(start >= 0 && end > start, 'fetchWithTimeout definition found');
    const rest = (scriptSource.slice(0, start) + scriptSource.slice(end))
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');

    assert.doesNotMatch(rest, /\.json\(\)/, 'response.json() outside fetchWithTimeout');
    assert.doesNotMatch(rest, /\.text\(\)/, 'response.text() outside fetchWithTimeout');
    assert.doesNotMatch(rest, /\.arrayBuffer\(\)|\.blob\(\)|\.formData\(\)/);
    // Every network call goes through the helper.
    assert.doesNotMatch(rest, /(?<![\w.])fetch\(/, 'a bare fetch() outside fetchWithTimeout');
});
