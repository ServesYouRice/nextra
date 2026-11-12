// TRUSTED_PROXY_CIDRS: reverse proxies the operator runs on addresses other than loopback (a Traefik pod network,
// another machine). A TCP peer inside the list is treated like a same-host proxy whose headers are trusted, with one
// difference that only tightens: such a peer always relays, so its request is never the operator's own.
//
// The invariants, each tested below on the pure functions and again on the real server:
// 1. A request from a trusted proxy is never classified loopback or trusted-LAN, also when the proxy's own address
//    is inside TRUSTED_LAN_CIDRS and when it carries no forwarding header (then the client is 'unknown').
// 2. The client identity for rate limits is the forwarded address, never the proxy's.
// 3. A peer outside the list that sends forwarding headers gains nothing.
// 4. CF-Connecting-IP is read only in the Cloudflare modes that exist without this setting.
// 5. With the setting unset nothing changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Server } = require('socket.io');
const { io: createSocketClient } = require('socket.io-client');

const config = require('../config');
const {
    classifyClient,
    getTrustedForwardedClientIp,
    isLocalClientIp,
    isTrustedProxyAddress,
    parseTrustedProxyCidrs,
    shouldTrustForwardedHeaders,
} = require('../lib/network');
const { createRequestIdentity } = require('../lib/requestIdentity');
const { registerSocketHandlers, stopJoinCleanup } = require('../lib/socket');
const { claimServerPorts } = require('./serverPorts');
const { findNonLoopbackAddress } = require('./nonLoopbackAddress');

const projectRoot = path.resolve(__dirname, '..');
const configPath = path.join(projectRoot, 'config.js');
// The cluster this setting was added for: Traefik in the k3s pod network.
const PODS = '10.42.0.0/16';
const PROXY = '10.42.0.17';
const LAN = '192.168.1.0/24';
const RATE_LIMITED = /Too many attempts/;

test('parseTrustedProxyCidrs accepts IPv4 and IPv6 addresses and CIDRs', () => {
    const parsed = parseTrustedProxyCidrs(' 10.42.0.0/16, 192.0.2.7 ,fd00:42::/56, 2001:db8::9 , ::ffff:198.51.100.4,,');
    assert.deepEqual(parsed.invalid, []);
    assert.equal(parsed.count, 5);
    assert.equal(parseTrustedProxyCidrs('').count, 0);
    assert.equal(parseTrustedProxyCidrs(undefined).count, 0);
});

test('parseTrustedProxyCidrs names every entry it refuses', () => {
    const refused = [
        'traefik', '10.42.0.0/16/8', '10.42.0.0/', '10.42.0.0/0', '10.42.0.0/33', '10.42.0.0/1e1', '10.42.0.256',
        'fd00::/0', 'fd00::/129', 'fe80::1%eth0', '[fd00::1]', '10.42.0.0-10.42.0.9', '/16',
        // Loopback is TRUST_X_FORWARDED_HEADERS' business.
        '127.0.0.1', '127.0.0.0/8', '::1', '::ffff:127.0.0.1',
    ];
    for (const entry of refused) {
        const { invalid, count } = parseTrustedProxyCidrs(`10.42.0.0/16, ${entry}`);
        assert.equal(invalid.length, 1, `${entry} was accepted`);
        assert.equal(invalid[0].entry, entry);
        assert.ok(invalid[0].reason, `${entry} was refused without a reason`);
        // The valid entry beside it still parses; config.js is what refuses to start.
        assert.equal(count, 1);
    }
});

test('isTrustedProxyAddress matches listed peers only, and never a loopback peer', () => {
    const list = '10.42.0.0/16, 192.0.2.7, fd00:42::/56';
    for (const peer of ['10.42.0.1', '10.42.255.254', '::ffff:10.42.0.17', '192.0.2.7', 'fd00:42::1', 'FD00:42:0:ff::9']) {
        assert.equal(isTrustedProxyAddress(peer, list), true, `${peer} was not matched`);
    }
    for (const peer of ['10.43.0.1', '192.0.2.8', 'fd00:43::1', '203.0.113.9', '', 'unknown', undefined, 'traefik']) {
        assert.equal(isTrustedProxyAddress(peer, list), false, `${peer} was matched`);
    }
    // No list, no proxies.
    for (const none of ['', '   ', undefined, null]) {
        assert.equal(isTrustedProxyAddress('10.42.0.1', none), false);
    }
    // A range wide enough to cover loopback still leaves loopback peers alone.
    for (const wide of ['0.0.0.0/1', '::/1', '0.0.0.0/1, ::/1']) {
        for (const loopback of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) {
            assert.equal(isTrustedProxyAddress(loopback, wide), false, `${loopback} matched ${wide}`);
        }
    }
    assert.equal(isTrustedProxyAddress('10.1.2.3', '0.0.0.0/1'), true);
    // An entry that does not parse matches nothing and does not disable the ones that do.
    assert.equal(isTrustedProxyAddress('10.42.0.1', 'nonsense, 10.42.0.0/16'), true);
    assert.equal(isTrustedProxyAddress('10.42.0.1', 'nonsense'), false);
});

test('a trusted proxy peer is the opt-in: its forwarded headers need no TRUST_X_FORWARDED_HEADERS', () => {
    assert.equal(shouldTrustForwardedHeaders(PROXY, false, PODS), true);
    assert.equal(shouldTrustForwardedHeaders(PROXY, true, PODS), true);
    // Without the list the peer is nobody, with or without the loopback setting.
    assert.equal(shouldTrustForwardedHeaders(PROXY, false), false);
    assert.equal(shouldTrustForwardedHeaders(PROXY, true), false);
    assert.equal(shouldTrustForwardedHeaders(PROXY, true, ''), false);
    // Loopback peers get exactly what TRUST_X_FORWARDED_HEADERS gives them, whatever the list holds.
    assert.equal(shouldTrustForwardedHeaders('127.0.0.1', false, PODS), false);
    assert.equal(shouldTrustForwardedHeaders('127.0.0.1', true, PODS), true);
    assert.equal(shouldTrustForwardedHeaders('127.0.0.1', false, '0.0.0.0/1'), false);
});

test('invariant 2 (network): a trusted proxy vouches for the X-Forwarded-For entry at the trusted hop, else for nobody', () => {
    const viaProxy = (headers, options = {}) => getTrustedForwardedClientIp(headers, PROXY, false, { trustedProxyCidrs: PODS, ...options });
    assert.equal(viaProxy({ 'x-forwarded-for': '203.0.113.5' }), '203.0.113.5');
    // The leftmost entries are the client's own writing.
    assert.equal(viaProxy({ 'x-forwarded-for': '127.0.0.1, 192.168.1.5, 203.0.113.5' }), '203.0.113.5');
    assert.equal(viaProxy({ 'x-forwarded-for': '198.51.100.7, 203.0.113.5' }, { trustedHopCount: 2 }), '198.51.100.7');
    // Nothing usable at the trusted position: 'unknown', never '' (which would let the caller use the proxy's address).
    assert.equal(viaProxy({ 'x-forwarded-for': '203.0.113.5' }, { trustedHopCount: 2 }), 'unknown');
    assert.equal(viaProxy({ 'x-forwarded-for': 'not-an-address' }), 'unknown');
    assert.equal(viaProxy({ 'x-real-ip': '203.0.113.5' }), 'unknown');
    assert.equal(viaProxy({}), 'unknown');
    assert.equal(viaProxy({ host: 'nextra.example.com', 'user-agent': 'x' }), 'unknown');
    assert.equal(viaProxy(undefined), 'unknown');
});

test('invariant 4 (network): CF-Connecting-IP is never read from a trusted proxy peer, even with the Cloudflare flag', () => {
    const headers = { 'cf-connecting-ip': '198.51.100.99', 'x-forwarded-for': '203.0.113.5' };
    for (const trustCloudflareClientIp of [false, true]) {
        const options = { trustedProxyCidrs: PODS, trustCloudflareClientIp };
        assert.equal(getTrustedForwardedClientIp(headers, PROXY, false, options), '203.0.113.5');
        assert.equal(getTrustedForwardedClientIp(headers, PROXY, true, options), '203.0.113.5');
        assert.equal(getTrustedForwardedClientIp({ 'cf-connecting-ip': '198.51.100.99' }, PROXY, true, options), 'unknown');
    }
    // The loopback Cloudflare mode still reads it, with the list set.
    assert.equal(
        getTrustedForwardedClientIp(headers, '127.0.0.1', true, { trustedProxyCidrs: PODS, trustCloudflareClientIp: true }),
        '198.51.100.99',
    );
});

function identity({ proxies = PODS, trustForwarded = false, origins = [], trustProxy = false, ...rest } = {}) {
    return createRequestIdentity({
        getKnownPublicShareOrigins: () => origins,
        getTrustForwardedHeaders: () => trustForwarded,
        getTrustProxy: () => trustProxy,
        getTrustedProxyCidrs: () => proxies,
        ...rest,
    });
}

/** The classification server.js gives a request (isRelayedClient there). */
function classify(ids, headers, remoteAddress, trustedLanCidrs = '') {
    return classifyClient({
        ip: ids.getClientIpFromHeaders(headers, remoteAddress),
        trustedLanCidrs,
        viaKnownProxy: ids.isRelayedByTrustedProxy(remoteAddress)
            || ids.isKnownPublicShareRequest(headers)
            || ids.isRelayedFromLoopback(headers, remoteAddress)
            || !ids.isOperatorAddressedRequest(headers, remoteAddress),
    });
}

test('invariant 1: a request from a trusted proxy is never loopback or trusted-LAN', () => {
    // The proxy's own address is inside TRUSTED_LAN_CIDRS too.
    const lan = `${LAN}, ${PODS}`;
    const local = { host: '10.42.0.5:3000' };
    const requests = [
        // No forwarding header at all.
        {},
        local,
        // A forwarded address that would be the operator's without the proxy: loopback, the trusted LAN, the proxy.
        { ...local, 'x-forwarded-for': '127.0.0.1' },
        { ...local, 'x-forwarded-for': '::1' },
        { ...local, 'x-forwarded-for': '192.168.1.5' },
        { ...local, 'x-forwarded-for': PROXY },
        { ...local, 'x-forwarded-for': '203.0.113.5, 127.0.0.1' },
        { host: 'localhost:3000', origin: 'http://localhost:3000', 'x-forwarded-for': '127.0.0.1' },
        // Headers the client can write itself.
        { ...local, 'x-real-ip': '127.0.0.1' },
        { ...local, 'cf-connecting-ip': '127.0.0.1' },
        { ...local, forwarded: 'for=127.0.0.1' },
        { host: 'nextra.example.com', 'x-forwarded-host': 'localhost', 'x-forwarded-proto': 'https' },
    ];
    for (const trustForwarded of [false, true]) {
        const ids = identity({ trustForwarded });
        for (const peer of [PROXY, `::ffff:${PROXY}`, '10.42.200.1']) {
            for (const headers of requests) {
                const label = `${peer} ${JSON.stringify(headers)} trustForwarded=${trustForwarded}`;
                assert.equal(ids.isRelayedByTrustedProxy(peer), true, label);
                assert.equal(ids.isOperatorAddressedRequest(headers, peer), false, label);
                assert.equal(classify(ids, headers, peer, lan).kind, 'known-proxy', label);
            }
        }
    }
});

test('invariant 1: without a forwarding header the client of a trusted proxy is unknown, which is remote', () => {
    const ids = identity();
    for (const headers of [{}, { host: '10.42.0.5:3000' }, { host: 'localhost:3000', origin: 'http://localhost:3000' }]) {
        const ip = ids.getClientIpFromHeaders(headers, PROXY);
        assert.equal(ip, 'unknown');
        assert.equal(isLocalClientIp(ip), false);
        // Remote even for a caller that classifies by address alone.
        assert.equal(classifyClient({ ip, trustedLanCidrs: `${LAN}, ${PODS}` }).kind, 'remote');
    }
});

test('invariant 2: the rate-limit identity is the forwarded address, never the proxy\'s', () => {
    const ids = identity();
    assert.equal(ids.getClientIpFromHeaders({ 'x-forwarded-for': '203.0.113.5' }, PROXY), '203.0.113.5');
    assert.equal(ids.getClientIpFromHeaders({ 'x-forwarded-for': '203.0.113.6' }, PROXY), '203.0.113.6');
    assert.equal(ids.getClientIpFromHeaders({ 'x-forwarded-for': '203.0.113.5' }, `::ffff:${PROXY}`), '203.0.113.5');
    assert.equal(ids.getClientIpFromHeaders({ 'x-forwarded-for': '10.9.9.9, 203.0.113.5' }, PROXY), '203.0.113.5');
    // The TRUST_PROXY hop count applies as it does to a loopback proxy.
    const twoHops = identity({ trustProxy: 2 });
    assert.equal(twoHops.getClientIpFromHeaders({ 'x-forwarded-for': '10.9.9.9, 198.51.100.7, 203.0.113.5' }, PROXY), '198.51.100.7');
    assert.equal(twoHops.getClientIpFromHeaders({ 'x-forwarded-for': '203.0.113.5' }, PROXY), 'unknown');
    // No request shape makes the proxy's own address the identity.
    for (const headers of [{}, { 'x-forwarded-for': '' }, { 'x-forwarded-for': 'garbage' }, { 'x-real-ip': '203.0.113.5' }, { via: '1.1 traefik' }]) {
        for (const trustForwarded of [false, true]) {
            const ip = identity({ trustForwarded }).getClientIpFromHeaders(headers, PROXY);
            assert.equal(ip, 'unknown', JSON.stringify(headers));
        }
    }
});

test('a trusted proxy\'s X-Forwarded-Proto and X-Forwarded-Host are trusted without TRUST_X_FORWARDED_HEADERS', () => {
    const ids = identity({ trustForwarded: false });
    assert.equal(ids.shouldTrustRequestForwardedHeaders({}, PROXY), true);
    assert.equal(ids.shouldTrustRequestForwardedHeaders({ 'x-forwarded-proto': 'https' }, `::ffff:${PROXY}`), true);
    // Loopback peers are governed by the settings they had: the list changes nothing for them.
    assert.equal(ids.shouldTrustRequestForwardedHeaders({}, '127.0.0.1'), false);
    assert.equal(identity({ trustForwarded: true }).shouldTrustRequestForwardedHeaders({}, '127.0.0.1'), true);
    assert.equal(ids.isRelayedByTrustedProxy('127.0.0.1'), false);
    assert.equal(classify(ids, { host: '127.0.0.1:3000' }, '127.0.0.1').kind, 'loopback');
    assert.equal(ids.getClientIpFromHeaders({ host: '127.0.0.1:3000' }, '127.0.0.1'), '127.0.0.1');
});

// What a request can look like, for the comparisons below.
const HEADER_SHAPES = [
    {},
    { host: '127.0.0.1:3000' },
    { host: '192.168.1.20:3000', origin: 'http://192.168.1.20:3000' },
    { host: 'stream.example.com' },
    { host: '127.0.0.1:3000', 'x-forwarded-for': '127.0.0.1' },
    { host: '127.0.0.1:3000', 'x-forwarded-for': '192.168.1.5' },
    { host: '127.0.0.1:3000', 'x-forwarded-for': '203.0.113.9, 127.0.0.1' },
    { host: '127.0.0.1:3000', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'stream.example.com' },
    { host: '127.0.0.1:3000', 'x-real-ip': '127.0.0.1' },
    { host: '127.0.0.1:3000', 'cf-connecting-ip': '127.0.0.1', 'cf-ray': '8f00-AMS' },
    { host: 'stream.example.com', 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '192.168.1.5' },
    { host: '127.0.0.1:3000', via: '1.1 proxy' },
];

function describeRequest(ids, headers, peer, trustedLanCidrs) {
    return {
        ip: ids.getClientIpFromHeaders(headers, peer),
        kind: classify(ids, headers, peer, trustedLanCidrs).kind,
        trustsForwarded: ids.shouldTrustRequestForwardedHeaders(headers, peer),
        relayedByTrustedProxy: ids.isRelayedByTrustedProxy(peer),
    };
}

test('invariant 3: a peer outside the list that sends forwarding headers gains nothing', () => {
    const outsiders = ['203.0.113.10', '192.168.1.20', '10.43.0.1', '::ffff:10.41.255.255', '127.0.0.1', '::1', 'unknown', ''];
    for (const trustForwarded of [false, true]) {
        for (const origins of [[], ['https://stream.example.com']]) {
            const withList = identity({ trustForwarded, origins });
            const withoutSetting = createRequestIdentity({
                getKnownPublicShareOrigins: () => origins,
                getTrustForwardedHeaders: () => trustForwarded,
            });
            for (const peer of outsiders) {
                for (const headers of HEADER_SHAPES) {
                    assert.deepEqual(
                        describeRequest(withList, headers, peer, LAN),
                        describeRequest(withoutSetting, headers, peer, LAN),
                        `${peer} ${JSON.stringify(headers)} trustForwarded=${trustForwarded}`,
                    );
                    assert.equal(withList.isRelayedByTrustedProxy(peer), false);
                }
            }
        }
    }
    // Spelled out for the case that matters: a direct LAN or internet client claiming to be this machine.
    const ids = identity();
    const spoof = { host: '192.168.1.20:3000', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' };
    assert.equal(ids.getClientIpFromHeaders(spoof, '203.0.113.10'), '203.0.113.10');
    assert.equal(classify(ids, spoof, '203.0.113.10', LAN).kind, 'remote');
    assert.equal(ids.shouldTrustRequestForwardedHeaders(spoof, '203.0.113.10'), false);
});

test('invariant 4: CF-Connecting-IP names the client only in the Cloudflare modes that exist without the setting', () => {
    const TUNNEL = 'https://nextra-proof.trycloudflare.com';
    const cloudflare = { host: 'nextra-proof.trycloudflare.com', 'cf-connecting-ip': '198.51.100.99', 'cf-ray': '8f00-AMS', 'x-forwarded-for': '203.0.113.5' };
    // Every Cloudflare mode switched on, and the request addressed to Nextra's own tunnel.
    const ids = identity({
        origins: [TUNNEL],
        trustForwarded: true,
        getManagedTunnelOrigin: () => TUNNEL,
        getTrustCloudflareClientIp: () => true,
    });
    // From a trusted proxy the header is the client's own writing: X-Forwarded-For decides.
    assert.equal(ids.getClientIpFromHeaders(cloudflare, PROXY), '203.0.113.5');
    assert.equal(ids.getClientIpFromHeaders({ ...cloudflare, 'x-forwarded-for': undefined }, PROXY), 'unknown');
    for (const claimed of ['127.0.0.1', '192.168.1.5']) {
        const headers = { host: '10.42.0.5:3000', 'cf-connecting-ip': claimed };
        assert.equal(ids.getClientIpFromHeaders(headers, PROXY), 'unknown', claimed);
        assert.equal(classify(ids, headers, PROXY, LAN).kind, 'known-proxy', claimed);
    }
    // From loopback the existing modes are untouched by the list.
    assert.equal(ids.getClientIpFromHeaders(cloudflare, '127.0.0.1'), '198.51.100.99');
    const noMode = identity({ origins: [], trustForwarded: true });
    assert.equal(noMode.getClientIpFromHeaders(cloudflare, '127.0.0.1'), '203.0.113.5');
});

test('invariant 5: an unset or empty TRUSTED_PROXY_CIDRS changes nothing for any peer', () => {
    const peers = ['127.0.0.1', '::1', '192.168.1.20', PROXY, '203.0.113.10', '::ffff:192.168.1.20', 'unknown'];
    for (const trustForwarded of [false, true]) {
        for (const origins of [[], ['https://stream.example.com']]) {
            const withoutSetting = createRequestIdentity({
                getKnownPublicShareOrigins: () => origins,
                getTrustForwardedHeaders: () => trustForwarded,
            });
            for (const empty of ['', '   ', undefined]) {
                const unset = createRequestIdentity({
                    getKnownPublicShareOrigins: () => origins,
                    getTrustForwardedHeaders: () => trustForwarded,
                    getTrustedProxyCidrs: () => empty,
                });
                for (const peer of peers) {
                    for (const headers of HEADER_SHAPES) {
                        assert.deepEqual(
                            describeRequest(unset, headers, peer, LAN),
                            describeRequest(withoutSetting, headers, peer, LAN),
                            `${peer} ${JSON.stringify(headers)}`,
                        );
                    }
                }
            }
        }
    }
    assert.equal(config.TRUSTED_PROXY_CIDRS, '', 'the setting must default to empty');
});

function loadConfigWith(value) {
    return spawnSync(process.execPath, [
        '-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)}).TRUSTED_PROXY_CIDRS))`,
    ], { encoding: 'utf8', env: { ...process.env, TRUSTED_PROXY_CIDRS: value } });
}

test('config validates TRUSTED_PROXY_CIDRS at startup and names the bad entry', () => {
    for (const [value, expected] of [
        ['', ''],
        ['10.42.0.0/16', '10.42.0.0/16'],
        ['  10.42.0.0/16, fd00:42::/56 , 192.0.2.7 ', '10.42.0.0/16, fd00:42::/56 , 192.0.2.7'],
    ]) {
        const result = loadConfigWith(value);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout), expected);
    }
    for (const [value, badEntry] of [
        ['10.42.0.0/16, traefik', 'traefik'],
        ['10.42.0.0/33', '10.42.0.0/33'],
        ['0.0.0.0/0', '0.0.0.0/0'],
        ['fd00::/129', 'fd00::/129'],
        ['10.42.0.0/16,127.0.0.1', '127.0.0.1'],
        ['::1', '::1'],
    ]) {
        const result = loadConfigWith(value);
        assert.notEqual(result.status, 0, `${value} was accepted`);
        assert.ok(result.stderr.includes(`Invalid TRUSTED_PROXY_CIDRS entry "${badEntry}"`), result.stderr);
    }
});

function connectSocket(baseUrl, extraHeaders) {
    return new Promise((resolve, reject) => {
        const socket = createSocketClient(baseUrl, { transports: ['websocket'], extraHeaders, reconnection: false, timeout: 5_000 });
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', (err) => {
            socket.close();
            reject(err);
        });
    });
}

function socketRequest(socket, event, payload = {}) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), 5_000);
        socket.emit(event, payload, (response) => {
            clearTimeout(timeout);
            resolve(response);
        });
    });
}

/** One join attempt on a fresh connection with these headers; the room does not exist, so only the limit differs. */
async function joinFrom(baseUrl, headers) {
    const socket = await connectSocket(baseUrl, headers);
    try {
        return await socketRequest(socket, 'join-room', { code: 'ABCDEF' });
    } finally {
        socket.close();
    }
}

function assertAdmitted(response, label) {
    assert.equal(response.success, false, label);
    assert.doesNotMatch(response.error, RATE_LIMITED, `${label} was rate-limited: it shared another client's bucket`);
}

function assertRateLimited(response, label) {
    assert.equal(response.success, false, label);
    assert.match(response.error, RATE_LIMITED, `${label} was not rate-limited: it got a bucket of its own`);
}

test('the socket handlers\' own IP fallback reads X-Forwarded-For from a trusted proxy peer and never uses its address', { concurrency: false }, async (t) => {
    const address = await findNonLoopbackAddress();
    if (!address) {
        t.skip('this machine has no non-loopback IPv4 address to connect from');
        return;
    }
    const previous = {
        TRUSTED_PROXY_CIDRS: config.TRUSTED_PROXY_CIDRS,
        TRUST_X_FORWARDED_HEADERS: config.TRUST_X_FORWARDED_HEADERS,
        TRUST_PROXY: config.TRUST_PROXY,
        JOIN_RATE_LIMIT_MAX: config.JOIN_RATE_LIMIT_MAX,
    };
    Object.assign(config, { TRUSTED_PROXY_CIDRS: address, TRUST_X_FORWARDED_HEADERS: false, TRUST_PROXY: false, JOIN_RATE_LIMIT_MAX: 1 });
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    // No getClientIp option: the handlers resolve the client themselves (getSocketIp in lib/socket.js).
    registerSocketHandlers(ioServer, {}, {});
    await new Promise((resolve) => httpServer.listen(0, '0.0.0.0', resolve));
    t.after(async () => {
        Object.assign(config, previous);
        stopJoinCleanup();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    });
    const baseUrl = `http://${address}:${httpServer.address().port}`;

    assertAdmitted(await joinFrom(baseUrl, { 'x-forwarded-for': '198.51.100.61' }), 'first client behind the proxy');
    // Had the proxy's address been the identity, this second client would share the first one's bucket.
    assertAdmitted(await joinFrom(baseUrl, { 'x-forwarded-for': '198.51.100.62' }), 'second client behind the proxy');
    assertRateLimited(await joinFrom(baseUrl, { 'x-forwarded-for': '203.0.113.99, 198.51.100.61' }), 'first client again, with a spoofed leftmost entry');
    // Without a forwarding header the client is 'unknown': one shared bucket, not the proxy's and not a free pass.
    assertAdmitted(await joinFrom(baseUrl, {}), 'first unnamed client');
    assertRateLimited(await joinFrom(baseUrl, {}), 'second unnamed client');
});

function requestFrom(host, port, { method = 'GET', pathname, headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host, port, path: pathname, method, headers }, (response) => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { text += chunk; });
            response.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: response.statusCode, headers: response.headers, json });
            });
        });
        request.once('error', reject);
        request.end(body);
    });
}

/** A real server.js on every interface. `env` may be a function of the claimed port. */
async function startServer(t, env) {
    const { port, rtcPort } = await claimServerPorts();
    const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nextra-trusted-proxy-dist-'));
    await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><div id="root"></div>');
    let output = '';
    const child = spawn(process.execPath, ['server.js'], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            NODE_ENV: 'test',
            APP_ENV: 'test',
            PORT: String(port),
            // Every interface, so the test can arrive both from loopback and from a non-loopback address.
            BIND_HOST: '0.0.0.0',
            RTC_LISTEN_IP: '127.0.0.1',
            RTC_MIN_PORT: String(rtcPort),
            RTC_MAX_PORT: String(rtcPort),
            LOCAL_HTTPS: 'false',
            OPEN_BROWSER: 'false',
            AUTO_DETECT_PUBLIC_IP: 'false',
            AUTO_PUBLIC_TUNNEL: 'false',
            CLOUDFLARED_TUNNEL_TOKEN: '',
            SHARE_BASE_URL: '',
            EXTRA_ALLOWED_ORIGINS: '',
            WHIP_ENABLED: 'false',
            WHEP_ENABLED: 'false',
            OPERATOR_HOSTNAMES: '',
            TRUSTED_PROXY_CIDRS: '',
            TRUST_PROXY: '',
            TRUST_X_FORWARDED_HEADERS: 'false',
            TRUST_CLOUDFLARE_CONNECTING_IP: 'false',
            JOIN_RATE_LIMIT_MAX: '1',
            NEXTRA_SMOKE_TEST: '1',
            NEXTRA_TEST_DIST_DIR: distDir,
            LOG_LEVEL: 'warn',
            ...(typeof env === 'function' ? env(port) : env),
        },
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    t.after(async () => {
        if (child.exitCode === null) {
            child.kill();
            await new Promise((resolve) => child.once('exit', resolve));
        }
        await fs.rm(distDir, { recursive: true, force: true });
    });
    const deadline = Date.now() + 25_000;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`server exited before readiness (code ${child.exitCode})\n${output}`);
        try {
            if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) break;
        } catch {
            // The listener may not exist yet while mediasoup initializes.
        }
        if (Date.now() > deadline) throw new Error(`server did not become ready\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { port };
}

const OPERATOR_TOKEN = 'trusted-proxy-operator-token-0123456789abcdef';

/** The first of these addresses that is not `address`: a setting that must not name the machine's own address. */
function addressOtherThan(address, ...candidates) {
    return candidates.find((candidate) => candidate !== address);
}

test('on the real server a TRUSTED_PROXY_CIDRS peer relays and is never the operator, while loopback stays local', { concurrency: false, timeout: 90_000 }, async (t) => {
    const proxy = await findNonLoopbackAddress();
    if (!proxy) {
        t.skip('this machine has no non-loopback IPv4 address to connect from');
        return;
    }
    // The proxy's own address is a trusted-LAN address too: without TRUSTED_PROXY_CIDRS it would be the operator.
    const shared = { LAN_IP: proxy, TRUSTED_LAN_CIDRS: `${proxy}, 192.168.1.0/24`, OPERATOR_TOKEN };
    const sockets = [];
    t.after(() => sockets.forEach((socket) => socket.close()));

    // Invariant 5 on the real server: the same request without the setting is a trusted-LAN operator, and its
    // forwarding headers are ignored.
    const control = await startServer(t, shared);
    const controlMetrics = (headers) => requestFrom(proxy, control.port, { pathname: '/api/metrics', headers }).then((r) => r.status);
    const ipHost = { host: `${proxy}:${control.port}` };
    assert.equal(await controlMetrics(ipHost), 200, 'the control server did not treat the trusted-LAN peer as the operator');
    assert.equal(await controlMetrics({ ...ipHost, 'x-forwarded-for': '203.0.113.9' }), 200, 'without the setting X-Forwarded-For from a LAN peer changed its identity');

    // The proxy terminates TLS, so the page's origin is https on this server's host. Socket origins are an
    // allowlist of their own; the public origin is on it the way a deployment puts it there.
    const { port } = await startServer(t, (claimedPort) => ({
        ...shared,
        TRUSTED_PROXY_CIDRS: `${proxy}/32`,
        EXTRA_ALLOWED_ORIGINS: `https://${proxy}:${claimedPort}`,
    }));
    const viaProxy = (options) => requestFrom(proxy, port, options);
    const metrics = (headers) => viaProxy({ pathname: '/api/metrics', headers }).then((r) => r.status);
    const host = { host: `${proxy}:${port}` };

    // Invariant 1: never the operator, with or without forwarding headers, whatever address is forwarded.
    assert.equal(await metrics(host), 403, 'a trusted proxy request without forwarding headers got operator metrics');
    assert.equal(await metrics({ host: `localhost:${port}` }), 403);
    assert.equal(await metrics({ ...host, 'x-forwarded-for': '127.0.0.1' }), 403, 'a forwarded loopback address got operator metrics');
    assert.equal(await metrics({ ...host, 'x-forwarded-for': '192.168.1.5' }), 403, 'a forwarded trusted-LAN address got operator metrics');
    assert.equal(await metrics({ ...host, 'x-forwarded-for': proxy }), 403, 'the proxy\'s own address, forwarded, got operator metrics');
    assert.equal(await metrics({ ...host, 'cf-connecting-ip': '127.0.0.1' }), 403);
    const relayedConfig = (await viaProxy({ pathname: '/api/config', headers: host })).json;
    assert.equal(relayedConfig.operatorAuthorized, false);
    assert.equal(relayedConfig.operatorSignInAvailable, true);
    // The operator token still works through the proxy.
    assert.equal(await metrics({ ...host, 'x-nextra-operator-token': OPERATOR_TOKEN }), 200);
    // The host's own browser on this machine is untouched by the setting.
    assert.equal((await requestFrom('127.0.0.1', port, { pathname: '/api/metrics', headers: { host: `127.0.0.1:${port}` } })).status, 200);
    const localConfig = (await requestFrom('127.0.0.1', port, { pathname: '/api/config', headers: { host: `127.0.0.1:${port}` } })).json;
    assert.equal(localConfig.operatorAuthorized, true);
    assert.equal(localConfig.operatorSignInAvailable, false);

    // X-Forwarded-Proto and X-Forwarded-Host are honoured without TRUST_X_FORWARDED_HEADERS.
    const forwarded = (await viaProxy({
        pathname: '/api/config',
        headers: { ...host, 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'stream.example.com' },
    })).json;
    assert.equal(forwarded.shareBaseUrl, 'https://stream.example.com');
    // HTTPS is detected for the host sign-in: refused as plain HTTP, accepted with the proxy's X-Forwarded-Proto.
    const signIn = (headers) => viaProxy({
        method: 'POST',
        pathname: '/api/operator/session',
        headers: { ...host, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9', ...headers },
        body: JSON.stringify({ password: OPERATOR_TOKEN }),
    });
    const plain = await signIn({ origin: `http://${proxy}:${port}` });
    assert.equal(plain.status, 400);
    assert.deepEqual(plain.json, { error: 'https_required' });
    const secure = await signIn({ origin: `https://${proxy}:${port}`, 'x-forwarded-proto': 'https' });
    assert.equal(secure.status, 204);
    assert.match(String(secure.headers['set-cookie']), /; Secure$/);
    const cookie = String(secure.headers['set-cookie']).split(';')[0];

    // The session authorizes a socket the proxy relays from the server's own page: its Origin is the handshake's
    // own origin (the Host under the proxy's X-Forwarded-Proto). The same cookie under another scheme is refused.
    const publicOrigin = `https://${proxy}:${port}`;
    const signedInSocket = await connectSocket(`http://${proxy}:${port}`, {
        Origin: publicOrigin, Cookie: cookie, 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https',
    });
    sockets.push(signedInSocket);
    const hosted = await socketRequest(signedInSocket, 'create-room', { ingestMode: 'browser' });
    assert.equal(hosted.success, true, `a host signed in through the trusted proxy could not create a room: ${hosted.error}`);
    const wrongScheme = await connectSocket(`http://${proxy}:${port}`, {
        Origin: `http://${proxy}:${port}`, Cookie: cookie, 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https',
    });
    sockets.push(wrongScheme);
    const refused = await socketRequest(wrongScheme, 'create-room', { ingestMode: 'browser' });
    assert.equal(refused.success, false, 'a session authorized a socket whose Origin is not the handshake\'s own');
    assert.match(refused.error, /Operator authorization/);

    // Invariant 2 over Socket.IO: each forwarded client has its own bucket (JOIN_RATE_LIMIT_MAX=1) and the proxy's
    // address is nobody's.
    const baseUrl = `http://${proxy}:${port}`;
    const origin = { Origin: baseUrl };
    assertAdmitted(await joinFrom(baseUrl, { ...origin, 'x-forwarded-for': '198.51.100.71' }), 'first client behind the proxy');
    assertAdmitted(await joinFrom(baseUrl, { ...origin, 'x-forwarded-for': '198.51.100.72' }), 'second client behind the proxy');
    assertRateLimited(await joinFrom(baseUrl, { ...origin, 'x-forwarded-for': '127.0.0.1, 198.51.100.71' }), 'first client again, with a spoofed leftmost entry');
    // Invariant 4: a new CF-Connecting-IP is no new bucket.
    assertRateLimited(await joinFrom(baseUrl, { ...origin, 'x-forwarded-for': '198.51.100.72', 'cf-connecting-ip': '198.51.100.73' }), 'second client with a CF-Connecting-IP');

    // Invariant 1 over Socket.IO: a relayed socket cannot create a room without the token, also with a forwarded
    // loopback address.
    const relayed = await connectSocket(baseUrl, { ...origin, 'x-forwarded-for': '127.0.0.1' });
    sockets.push(relayed);
    const denied = await socketRequest(relayed, 'create-room', { ingestMode: 'browser' });
    assert.equal(denied.success, false, 'a socket relayed by a trusted proxy created a room without the operator token');
    assert.match(denied.error, /Operator authorization/);
    const local = await connectSocket(`http://127.0.0.1:${port}`, { Origin: `http://127.0.0.1:${port}` });
    sockets.push(local);
    const created = await socketRequest(local, 'create-room', { ingestMode: 'browser' });
    assert.equal(created.success, true, `the host's own socket could not create a room: ${created.error}`);
});

test('invariant 3 on the real server: a LAN peer that is not in the list gains nothing from forwarding headers', { concurrency: false, timeout: 60_000 }, async (t) => {
    const peer = await findNonLoopbackAddress();
    if (!peer) {
        t.skip('this machine has no non-loopback IPv4 address to connect from');
        return;
    }
    // The lists name other addresses; this peer is a plain remote client.
    const trustedLan = addressOtherThan(peer, '198.51.100.5', '198.51.100.6');
    const otherProxy = addressOtherThan(peer, '203.0.113.200', '203.0.113.201');
    const { port } = await startServer(t, { LAN_IP: peer, TRUSTED_LAN_CIDRS: trustedLan, TRUSTED_PROXY_CIDRS: otherProxy, OPERATOR_TOKEN });
    const host = { host: `${peer}:${port}` };
    const get = (pathname, headers) => requestFrom(peer, port, { pathname, headers });

    for (const claim of [{}, { 'x-forwarded-for': '127.0.0.1' }, { 'x-forwarded-for': trustedLan }, { 'x-forwarded-for': otherProxy }, { 'x-real-ip': '127.0.0.1' }]) {
        assert.equal((await get('/api/metrics', { ...host, ...claim })).status, 403, JSON.stringify(claim));
    }
    // Its X-Forwarded-Proto is not believed either: the sign-in sees plain HTTP.
    const signIn = await requestFrom(peer, port, {
        method: 'POST',
        pathname: '/api/operator/session',
        headers: { ...host, origin: `https://${peer}:${port}`, 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
        body: JSON.stringify({ password: OPERATOR_TOKEN }),
    });
    assert.equal(signIn.status, 400);
    assert.deepEqual(signIn.json, { error: 'https_required' });
    // Its forwarded address picks no rate-limit bucket: both attempts are the peer's own.
    const baseUrl = `http://${peer}:${port}`;
    assertAdmitted(await joinFrom(baseUrl, { Origin: baseUrl, 'x-forwarded-for': '198.51.100.81' }), 'first attempt');
    assertRateLimited(await joinFrom(baseUrl, { Origin: baseUrl, 'x-forwarded-for': '198.51.100.82' }), 'second attempt with a new X-Forwarded-For');
});
