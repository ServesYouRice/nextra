'use strict';

// Which address a client on this machine must use to reach a listener, given the
// host the listener was asked to bind and the address it really bound. Binding
// ::1 creates no IPv4 listener and binding 127.0.0.1 creates no IPv6 one, so a
// URL advertised for the wrong family points at nothing.

const IPV4_LOOPBACK = '127.0.0.1';
const IPV6_LOOPBACK = '::1';

// Lower-case, trimmed, without the brackets of a URL-style IPv6 literal.
function normalizeHost(host) {
    const value = String(host ?? '').trim().toLowerCase();
    return value.replace(/^\[(.*)\]$/, '$1');
}

function boundAddressHost(boundAddress) {
    if (typeof boundAddress === 'string') return normalizeHost(boundAddress);
    if (boundAddress && typeof boundAddress.address === 'string') return normalizeHost(boundAddress.address);
    return '';
}

function isIpv4Loopback(host) {
    return /^127\.\d+\.\d+\.\d+$/.test(host);
}

// A host as it is written inside a URL: IPv6 literals in brackets.
function formatHostForUrl(host) {
    if (!host) return IPV4_LOOPBACK;
    if (host.includes(':') && !host.startsWith('[')) {
        return `[${host}]`;
    }
    return host;
}

/**
 * The host a client on this machine puts in a URL for a listener.
 *
 * - a specific address (IPv4 or IPv6) is returned as it is;
 * - '::1' and '[::1]' give '::1';
 * - '0.0.0.0' gives '127.0.0.1';
 * - '::' gives '127.0.0.1' for a dual-stack socket, which is what Node binds unless ipv6Only is set, and '::1'
 *   when `dualStack` is false (the IPv4 loopback is then not served);
 * - 'localhost' follows `boundAddress` (what server.address() reported), because the name may have resolved to
 *   ::1 or to 127.0.0.1; before the listener is up it gives '127.0.0.1'.
 *
 * `boundAddress` is the object server.address() returns, or its address string. The result has no brackets; pass it
 * to formatHostForUrl for a URL.
 */
function clientHostForBoundAddress(configuredHost, boundAddress = null, { dualStack = true } = {}) {
    const configured = normalizeHost(configuredHost) || IPV4_LOOPBACK;
    if (configured === '0.0.0.0') return IPV4_LOOPBACK;
    if (configured === '::') return dualStack ? IPV4_LOOPBACK : IPV6_LOOPBACK;
    if (configured === 'localhost') {
        const bound = boundAddressHost(boundAddress);
        return bound === IPV6_LOOPBACK || isIpv4Loopback(bound) ? bound : IPV4_LOOPBACK;
    }
    return configured;
}

/** True when the listener is on the IPv6 loopback, which only [::1] URLs reach. */
function isBoundToIpv6Loopback(configuredHost, boundAddress = null) {
    return (boundAddressHost(boundAddress) || normalizeHost(configuredHost)) === IPV6_LOOPBACK;
}

/**
 * The hosts to try, in order, when looking for another Nextra on this port. Besides the address a client would
 * use, a Nextra bound to the other loopback family may hold the port: ::1 also tries 127.0.0.1, and 'localhost'
 * tries both.
 */
function probeHostsForBindHost(configuredHost, boundAddress = null) {
    const configured = normalizeHost(configuredHost) || IPV4_LOOPBACK;
    const hosts = [clientHostForBoundAddress(configured, boundAddress), IPV4_LOOPBACK];
    if (configured === 'localhost') hosts.push(IPV6_LOOPBACK);
    return [...new Set(hosts)];
}

module.exports = {
    clientHostForBoundAddress,
    formatHostForUrl,
    isBoundToIpv6Loopback,
    probeHostsForBindHost,
};
