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

const MAX_PORT = 65535;

// Records every port handed to net.Server#listen while `run` is in flight.
async function recordListenedPorts(run) {
    const tried = [];
    const originalListen = net.Server.prototype.listen;
    net.Server.prototype.listen = function listenSpy(port, ...rest) {
        tried.push(port);
        return originalListen.call(this, port, ...rest);
    };

    try {
        await run();
    } finally {
        net.Server.prototype.listen = originalListen;
    }
    return tried;
}

test('findAvailablePort ends with its own error when every port up to 65535 is reserved', async () => {
    const tried = await recordListenedPorts(() => assert.rejects(
        findAvailablePort({
            preferredPort: MAX_PORT - 2,
            host: '127.0.0.1',
            reservedPorts: [MAX_PORT - 2, MAX_PORT - 1, MAX_PORT],
            maxAttempts: 25,
        }),
        (err) => {
            assert.match(err.message, /Could not find an available port starting at 65533 on 127\.0\.0\.1\./);
            assert.notEqual(err.code, 'ERR_SOCKET_BAD_PORT');
            return true;
        }
    ));

    assert.deepEqual(tried.filter((port) => port > MAX_PORT), []);
});

test('findAvailablePort ends with its own error when the last port is occupied', async () => {
    // Occupy port 65535 ourselves. If something else on the machine already
    // holds it the result is the same, so that is not a reason to skip.
    const blocker = net.createServer();
    let blocking = false;
    try {
        await listen(blocker, MAX_PORT);
        blocking = true;
    } catch (err) {
        if (err?.code !== 'EADDRINUSE' && err?.code !== 'EACCES') throw err;
    }

    try {
        const tried = await recordListenedPorts(() => assert.rejects(
            findAvailablePort({ preferredPort: MAX_PORT, host: '127.0.0.1', maxAttempts: 25 }),
            (err) => {
                assert.match(err.message, /Could not find an available port starting at 65535 on 127\.0\.0\.1\./);
                assert.notEqual(err.code, 'ERR_SOCKET_BAD_PORT');
                return true;
            }
        ));

        assert.deepEqual(tried.filter((port) => port > MAX_PORT), []);
    } finally {
        if (blocking) await close(blocker);
    }
});

test('findAvailablePort rejects a preferred port above 65535 as invalid', async () => {
    await assert.rejects(
        findAvailablePort({ preferredPort: MAX_PORT + 1, host: '127.0.0.1' }),
        /Invalid preferred port: 65536/
    );
});

// Port 0 can land at the very top of the range (Windows hands out 49152-65535),
// where the candidates above it run out of range. Draw again until the port
// leaves `room` ports above it; the rejected listeners stay open until then so
// the operating system cannot hand the same port out twice.
async function listenWithRoomAbove(room) {
    const rejected = [];
    try {
        for (let draw = 0; draw < 50; draw += 1) {
            const server = net.createServer();
            const address = await listen(server, 0);
            if (address.port + room <= MAX_PORT) {
                return { server, address };
            }
            rejected.push(server);
        }
        throw new Error(`No ephemeral port with ${room} ports of room above it after 50 draws.`);
    } finally {
        await Promise.all(rejected.map(close));
    }
}

test('findAvailablePort skips occupied and reserved ports', async () => {
    const { server, address } = await listenWithRoomAbove(100);

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
