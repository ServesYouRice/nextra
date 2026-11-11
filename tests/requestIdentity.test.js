const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyClient, isLocalClientIp } = require('../lib/network');
const { createRequestIdentity, hasCloudflareProxyEvidence } = require('../lib/requestIdentity');

const SHARE = 'https://nextra-proof.trycloudflare.com';
const TUNNEL = { host: 'nextra-proof.trycloudflare.com', 'cf-connecting-ip': '203.0.113.9', 'cf-ray': '8f00-AMS', 'x-forwarded-proto': 'https' };

// SHARE is the quick tunnel Nextra launched, running; server.js counts its URL among the known share origins.
function identity({ origins = [SHARE], trustForwarded = false } = {}) {
    return createRequestIdentity({
        getKnownPublicShareOrigins: () => origins,
        getTrustForwardedHeaders: () => trustForwarded,
        getManagedTunnelOrigin: () => (origins.includes(SHARE) ? SHARE : ''),
    });
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
    // No tunnel and no TRUST_CLOUDFLARE_CONNECTING_IP: the relay's CF-Connecting-IP is unproven, so it picks no bucket.
    const untrusted = identity({ origins: [] });
    assert.equal(untrusted.getClientIpFromHeaders({ host: '127.0.0.1:3000', 'cf-connecting-ip': '203.0.113.9' }, '127.0.0.1'), 'public-share-proxy');
    assert.equal(untrusted.getClientIpFromHeaders({ host: '127.0.0.1:3000', 'cf-ray': '8f00-AMS' }, '127.0.0.1'), 'public-share-proxy');
});

test('configured forwarded-header trust is unchanged', () => {
    const ids = identity({ origins: [], trustForwarded: true });
    assert.equal(ids.shouldTrustRequestForwardedHeaders({}, '127.0.0.1'), true);
    assert.equal(ids.shouldTrustRequestForwardedHeaders({}, '192.168.1.20'), false);
    assert.equal(ids.getClientIpFromHeaders({ 'x-forwarded-for': '203.0.113.40' }, '127.0.0.1'), '203.0.113.40');
});

// C-70eb68e12178 / VAL-145 through the request identity server.js uses: with forwarded-header trust configured, a
// loopback proxy vouches only for the rightmost X-Forwarded-For entry, and CF-Connecting-IP does not choose the client.
test('VAL-145: with forwarded-header trust the client is the rightmost X-Forwarded-For entry, never a spoofed one', () => {
    const ids = identity({ origins: [], trustForwarded: true });
    const spoofed = { 'x-forwarded-for': '127.0.0.1, 203.0.113.5' };
    assert.equal(ids.getClientIpFromHeaders(spoofed, '127.0.0.1'), '203.0.113.5');
    assert.equal(classify(ids, spoofed, '127.0.0.1'), 'remote');

    const lanSpoof = { 'x-forwarded-for': '192.168.1.5, 203.0.113.5' };
    assert.equal(
        classifyClient({ ip: ids.getClientIpFromHeaders(lanSpoof, '127.0.0.1'), trustedLanCidrs: '192.168.1.0/24' }).kind,
        'remote'
    );
});

test('VAL-145: a request relayed with CF-Connecting-IP but no X-Forwarded-For is never loopback or trusted-LAN', () => {
    const ids = identity({ origins: [], trustForwarded: true });
    for (const claimed of ['127.0.0.1', '192.168.1.5']) {
        const headers = { host: '127.0.0.1:3000', 'cf-connecting-ip': claimed };
        const ip = ids.getClientIpFromHeaders(headers, '127.0.0.1');
        assert.equal(ip, 'unknown', claimed);
        assert.equal(classifyClient({ ip, trustedLanCidrs: '192.168.1.0/24' }).kind, 'remote', claimed);
        assert.equal(classify(ids, headers, '127.0.0.1'), 'known-proxy', claimed);
    }
    // The host's own browser sends none of these headers and stays the operator.
    assert.equal(ids.getClientIpFromHeaders({ host: '127.0.0.1:3000' }, '127.0.0.1'), '127.0.0.1');
    assert.equal(classify(ids, { host: '127.0.0.1:3000' }, '127.0.0.1'), 'loopback');
});

test('Nextra\'s own tunnel is the one place CF-Connecting-IP is read; a spoofed X-Forwarded-For entry still is not', () => {
    const ids = identity({ trustForwarded: false });
    const viaTunnel = { ...TUNNEL, 'x-forwarded-for': '127.0.0.1, 203.0.113.9' };
    assert.equal(ids.getClientIpFromHeaders(viaTunnel, '127.0.0.1'), '203.0.113.9');
    assert.equal(ids.getClientIpFromHeaders({ ...TUNNEL, 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': '127.0.0.1, 203.0.113.10' }, '127.0.0.1'), '203.0.113.10');
    assert.equal(classify(ids, viaTunnel, '127.0.0.1'), 'known-proxy');
});

test('the TRUST_PROXY hop count is skipped from the right of X-Forwarded-For', () => {
    const headers = { 'x-forwarded-for': '10.9.9.9, 203.0.113.5, 198.51.100.7' };
    const withTrustProxy = (trustProxy) => createRequestIdentity({
        getKnownPublicShareOrigins: () => [],
        getTrustForwardedHeaders: () => true,
        getTrustProxy: () => trustProxy,
    });
    assert.equal(withTrustProxy(false).getClientIpFromHeaders(headers, '127.0.0.1'), '198.51.100.7');
    assert.equal(withTrustProxy(1).getClientIpFromHeaders(headers, '127.0.0.1'), '198.51.100.7');
    assert.equal(withTrustProxy(2).getClientIpFromHeaders(headers, '127.0.0.1'), '203.0.113.5');
    assert.equal(withTrustProxy('10.0.0.0/8').getClientIpFromHeaders(headers, '127.0.0.1'), '198.51.100.7');
    assert.equal(withTrustProxy(4).getClientIpFromHeaders(headers, '127.0.0.1'), 'unknown');
    // An identity built without the setting skips one hop.
    assert.equal(identity({ origins: [], trustForwarded: true }).getClientIpFromHeaders(headers, '127.0.0.1'), '198.51.100.7');
});

// The owner's answer 4 (Q-001): CF-Connecting-IP is Cloudflare's record of the viewer only where Cloudflare relayed
// the request: Nextra's own cloudflared tunnel, or a deployment whose operator sets TRUST_CLOUDFLARE_CONNECTING_IP.
// SHARE_BASE_URL on its own names some other proxy (nginx, Caddy), which passes on whatever CF-Connecting-IP the
// client sent, so there the proxy-appended X-Forwarded-For entry decides.
const PROXY_SHARE = 'https://stream.example.com';

test('VAL-132: behind a SHARE_BASE_URL proxy a client-supplied CF-Connecting-IP never chooses the client', () => {
    for (const trustForwarded of [false, true]) {
        const ids = createRequestIdentity({
            getKnownPublicShareOrigins: () => [PROXY_SHARE],
            getTrustForwardedHeaders: () => trustForwarded,
        });
        for (const claimed of ['127.0.0.1', '192.168.1.5', '198.51.100.4']) {
            const label = `trustForwarded=${trustForwarded} cf-connecting-ip=${claimed}`;
            const withXff = { host: 'stream.example.com', 'x-forwarded-for': '203.0.113.20', 'cf-connecting-ip': claimed };
            assert.equal(ids.getClientIpFromHeaders(withXff, '127.0.0.1'), '203.0.113.20', label);
            // Without X-Forwarded-For the proxy vouches for no client: 'unknown', which is remote.
            const ip = ids.getClientIpFromHeaders({ host: 'stream.example.com', 'cf-connecting-ip': claimed }, '127.0.0.1');
            assert.equal(ip, 'unknown', label);
            assert.equal(isLocalClientIp(ip), false, label);
            assert.equal(classifyClient({ ip, trustedLanCidrs: '192.168.1.0/24' }).kind, 'remote', label);
        }
    }
});

test('VAL-146: CF-Connecting-IP is read for Nextra\'s own running tunnel and under TRUST_CLOUDFLARE_CONNECTING_IP only', () => {
    const viaTunnel = { ...TUNNEL, 'x-forwarded-for': '198.51.100.40' };
    // Nextra launched cloudflared, it is running, and the request is addressed to its URL.
    const ownTunnel = createRequestIdentity({
        getKnownPublicShareOrigins: () => [SHARE],
        getTrustForwardedHeaders: () => false,
        getManagedTunnelOrigin: () => SHARE,
    });
    assert.equal(ownTunnel.getClientIpFromHeaders(viaTunnel, '127.0.0.1'), '203.0.113.9');
    assert.equal(ownTunnel.getClientIpFromHeaders({ ...viaTunnel, host: '127.0.0.1:3000', origin: SHARE }, '127.0.0.1'), '203.0.113.9');
    // The same URL as SHARE_BASE_URL in front of a proxy Nextra did not start: X-Forwarded-For decides.
    const manual = createRequestIdentity({ getKnownPublicShareOrigins: () => [SHARE], getTrustForwardedHeaders: () => false });
    assert.equal(manual.getClientIpFromHeaders(viaTunnel, '127.0.0.1'), '198.51.100.40');
    // While the tunnel runs, a loopback request addressed elsewhere (another proxy on this machine) is not the tunnel's.
    const elsewhere = { host: '127.0.0.1:3000', 'cf-connecting-ip': '203.0.113.9', 'cf-ray': '8f00-AMS' };
    assert.equal(ownTunnel.getClientIpFromHeaders(elsewhere, '127.0.0.1'), 'public-share-proxy');
    // A direct client never gets to name itself, whatever it claims.
    assert.equal(ownTunnel.getClientIpFromHeaders(viaTunnel, '192.168.1.20'), '192.168.1.20');

    // The operator's flag: every loopback relay is Cloudflare's, with or without a share URL.
    const flagged = createRequestIdentity({
        getKnownPublicShareOrigins: () => [PROXY_SHARE],
        getTrustForwardedHeaders: () => true,
        getTrustCloudflareClientIp: () => true,
    });
    assert.equal(flagged.getClientIpFromHeaders({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.40' }, '127.0.0.1'), '203.0.113.9');
    assert.equal(flagged.getClientIpFromHeaders({ 'cf-connecting-ip': '::ffff:203.0.113.9' }, '::1'), '203.0.113.9');
    // A value that is not one address is ignored and X-Forwarded-For decides.
    assert.equal(flagged.getClientIpFromHeaders({ 'cf-connecting-ip': '203.0.113.9, 127.0.0.1', 'x-forwarded-for': '198.51.100.40' }, '127.0.0.1'), '198.51.100.40');
    assert.equal(flagged.getClientIpFromHeaders({ 'cf-connecting-ip': '203.0.113.9' }, '192.168.1.20'), '192.168.1.20');
    // Only a boolean true turns it on.
    const notFlagged = createRequestIdentity({
        getKnownPublicShareOrigins: () => [],
        getTrustForwardedHeaders: () => true,
        getTrustCloudflareClientIp: () => 'true',
    });
    assert.equal(notFlagged.getClientIpFromHeaders({ 'cf-connecting-ip': '203.0.113.9' }, '127.0.0.1'), 'unknown');
});

test('the rate-limit bucket of a relay forwarded headers do not cover comes from CF-Connecting-IP only under a Cloudflare mode', () => {
    const relayed = (claimed) => ({ host: '127.0.0.1:3000', 'cf-connecting-ip': claimed, 'cf-ray': '8f00-AMS' });
    const unproven = createRequestIdentity({ getKnownPublicShareOrigins: () => [], getTrustForwardedHeaders: () => false });
    // Without a mode every such request shares one bucket: the client cannot pick a fresh one per attempt.
    for (const claimed of ['203.0.113.9', '203.0.113.10', '127.0.0.1']) {
        assert.equal(unproven.getClientIpFromHeaders(relayed(claimed), '127.0.0.1'), 'public-share-proxy', claimed);
    }
    const flagged = createRequestIdentity({
        getKnownPublicShareOrigins: () => [],
        getTrustForwardedHeaders: () => false,
        getTrustCloudflareClientIp: () => true,
    });
    assert.equal(flagged.getClientIpFromHeaders(relayed('203.0.113.9'), '127.0.0.1'), 'public-share:203.0.113.9');
    assert.equal(flagged.getClientIpFromHeaders(relayed('not-an-ip'), '127.0.0.1'), 'public-share-proxy');
});
