const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

async function loadSocketOptions() {
    const { createSocketOptions } = await import('../src/lib/socketOptions.mjs');
    return createSocketOptions();
}

test('client socket options prefer WebSocket and enable the long-polling fallback', async () => {
    const options = await loadSocketOptions();
    assert.equal(options.path, '/socket.io');
    assert.equal(options.autoConnect, false);
    assert.deepEqual(options.transports, ['websocket', 'polling']);
    assert.equal(options.tryAllTransports, true);
});

test('client connects over long-polling when WebSocket upgrades are blocked', { concurrency: false }, async () => {
    const options = await loadSocketOptions();
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer, { transports: ['websocket', 'polling'] });
    // Block WebSocket at the network level: every upgrade request is dropped.
    httpServer.removeAllListeners('upgrade');
    httpServer.on('upgrade', (req, socket) => socket.destroy());
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    const client = createClient(`http://127.0.0.1:${port}`, options);

    try {
        client.connect();
        const connected = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), 4_000);
            client.once('connect', () => {
                clearTimeout(timer);
                resolve(client.io.engine.transport.name === 'polling');
            });
        });
        assert.equal(connected, true, 'socket did not connect over long-polling while WebSocket was blocked');
    } finally {
        client.close();
        ioServer.close();
        httpServer.close();
    }
});
