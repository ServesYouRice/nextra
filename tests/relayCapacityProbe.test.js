const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createRelayCapacityProbe, PROBE_BYTES } = require('../lib/relayCapacityProbe');

const silent = { log() {} };

// A response body that hands over `chunks` of [delayMs, bytes].
function fakeFetch(chunks, { clock, ok = true, status = ok ? 200 : 502, onUrl } = {}) {
    return async (url) => {
        onUrl?.(url);
        let index = 0;
        return {
            ok,
            status,
            body: {
                getReader: () => ({
                    async read() {
                        if (index >= chunks.length) return { done: true };
                        const [delayMs, bytes] = chunks[index++];
                        clock.now += delayMs;
                        return { done: false, value: new Uint8Array(bytes) };
                    },
                }),
            },
        };
    };
}

test('the probe reports the rate the link carried once it had ramped up', async () => {
    const clock = { now: 0 };
    let requested = '';
    // 125 kB every 100 ms is 10 Mbps.
    const chunks = Array.from({ length: 60 }, () => [100, 125_000]);
    const probe = createRelayCapacityProbe({
        fetchImpl: fakeFetch(chunks, { clock, onUrl: (url) => { requested = url; } }),
        now: () => clock.now,
        logger: silent,
    });

    const result = await probe.measure('https://example.test', '/api/relay-probe');

    assert.equal(result.status, 'measured');
    assert.equal(result.kbps, 10_000);
    assert.match(requested, /^https:\/\/example\.test\/api\/relay-probe\/[0-9a-f]{48}$/);
    assert.equal(probe.getLast().kbps, 10_000);
});

test('a download that is over before the ramp-up means the link needs no limit', async () => {
    const clock = { now: 0 };
    const probe = createRelayCapacityProbe({
        fetchImpl: fakeFetch(Array.from({ length: 10 }, () => [50, 1_000_000]), { clock }),
        now: () => clock.now,
        logger: silent,
    });
    assert.deepEqual(await probe.measure('https://example.test', '/p'), { status: 'fast', kbps: null });
});

test('an unreachable link is reported as a failure, not as a slow link', async () => {
    const clock = { now: 0 };
    // What Node's fetch throws while a new hostname does not resolve yet.
    const failing = createRelayCapacityProbe({
        fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); },
        now: () => clock.now,
        logger: silent,
    });
    assert.deepEqual(await failing.measure('https://example.test', '/p'), { status: 'failed', kbps: null, reason: 'ENOTFOUND' });

    const refused = createRelayCapacityProbe({ fetchImpl: fakeFetch([], { clock, ok: false, status: 530 }), now: () => clock.now, logger: silent });
    assert.deepEqual(await refused.measure('https://example.test', '/p'), { status: 'failed', kbps: null, reason: 'HTTP 530' });
    assert.deepEqual(await refused.measure('', '/p'), { status: 'failed', kbps: null, reason: 'unavailable' });

    // A link that carried nothing worth measuring before the download broke off.
    const broken = createRelayCapacityProbe({
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            body: { getReader: () => ({ read: async () => { throw new Error('socket hang up'); } }) },
        }),
        now: () => clock.now,
        logger: silent,
    });
    assert.deepEqual(await broken.measure('https://example.test', '/p'), { status: 'failed', kbps: null, reason: 'socket hang up' });
});

test('the probe download passes untouched through response compression', async () => {
    const compression = require('compression');
    const express = require('express');
    const app = express();
    app.use(compression());
    const probe = createRelayCapacityProbe({
        logger: silent,
        // Ask for gzip the way a proxy in between would, and look at what came back.
        fetchImpl: async (url, options) => {
            const response = await fetch(url, { ...options, headers: { 'Accept-Encoding': 'gzip' } });
            observed = {
                encoding: response.headers.get('content-encoding'),
                length: response.headers.get('content-length'),
                cacheControl: response.headers.get('cache-control'),
            };
            return response;
        },
    });
    let observed = null;
    app.get('/probe/:token', probe.handler);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        await probe.measure(`http://127.0.0.1:${server.address().port}`, '/probe');
        assert.deepEqual(observed, {
            encoding: null,
            length: String(PROBE_BYTES),
            cacheControl: 'no-store, no-transform',
        });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('the probe endpoint serves one armed download and nothing else', async () => {
    let probe = null;
    const server = http.createServer((req, res) => {
        const token = req.url.split('/').pop();
        res.status = (code) => { res.statusCode = code; return res; };
        res.set = (headers) => { for (const [key, value] of Object.entries(headers)) res.setHeader(key, value); return res; };
        probe.handler({ params: { token } }, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
        let armedUrl = '';
        let secondStatus = 0;
        probe = createRelayCapacityProbe({
            logger: silent,
            fetchImpl: async (url, options) => {
                armedUrl = url;
                const response = await fetch(url, options);
                // The token is spent by the first request.
                secondStatus = (await fetch(url)).status;
                return response;
            },
        });

        // Nothing is served without a probe in progress, or for a wrong token.
        assert.equal((await fetch(`${base}/probe/${'0'.repeat(48)}`)).status, 404);

        const result = await probe.measure(base, '/probe');
        // Loopback finishes inside the ramp-up window.
        assert.equal(result.status, 'fast');
        assert.equal(secondStatus, 404);
        assert.equal((await fetch(armedUrl)).status, 404);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('the probe download is a fixed, bounded size', () => {
    assert.ok(PROBE_BYTES >= 4 * 1024 * 1024 && PROBE_BYTES <= 16 * 1024 * 1024);
});
