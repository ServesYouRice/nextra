'use strict';

// A non-loopback IPv4 address of this machine, for tests that need a TCP peer that is not 127.0.0.1: a reverse proxy
// on "another address" (TRUSTED_PROXY_CIDRS). A connection from this machine to one of its own addresses arrives
// with that address as its peer, so a listener on 0.0.0.0 sees a non-loopback client without a second machine.
//
// Not every machine can do that (no network interface, a sandbox that only routes loopback), so the address is
// proven first: a throwaway listener on 0.0.0.0 must receive a connection whose peer is the candidate. Tests skip
// themselves when no address passes.

const net = require('node:net');
const os = require('node:os');

function probe(address) {
    return new Promise((resolve) => {
        const server = net.createServer((socket) => {
            const peer = String(socket.remoteAddress || '').replace(/^::ffff:/, '');
            socket.destroy();
            finish(peer === address);
        });
        let client = null;
        let settled = false;
        const timer = setTimeout(() => finish(false), 2_000);
        function finish(ok) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            client?.destroy();
            server.close(() => resolve(ok));
        }
        server.once('error', () => finish(false));
        server.listen(0, '0.0.0.0', () => {
            client = net.connect({ host: address, port: server.address().port });
            client.once('error', () => finish(false));
        });
    });
}

/** @returns {Promise<string|null>} an address a listener on 0.0.0.0 sees as a non-loopback peer, or null. */
async function findNonLoopbackAddress() {
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const entry of addresses || []) {
            if (entry.family !== 'IPv4' || entry.internal || /^169\.254\./.test(entry.address)) continue;
            if (await probe(entry.address)) return entry.address;
        }
    }
    return null;
}

module.exports = { findNonLoopbackAddress };
