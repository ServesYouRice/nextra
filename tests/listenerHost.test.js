const test = require('node:test');
const assert = require('node:assert/strict');

const {
    clientHostForBoundAddress,
    formatHostForUrl,
    isBoundToIpv6Loopback,
    probeHostsForBindHost,
} = require('../lib/listenerHost');

const bound = (address) => ({ address, family: address.includes(':') ? 'IPv6' : 'IPv4', port: 3000 });

test('a specific address is advertised as it is', () => {
    assert.equal(clientHostForBoundAddress('127.0.0.1', bound('127.0.0.1')), '127.0.0.1');
    assert.equal(clientHostForBoundAddress('127.0.0.2', bound('127.0.0.2')), '127.0.0.2');
    assert.equal(clientHostForBoundAddress('192.168.1.20', bound('192.168.1.20')), '192.168.1.20');
    assert.equal(clientHostForBoundAddress('fe80::1', bound('fe80::1')), 'fe80::1');
    assert.equal(clientHostForBoundAddress('[fe80::1]', null), 'fe80::1');
});

test('::1 and [::1] are advertised as ::1, bound or not yet', () => {
    assert.equal(clientHostForBoundAddress('::1', bound('::1')), '::1');
    assert.equal(clientHostForBoundAddress('[::1]', bound('::1')), '::1');
    assert.equal(clientHostForBoundAddress('::1', null), '::1');
    assert.equal(clientHostForBoundAddress('[::1]', null), '::1');
});

test('0.0.0.0 is advertised as the IPv4 loopback', () => {
    assert.equal(clientHostForBoundAddress('0.0.0.0', bound('0.0.0.0')), '127.0.0.1');
    assert.equal(clientHostForBoundAddress('0.0.0.0', null), '127.0.0.1');
});

test(':: is advertised as the IPv4 loopback while dual-stack, and as ::1 when the socket is IPv6 only', () => {
    assert.equal(clientHostForBoundAddress('::', bound('::')), '127.0.0.1');
    assert.equal(clientHostForBoundAddress('[::]', bound('::')), '127.0.0.1');
    assert.equal(clientHostForBoundAddress('::', null), '127.0.0.1');
    assert.equal(clientHostForBoundAddress('::', bound('::'), { dualStack: false }), '::1');
    assert.equal(clientHostForBoundAddress('[::]', null, { dualStack: false }), '::1');
});

test('localhost follows the address the listener really bound', () => {
    assert.equal(clientHostForBoundAddress('localhost', bound('::1')), '::1');
    assert.equal(clientHostForBoundAddress('localhost', bound('127.0.0.1')), '127.0.0.1');
    assert.equal(clientHostForBoundAddress('LocalHost', bound('::1')), '::1');
    // The bound address can also be passed as its string.
    assert.equal(clientHostForBoundAddress('localhost', '::1'), '::1');
    // Before the listener is up, or if it reports nothing usable, the IPv4 loopback is the default.
    assert.equal(clientHostForBoundAddress('localhost', null), '127.0.0.1');
    assert.equal(clientHostForBoundAddress('localhost', undefined), '127.0.0.1');
    assert.equal(clientHostForBoundAddress('localhost', '/tmp/pipe.sock'), '127.0.0.1');
    assert.equal(clientHostForBoundAddress('localhost', bound('192.168.1.20')), '127.0.0.1');
});

test('an empty host is the default IPv4 loopback', () => {
    assert.equal(clientHostForBoundAddress('', null), '127.0.0.1');
    assert.equal(clientHostForBoundAddress(undefined, null), '127.0.0.1');
    assert.equal(clientHostForBoundAddress('  ', null), '127.0.0.1');
});

test('formatHostForUrl brackets IPv6 literals only', () => {
    assert.equal(formatHostForUrl('::1'), '[::1]');
    assert.equal(formatHostForUrl('[::1]'), '[::1]');
    assert.equal(formatHostForUrl('fe80::1'), '[fe80::1]');
    assert.equal(formatHostForUrl('127.0.0.1'), '127.0.0.1');
    assert.equal(formatHostForUrl('example.test'), 'example.test');
    assert.equal(formatHostForUrl(''), '127.0.0.1');
});

test('advertised URLs built from the helper reach the family that was bound', () => {
    const url = (host, bind) => `http://${formatHostForUrl(clientHostForBoundAddress(host, bind))}:3000`;
    assert.equal(url('::1', bound('::1')), 'http://[::1]:3000');
    assert.equal(url('127.0.0.1', bound('127.0.0.1')), 'http://127.0.0.1:3000');
    assert.equal(url('0.0.0.0', bound('0.0.0.0')), 'http://127.0.0.1:3000');
    assert.equal(url('localhost', bound('::1')), 'http://[::1]:3000');
});

test('only a listener on the IPv6 loopback counts as bound to it', () => {
    assert.equal(isBoundToIpv6Loopback('::1', null), true);
    assert.equal(isBoundToIpv6Loopback('[::1]', bound('::1')), true);
    assert.equal(isBoundToIpv6Loopback('localhost', bound('::1')), true);
    assert.equal(isBoundToIpv6Loopback('localhost', bound('127.0.0.1')), false);
    assert.equal(isBoundToIpv6Loopback('localhost', null), false);
    assert.equal(isBoundToIpv6Loopback('127.0.0.1', bound('127.0.0.1')), false);
    assert.equal(isBoundToIpv6Loopback('0.0.0.0', bound('0.0.0.0')), false);
    assert.equal(isBoundToIpv6Loopback('::', bound('::')), false);
    assert.equal(isBoundToIpv6Loopback('fe80::1', bound('fe80::1')), false);
});

test('the already-running probe tries the other loopback family only when the bind host could be on it', () => {
    // The default stays a single probe.
    assert.deepEqual(probeHostsForBindHost('127.0.0.1'), ['127.0.0.1']);
    assert.deepEqual(probeHostsForBindHost('0.0.0.0'), ['127.0.0.1']);
    assert.deepEqual(probeHostsForBindHost('::'), ['127.0.0.1']);
    assert.deepEqual(probeHostsForBindHost('::1'), ['::1', '127.0.0.1']);
    assert.deepEqual(probeHostsForBindHost('[::1]'), ['::1', '127.0.0.1']);
    assert.deepEqual(probeHostsForBindHost('localhost'), ['127.0.0.1', '::1']);
    assert.deepEqual(probeHostsForBindHost('localhost', bound('::1')), ['::1', '127.0.0.1']);
    assert.deepEqual(probeHostsForBindHost('192.168.1.20'), ['192.168.1.20', '127.0.0.1']);
});
