const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const { canListenOnPort, findAvailablePort } = require('../lib/portResolver');

function listen(server, port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.removeListener('error', reject);
            resolve(server.address());
        });
    });
}

function close(server) {
    return new Promise((resolve, reject) => {
        server.close((err) => {
            if (err) {
                reject(err);
                return;
            }
            resolve();
        });
    });
}

test('canListenOnPort detects when a TCP port is occupied', async () => {
    const server = net.createServer();
    const address = await listen(server, 0);

    try {
        const available = await canListenOnPort({ port: address.port, host: '127.0.0.1' });
        assert.equal(available, false);
    } finally {
        await close(server);
    }
});

test('findAvailablePort skips occupied and reserved ports', async () => {
    const server = net.createServer();
    const address = await listen(server, 0);

    try {
        const resolved = await findAvailablePort({
            preferredPort: address.port,
            host: '127.0.0.1',
            reservedPorts: [address.port + 1],
            maxAttempts: 5,
        });

        // Other processes may legitimately occupy candidates in the ephemeral
        // range while the suite runs in parallel. The contract is to skip the
        // occupied preferred port and the explicitly reserved candidate, not to
        // promise that the very next unreserved integer is free.
        assert.ok(resolved > address.port);
        assert.notEqual(resolved, address.port + 1);
    } finally {
        await close(server);
    }
});
