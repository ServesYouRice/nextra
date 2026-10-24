const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const selfsigned = require('selfsigned');
const { createMetricsFetcher } = require('../scripts/runtime-metrics-client');

async function generateSelfSigned() {
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }],
    });
    return { cert: pems.cert, key: pems.private };
}

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeServer(server) {
    return new Promise((resolve) => server.close(resolve));
}

function metricsHandler(received) {
    return (req, res) => {
        received.push({ url: req.url, authorization: req.headers.authorization });
        if (req.url.split('?')[0] !== '/api/metrics') {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    };
}

test('metrics fetch against an HTTPS target with a self-signed certificate succeeds with allowInsecureTls', async () => {
    const received = [];
    const { cert, key } = await generateSelfSigned();
    const server = https.createServer({ cert, key }, metricsHandler(received));
    const port = await listen(server);
    try {
        const fetchMetrics = createMetricsFetcher({
            baseUrl: `https://127.0.0.1:${port}`,
            allowInsecureTls: true,
            token: 'secret-token',
        });
        const metrics = await fetchMetrics();
        assert.deepEqual(metrics, { ok: true });
        assert.equal(received[0].url, '/api/metrics?resetEventLoopDelay=true');
        assert.equal(received[0].authorization, 'Bearer secret-token');
    } finally {
        await closeServer(server);
    }
});

test('metrics fetch against an HTTPS target with a self-signed certificate fails when TLS verification is on', async () => {
    const received = [];
    const { cert, key } = await generateSelfSigned();
    const server = https.createServer({ cert, key }, metricsHandler(received));
    const port = await listen(server);
    try {
        const fetchMetrics = createMetricsFetcher({
            baseUrl: `https://127.0.0.1:${port}`,
            allowInsecureTls: false,
        });
        await assert.rejects(fetchMetrics(), (err) => {
            assert.match(err.code || err.message, /SELF_SIGNED|CERT|UNABLE_TO_VERIFY/i);
            return true;
        });
        assert.equal(received.length, 0);
    } finally {
        await closeServer(server);
    }
});

test('metrics fetch against an HTTP target is unaffected and sends no Authorization header without a token', async () => {
    const received = [];
    const server = http.createServer(metricsHandler(received));
    const port = await listen(server);
    try {
        const fetchMetrics = createMetricsFetcher({
            baseUrl: `http://127.0.0.1:${port}`,
            allowInsecureTls: true,
            token: '',
        });
        assert.deepEqual(await fetchMetrics(), { ok: true });
        assert.equal(received[0].url, '/api/metrics?resetEventLoopDelay=true');
        assert.equal(received[0].authorization, undefined);
    } finally {
        await closeServer(server);
    }
});

test('metrics fetch does not change process-wide TLS verification', async () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const { cert, key } = await generateSelfSigned();
    const server = https.createServer({ cert, key }, metricsHandler([]));
    const port = await listen(server);
    try {
        const fetchMetrics = createMetricsFetcher({
            baseUrl: `https://127.0.0.1:${port}`,
            allowInsecureTls: true,
        });
        await fetchMetrics();
        assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, before);
    } finally {
        await closeServer(server);
    }
});
