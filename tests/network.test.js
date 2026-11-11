const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeIp,
    parseForwardedFirst,
    parseForwardedLast,
    parseForwardedClient,
    hasForwardingEvidence,
    resolveTrustedHopCount,
    isLocalClientIp,
    isLocalHostname,
    shouldTrustForwardedHeaders,
    getTrustedForwardedClientIp,
    getCloudflareClientIp,
    classifyClient,
    isIpInTrustedLan,
    timingSafeTokenEqual,
} = require('../lib/network');

test('normalizeIp strips IPv4-mapped IPv6 prefixes', () => {
    assert.equal(normalizeIp('::ffff:192.168.0.5'), '192.168.0.5');
    assert.equal(normalizeIp('203.0.113.5'), '203.0.113.5');
});

test('operator client classification separates loopback, explicit LAN, proxy, and remote clients', () => {
    assert.deepEqual(classifyClient({ ip: '127.0.0.1' }), { kind: 'loopback', ip: '127.0.0.1' });
    assert.deepEqual(classifyClient({
        ip: '192.168.50.42',
        trustedLanCidrs: '192.168.50.0/24',
    }), { kind: 'trusted-lan', ip: '192.168.50.42' });
    assert.deepEqual(classifyClient({
        ip: '203.0.113.20',
        viaKnownProxy: true,
    }), { kind: 'known-proxy', ip: '203.0.113.20' });
    assert.deepEqual(classifyClient({ ip: '192.168.50.42' }), { kind: 'remote', ip: '192.168.50.42' });
    assert.equal(isIpInTrustedLan('10.20.30.40', '10.20.0.0/16'), true);
    assert.equal(isIpInTrustedLan('10.21.30.40', '10.20.0.0/16'), false);
});

test('operator capability comparison rejects missing, truncated, and different tokens', () => {
    const expected = '0123456789abcdef0123456789abcdef';
    assert.equal(timingSafeTokenEqual(expected, expected), true);
    assert.equal(timingSafeTokenEqual('', expected), false);
    assert.equal(timingSafeTokenEqual(expected.slice(1), expected), false);
    assert.equal(timingSafeTokenEqual('x'.repeat(expected.length), expected), false);
});

test('parseForwardedFirst returns the first forwarded value', () => {
    assert.equal(parseForwardedFirst('198.51.100.10, 10.0.0.1'), '198.51.100.10');
    assert.equal(parseForwardedFirst(''), '');
});

test('isLocalClientIp recognizes loopback and private ranges', () => {
    assert.equal(isLocalClientIp('127.0.0.1'), true);
    assert.equal(isLocalClientIp('192.168.1.20'), true);
    assert.equal(isLocalClientIp('203.0.113.20'), false);
});

test('isLocalHostname treats localhost, LAN, and private IPs as local', () => {
    assert.equal(isLocalHostname('localhost', '192.168.1.20'), true);
    assert.equal(isLocalHostname('192.168.1.20', '192.168.1.20'), true);
    assert.equal(isLocalHostname('example.com', '192.168.1.20'), false);
});

test('forwarded headers are trusted only from loopback proxy peers', () => {
    const headers = {
        'cf-connecting-ip': '198.51.100.22',
        'x-forwarded-for': '203.0.113.44, 10.0.0.1',
    };

    assert.equal(shouldTrustForwardedHeaders('127.0.0.1', true), true);
    assert.equal(shouldTrustForwardedHeaders('192.168.0.10', true), false);
    assert.equal(shouldTrustForwardedHeaders('203.0.113.10', true), false);
    // C-70eb68e12178: CF-Connecting-IP no longer wins. Any loopback proxy relays a client-supplied copy unchanged, so the
    // client is the rightmost X-Forwarded-For entry, the address the proxy appended.
    assert.equal(
        getTrustedForwardedClientIp(headers, '127.0.0.1', true),
        '10.0.0.1'
    );
    assert.equal(
        getTrustedForwardedClientIp(headers, '192.168.0.10', true),
        ''
    );
    assert.equal(
        getTrustedForwardedClientIp(headers, '203.0.113.10', true),
        ''
    );
});

// C-70eb68e12178 / VAL-145: the client is the address the loopback proxy appended on the right of X-Forwarded-For.
// CF-Connecting-IP and the entries to the left of it are written by the client, or relayed unchanged by any
// proxy that is not Cloudflare, so they never choose the identity.
const LOOPBACK_PEER = '127.0.0.1';

test('VAL-145: a spoofed leftmost X-Forwarded-For entry is ignored and the rightmost entry is the client', () => {
    assert.equal(
        getTrustedForwardedClientIp({ 'x-forwarded-for': '127.0.0.1, 203.0.113.5' }, LOOPBACK_PEER, true),
        '203.0.113.5'
    );
    assert.equal(
        getTrustedForwardedClientIp({ 'x-forwarded-for': '192.168.1.5,127.0.0.1,198.51.100.7' }, '::ffff:127.0.0.1', true),
        '198.51.100.7'
    );
    assert.equal(
        getTrustedForwardedClientIp({ 'x-forwarded-for': '203.0.113.44' }, '::1', true),
        '203.0.113.44'
    );
    // A spoofed leftmost entry must not classify the request as the local operator.
    const spoofed = getTrustedForwardedClientIp({ 'x-forwarded-for': '127.0.0.1, 203.0.113.5' }, LOOPBACK_PEER, true);
    assert.equal(classifyClient({ ip: spoofed, trustedLanCidrs: '192.168.1.0/24' }).kind, 'remote');
});

test('VAL-145: CF-Connecting-IP is never the client, with or without X-Forwarded-For', () => {
    assert.equal(
        getTrustedForwardedClientIp({
            'cf-connecting-ip': '198.51.100.22',
            'x-forwarded-for': '203.0.113.44, 10.0.0.1',
        }, LOOPBACK_PEER, true),
        '10.0.0.1'
    );
    assert.equal(
        getTrustedForwardedClientIp({
            'cf-connecting-ip': '127.0.0.1',
            'x-forwarded-for': '203.0.113.5',
        }, LOOPBACK_PEER, true),
        '203.0.113.5'
    );
    // A generic loopback proxy relays a client-supplied CF-Connecting-IP unchanged: with nothing else to vouch for
    // the client, the request is 'unknown' and classifies as remote, even for a trusted-LAN or loopback claim.
    for (const claimed of ['127.0.0.1', '192.168.1.5', '203.0.113.9']) {
        const ip = getTrustedForwardedClientIp({ 'cf-connecting-ip': claimed }, LOOPBACK_PEER, true);
        assert.equal(ip, 'unknown', `CF-Connecting-IP ${claimed}`);
        assert.equal(classifyClient({ ip, trustedLanCidrs: '192.168.1.0/24' }).kind, 'remote', `CF-Connecting-IP ${claimed}`);
    }
});

test('VAL-145: forwarding evidence without a usable rightmost X-Forwarded-For entry is unknown, never empty', () => {
    for (const value of ['203.0.113.5, not-an-ip', '203.0.113.5:4711', 'unknown', ',', '999.1.1.1']) {
        assert.equal(
            getTrustedForwardedClientIp({ 'x-forwarded-for': value }, LOOPBACK_PEER, true),
            'unknown',
            `X-Forwarded-For ${value}`
        );
    }
    for (const evidence of [
        { forwarded: 'for=203.0.113.5' },
        { 'x-real-ip': '203.0.113.5' },
        { 'cf-ray': '8f00-AMS' },
        { 'cdn-loop': 'Cloudflare; loops=1' },
        { 'x-forwarded-for': ['203.0.113.5', '127.0.0.1'], 'cf-ray': 'abc' },
    ]) {
        assert.equal(getTrustedForwardedClientIp(evidence, LOOPBACK_PEER, true), 'unknown', JSON.stringify(evidence));
    }
});

test('VAL-145: a loopback peer without forwarding headers, or without forwarded-header trust, yields no forwarded client', () => {
    assert.equal(getTrustedForwardedClientIp({}, LOOPBACK_PEER, true), '');
    assert.equal(getTrustedForwardedClientIp({ host: '127.0.0.1:3000', 'user-agent': 'x', 'x-forwarded-for': '  ' }, LOOPBACK_PEER, true), '');
    assert.equal(getTrustedForwardedClientIp({ 'x-forwarded-for': '203.0.113.5', 'cf-connecting-ip': '198.51.100.1' }, LOOPBACK_PEER, false), '');
    assert.equal(getTrustedForwardedClientIp({ 'x-forwarded-for': '127.0.0.1' }, '192.168.0.10', true), '');
    assert.equal(getTrustedForwardedClientIp({ 'cf-connecting-ip': '127.0.0.1' }, '203.0.113.10', true), '');
});

// C-bfcdc67f6dce / VAL-142: a peer that is not loopback is no proxy of ours. Whatever chain it sends, loopback or
// trusted-LAN entries in it (on either end) name nobody, and the caller keeps the peer's own address.
test('VAL-142: a multi-hop X-Forwarded-For chain from a peer that is not loopback is ignored', () => {
    const chains = [
        '127.0.0.1, 203.0.113.40',
        '203.0.113.40, 127.0.0.1',
        '192.168.50.25, 203.0.113.61',
        '203.0.113.61, 192.168.50.25',
        '127.0.0.1, 192.168.50.25, ::1',
    ];
    for (const peer of ['203.0.113.10', '192.168.50.30', '10.0.0.1', '::ffff:203.0.113.10']) {
        for (const chain of chains) {
            for (const options of [undefined, { trustedHopCount: 2 }]) {
                assert.equal(getTrustedForwardedClientIp({ 'x-forwarded-for': chain }, peer, true, options), '', `${peer} sent ${chain}`);
            }
        }
    }
    // The same chains from a loopback peer are read from the right, so the left-hand entries cannot grant privilege.
    assert.equal(getTrustedForwardedClientIp({ 'x-forwarded-for': '127.0.0.1, 203.0.113.40' }, LOOPBACK_PEER, true), '203.0.113.40');
    assert.equal(getTrustedForwardedClientIp({ 'x-forwarded-for': '192.168.50.25, 203.0.113.61' }, LOOPBACK_PEER, true), '203.0.113.61');
    assert.equal(
        classifyClient({ ip: getTrustedForwardedClientIp({ 'x-forwarded-for': '192.168.50.25, 203.0.113.61' }, LOOPBACK_PEER, true), trustedLanCidrs: '192.168.50.0/24' }).kind,
        'remote',
    );
});

test('hasForwardingEvidence and parseForwardedLast read the headers a proxy leaves behind', () => {
    assert.equal(parseForwardedLast('198.51.100.10, 10.0.0.1'), '10.0.0.1');
    assert.equal(parseForwardedLast(' 10.0.0.1 ,, '), '10.0.0.1');
    assert.equal(parseForwardedLast(''), '');
    assert.equal(parseForwardedLast(undefined), '');
    assert.equal(parseForwardedLast(['10.0.0.1']), '');

    for (const name of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'cf-ray']) {
        assert.equal(hasForwardingEvidence({ [name]: 'x' }), true, name);
        assert.equal(hasForwardingEvidence({ [name]: ['x'] }), true, `${name} (array)`);
        assert.equal(hasForwardingEvidence({ [name]: ' ' }), false, `${name} (blank)`);
    }
    assert.equal(hasForwardingEvidence({ 'cdn-loop': 'Cloudflare; loops=1' }), true);
    assert.equal(hasForwardingEvidence({ 'cdn-loop': 'other-cdn' }), false);
    assert.equal(hasForwardingEvidence({ host: 'localhost:3000', origin: 'http://localhost:3000' }), false);
    assert.equal(hasForwardingEvidence(), false);
});

// The owner's answer 4 (Q-001): X-Forwarded-For is read from the right, skipping the configured TRUST_PROXY hop
// count; CF-Connecting-IP only under an explicit Cloudflare mode (Nextra's own tunnel, or a config flag).
test('X-Forwarded-For skips the configured number of trusted hops from the right', () => {
    const headers = { 'x-forwarded-for': '10.9.9.9, 203.0.113.5, 198.51.100.7' };
    assert.equal(parseForwardedClient(headers['x-forwarded-for']), '198.51.100.7');
    assert.equal(parseForwardedClient(headers['x-forwarded-for'], 1), '198.51.100.7');
    assert.equal(parseForwardedClient(headers['x-forwarded-for'], 2), '203.0.113.5');
    assert.equal(parseForwardedClient(headers['x-forwarded-for'], 3), '10.9.9.9');
    assert.equal(parseForwardedClient(headers['x-forwarded-for'], 4), '');
    assert.equal(parseForwardedClient(headers['x-forwarded-for'], 0), '198.51.100.7');
    assert.equal(parseForwardedClient(headers['x-forwarded-for'], 'many'), '198.51.100.7');
    assert.equal(parseForwardedClient(undefined, 2), '');

    assert.equal(getTrustedForwardedClientIp(headers, LOOPBACK_PEER, true), '198.51.100.7');
    assert.equal(getTrustedForwardedClientIp(headers, LOOPBACK_PEER, true, { trustedHopCount: 2 }), '203.0.113.5');
    // Fewer entries than hops: the chain is shorter than configured, so nothing vouches for a client.
    assert.equal(getTrustedForwardedClientIp({ 'x-forwarded-for': '203.0.113.5' }, LOOPBACK_PEER, true, { trustedHopCount: 2 }), 'unknown');
    // The skipped hops still cannot widen trust past a non-loopback peer.
    assert.equal(getTrustedForwardedClientIp(headers, '192.168.0.10', true, { trustedHopCount: 2 }), '');
});

test('resolveTrustedHopCount turns the TRUST_PROXY setting into a hop count of at least one', () => {
    assert.equal(resolveTrustedHopCount(2), 2);
    assert.equal(resolveTrustedHopCount(1), 1);
    for (const value of [false, true, 0, -1, 1.5, NaN, '127.0.0.1', '10.0.0.0/8', 'loopback', undefined, null]) {
        assert.equal(resolveTrustedHopCount(value), 1, String(value));
    }
});

test('CF-Connecting-IP is honoured only under the explicit Cloudflare mode, and only as a valid address', () => {
    const cloudflare = { trustCloudflareClientIp: true };
    const viaCloudflare = { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1, 203.0.113.9' };

    assert.equal(getTrustedForwardedClientIp({ 'cf-connecting-ip': '203.0.113.9' }, LOOPBACK_PEER, true, cloudflare), '203.0.113.9');
    assert.equal(getTrustedForwardedClientIp({ 'cf-connecting-ip': '::ffff:203.0.113.9' }, LOOPBACK_PEER, true, cloudflare), '203.0.113.9');
    assert.equal(getTrustedForwardedClientIp(viaCloudflare, LOOPBACK_PEER, true, cloudflare), '203.0.113.9');
    assert.equal(getTrustedForwardedClientIp({ 'cf-connecting-ip': '2001:db8::1' }, LOOPBACK_PEER, true, cloudflare), '2001:db8::1');

    // Mode off (the default): ignored, with or without X-Forwarded-For.
    assert.equal(getTrustedForwardedClientIp({ 'cf-connecting-ip': '203.0.113.9' }, LOOPBACK_PEER, true), 'unknown');
    assert.equal(getTrustedForwardedClientIp({ 'cf-connecting-ip': '203.0.113.9' }, LOOPBACK_PEER, true, { trustCloudflareClientIp: false }), 'unknown');
    assert.equal(getTrustedForwardedClientIp({ 'cf-connecting-ip': '203.0.113.9' }, LOOPBACK_PEER, true, { trustCloudflareClientIp: 'yes' }), 'unknown');
    assert.equal(getTrustedForwardedClientIp(viaCloudflare, LOOPBACK_PEER, true), '203.0.113.9');
    assert.equal(
        getTrustedForwardedClientIp({ ...viaCloudflare, 'x-forwarded-for': '198.51.100.1' }, LOOPBACK_PEER, true),
        '198.51.100.1'
    );

    // A header that is not one valid address is ignored in the mode too: X-Forwarded-For decides, else unknown.
    for (const garbage of ['not-an-ip', '203.0.113.9, 127.0.0.1']) {
        assert.equal(getTrustedForwardedClientIp({ 'cf-connecting-ip': garbage }, LOOPBACK_PEER, true, cloudflare), 'unknown', garbage);
        assert.equal(
            getTrustedForwardedClientIp({ 'cf-connecting-ip': garbage, 'x-forwarded-for': '198.51.100.1' }, LOOPBACK_PEER, true, cloudflare),
            '198.51.100.1',
            garbage
        );
    }

    // Trust still needs a loopback peer and the forwarded-header gate.
    assert.equal(getTrustedForwardedClientIp({ 'cf-connecting-ip': '203.0.113.9' }, '192.168.0.10', true, cloudflare), '');
    assert.equal(getTrustedForwardedClientIp({ 'cf-connecting-ip': '203.0.113.9' }, LOOPBACK_PEER, false, cloudflare), '');
});

test('getCloudflareClientIp returns CF-Connecting-IP only when it is one valid address', () => {
    assert.equal(getCloudflareClientIp({ 'cf-connecting-ip': ' 203.0.113.9 ' }), '203.0.113.9');
    assert.equal(getCloudflareClientIp({ 'cf-connecting-ip': '::ffff:203.0.113.9' }), '203.0.113.9');
    assert.equal(getCloudflareClientIp({ 'cf-connecting-ip': '2001:db8::1' }), '2001:db8::1');
    for (const value of ['', 'not-an-ip', '203.0.113.9, 127.0.0.1', ['203.0.113.9'], undefined]) {
        assert.equal(getCloudflareClientIp({ 'cf-connecting-ip': value }), '', JSON.stringify(value));
    }
    assert.equal(getCloudflareClientIp(), '');
    assert.equal(getCloudflareClientIp(null), '');
});

// C-a223946bd23a / VAL-009: an entry that is not a valid network and a prefix of 1 to 32 matches nothing.
test('VAL-009: malformed or match-all trusted-LAN entries never widen trust', () => {
    const entries = [
        '192.168.1.0/', '0.0.0.0/0', '192.168.1.0/0', '10.0.0.0/abc', '999.0.0.0/8', '192.168.1.0/33',
        '192.168.1.0/-1', '192.168.1.0/ 8', '192.168.1.0/8.5', '192.168.1.0/24x', '/24', '192.168.1/24',
        '192.168.1.0/24/1', '192.168.1.0/+8', '192.168.1.0/1e1',
    ];
    for (const entry of entries) {
        assert.equal(isIpInTrustedLan('8.8.8.8', entry), false, `${entry} must not match 8.8.8.8`);
        assert.equal(isIpInTrustedLan('192.168.1.5', entry), false, `${entry} must not match 192.168.1.5`);
        assert.equal(classifyClient({ ip: '8.8.8.8', trustedLanCidrs: entry }).kind, 'remote', entry);
    }
    // A bad entry does not hide a good one next to it.
    assert.equal(isIpInTrustedLan('192.168.1.5', '192.168.1.0/, 192.168.1.0/24'), true);
    assert.equal(isIpInTrustedLan('8.8.8.8', '192.168.1.0/, 192.168.1.0/24'), false);
});

test('VAL-009: valid trusted-LAN entries keep matching', () => {
    assert.equal(isIpInTrustedLan('192.168.1.77', '192.168.1.0/24'), true);
    assert.equal(isIpInTrustedLan('192.168.2.77', '192.168.1.0/24'), false);
    assert.equal(isIpInTrustedLan('10.1.2.3', '10.0.0.0/8'), true);
    assert.equal(isIpInTrustedLan('192.168.1.77', '192.168.1.77/32'), true);
    assert.equal(isIpInTrustedLan('192.168.1.78', '192.168.1.77/32'), false);
    assert.equal(isIpInTrustedLan('128.0.0.1', '0.0.0.0/1'), false);
    assert.equal(isIpInTrustedLan('127.0.0.1', '0.0.0.0/1'), true);
    assert.equal(isIpInTrustedLan('192.168.1.5', '10.0.0.0/8, 192.168.1.0/24'), true);
    assert.equal(isIpInTrustedLan('::ffff:192.168.1.5', '192.168.1.0/24'), true);
    // Entries without a slash are exact addresses, IPv6 literals included.
    assert.equal(isIpInTrustedLan('192.168.1.5', '192.168.1.5'), true);
    assert.equal(isIpInTrustedLan('192.168.1.6', '192.168.1.5'), false);
    assert.equal(isIpInTrustedLan('fd00::5', 'FD00::5'), true);
    assert.equal(isIpInTrustedLan('fd00::6', 'fd00::5'), false);
});
