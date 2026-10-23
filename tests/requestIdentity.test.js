const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyClient } = require('../lib/network');
const { createRequestIdentity, hasCloudflareProxyEvidence } = require('../lib/requestIdentity');

const SHARE = 'https://nextra-proof.trycloudflare.com';
const TUNNEL = { host: 'nextra-proof.trycloudflare.com', 'cf-connecting-ip': '203.0.113.9', 'cf-ray': '8f00-AMS', 'x-forwarded-proto': 'https' };

function identity({ origins = [SHARE], trustForwarded = false } = {}) {
    return createRequestIdentity({ getKnownPublicShareOrigins: () => origins, getTrustForwardedHeaders: () => trustForwarded });
}

/** The classification server.js gives a request: the identity's IP, and whether it came through a relay. */
function classify(ids, headers, remoteAddress) {
    return classifyClient({
        ip: ids.getClientIpFromHeaders(headers, remoteAddress),
        viaKnownProxy: ids.isKnownPublicShareRequest(headers) || ids.isRelayedFromLoopback(headers, remoteAddress),
    }).kind;
}

test('VAL-075: a loopback request for the share host without Origin or Referer is not the operator, whatever the scheme', () => {
    const ids = identity();
    for (const host of ['nextra-proof.trycloudflare.com', 'NEXTRA-PROOF.trycloudflare.com']) {
        assert.notEqual(classify(ids, { host }, '127.0.0.1'), 'loopback');
    }
    assert.notEqual(classify(ids, { host: '127.0.0.1:3000', 'x-forwarded-host': 'nextra-proof.trycloudflare.com' }, '127.0.0.1'), 'loopback');
    assert.equal(classify(ids, TUNNEL, '::ffff:127.0.0.1'), 'known-proxy');
});

test('VAL-076: Cloudflare\'s headers from loopback are a relay even with a local Origin and Host', () => {
    const ids = identity({ origins: [] });
    for (const evidence of [{ 'cf-connecting-ip': '127.0.0.1' }, { 'cf-ray': '8f00-AMS' }, { 'cdn-loop': 'cloudflare; loops=1' }]) {
        const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', ...evidence };
        assert.equal(hasCloudflareProxyEvidence(headers), true);
        assert.equal(classify(ids, headers, '127.0.0.1'), 'known-proxy');
        assert.doesNotMatch(ids.getClientIpFromHeaders(headers, '127.0.0.1'), /^127\./);
    }
});

test('VAL-077: the host\'s own browser on this machine stays the operator', () => {
    const ids = identity();
    assert.equal(classify(ids, { host: '127.0.0.1:3000' }, '127.0.0.1'), 'loopback');
    assert.equal(classify(ids, { host: 'localhost:3000', origin: 'http://localhost:3000' }, '::1'), 'loopback');
    assert.equal(ids.getClientIpFromHeaders({ host: '127.0.0.1:3000' }, '127.0.0.1'), '127.0.0.1');
});

test('VAL-078: a direct client that claims the share host cannot choose its identity with cf-connecting-ip', () => {
    const ids = identity();
    for (const claimed of ['198.51.100.1', '198.51.100.2']) {
        const headers = { host: 'nextra-proof.trycloudflare.com', origin: SHARE, 'cf-connecting-ip': claimed };
        assert.equal(ids.getClientIpFromHeaders(headers, '192.168.1.20'), '192.168.1.20');
    }
    assert.equal(classify(ids, { host: 'nextra-proof.trycloudflare.com' }, '192.168.1.20'), 'known-proxy');
});

test('VAL-079: viewers through the tunnel keep their own identities, never a local one', () => {
    const ids = identity();
    const noForwarded = { host: 'nextra-proof.trycloudflare.com', 'cf-ray': '8f00-AMS' };
    assert.equal(ids.getClientIpFromHeaders({ ...noForwarded, 'cf-connecting-ip': '203.0.113.9' }, '127.0.0.1'), '203.0.113.9');
    assert.equal(ids.getClientIpFromHeaders({ ...noForwarded, 'cf-connecting-ip': '203.0.113.10' }, '127.0.0.1'), '203.0.113.10');
    const untrusted = identity({ origins: [] });
    assert.equal(untrusted.getClientIpFromHeaders({ host: '127.0.0.1:3000', 'cf-connecting-ip': '203.0.113.9' }, '127.0.0.1'), 'public-share:203.0.113.9');
    assert.equal(untrusted.getClientIpFromHeaders({ host: '127.0.0.1:3000', 'cf-ray': '8f00-AMS' }, '127.0.0.1'), 'public-share-proxy');
});

test('configured forwarded-header trust is unchanged', () => {
    const ids = identity({ origins: [], trustForwarded: true });
    assert.equal(ids.shouldTrustRequestForwardedHeaders({}, '127.0.0.1'), true);
    assert.equal(ids.shouldTrustRequestForwardedHeaders({}, '192.168.1.20'), false);
    assert.equal(ids.getClientIpFromHeaders({ 'x-forwarded-for': '203.0.113.40' }, '127.0.0.1'), '203.0.113.40');
});
