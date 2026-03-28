const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeIp,
    parseForwardedFirst,
    isLocalClientIp,
    isLocalHostname,
    shouldTrustForwardedHeaders,
    getTrustedForwardedClientIp,
} = require('../lib/network');

test('normalizeIp strips IPv4-mapped IPv6 prefixes', () => {
    assert.equal(normalizeIp('::ffff:192.168.0.5'), '192.168.0.5');
    assert.equal(normalizeIp('203.0.113.5'), '203.0.113.5');
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

test('forwarded headers are trusted only from local/private proxy peers', () => {
    const headers = {
        'cf-connecting-ip': '198.51.100.22',
        'x-forwarded-for': '203.0.113.44, 10.0.0.1',
    };

    assert.equal(shouldTrustForwardedHeaders('192.168.0.10', true), true);
    assert.equal(shouldTrustForwardedHeaders('203.0.113.10', true), false);
    assert.equal(
        getTrustedForwardedClientIp(headers, '192.168.0.10', true),
        '198.51.100.22'
    );
    assert.equal(
        getTrustedForwardedClientIp(headers, '203.0.113.10', true),
        ''
    );
});
