const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeIp,
    parseForwardedFirst,
    isLocalClientIp,
    isLocalHostname,
    shouldTrustForwardedHeaders,
    getTrustedForwardedClientIp,
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
    assert.equal(
        getTrustedForwardedClientIp(headers, '127.0.0.1', true),
        '198.51.100.22'
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
