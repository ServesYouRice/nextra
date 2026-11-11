const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const { destroyRoom, findRoomByCode } = require('../lib/rooms');
const { registerSocketHandlers, stopJoinCleanup } = require('../lib/socket');

// A host page that stops (Stop Sharing, Leave and Stop, the capture ending)
// while its socket is down: Socket.IO buffers the host-stopped and sends it on
// the next connection, before 'connect' and so before any reclaim. That
// connection does not host the room, so the stop has to say which room it ends
// and prove it may.

function request(client, event, data = {}) {
    return new Promise((resolve) => client.emit(event, data, resolve));
}

function within(ms, what, promise) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${what}: nothing within ${ms} ms`)), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

async function startServer() {
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer, {});
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    const clients = [];
    return {
        async connect(options = {}) {
            const client = createClient(`http://127.0.0.1:${port}`, {
                transports: ['websocket'],
                forceNew: true,
                reconnection: false,
                ...options,
            });
            clients.push(client);
            await new Promise((resolve, reject) => {
                client.once('connect', resolve);
                client.once('connect_error', reject);
            });
            return client;
        },
        async close() {
            clients.forEach((client) => client.close());
            stopJoinCleanup();
            await ioServer.close();
            await new Promise((resolve) => httpServer.close(resolve));
        },
    };
}

// A viewer of `code` that records the room states it is sent; `ended` settles
// with the first terminal one.
async function joinAsViewer(server, code) {
    const viewer = await server.connect();
    assert.equal((await request(viewer, 'join-room', { code })).success, true);
    const states = [];
    let resolveEnded;
    const ended = new Promise((resolve) => { resolveEnded = resolve; });
    for (const event of ['host-disconnected', 'host-reconnected']) {
        viewer.on(event, (state) => {
            states.push(state.code);
            if (state.terminal === true) resolveEnded(state);
        });
    }
    return { viewer, states, ended };
}

// A room with one viewer whose host's connection has gone: the server holds
// the room for the host's reconnect window. `next` is the host page's next
// connection.
async function roomWhoseHostDropped(server) {
    const host = await server.connect();
    const created = await request(host, 'create-room', { ingestMode: 'browser' });
    assert.equal(created.success, true);
    const hostSocketId = host.id;
    const viewer = await joinAsViewer(server, created.code);

    const dropped = new Promise((resolve) => viewer.viewer.once('host-disconnected', resolve));
    host.close();
    assert.equal((await dropped).recoverable, true, 'the server held the room for its host');

    const next = await server.connect();
    return { code: created.code, hostToken: created.hostToken, hostSocketId, viewer, next };
}

// The events of one connection are handled in order, so once a later request
// is answered the host-stopped before it has been handled.
async function sendHostStopped(client, ...payload) {
    client.emit('host-stopped', ...payload);
    assert.deepEqual(await request(client, 'leave-room'), { success: true });
}

async function roomGone(code, ms) {
    const deadline = Date.now() + ms;
    while (findRoomByCode(code) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    return findRoomByCode(code) === null;
}

test('a host-stopped the host page buffered while its socket was down ends the room as soon as it is sent', { concurrency: false }, async () => {
    const server = await startServer();
    let code = null;
    try {
        // The host page's own socket, reconnecting the way the page's does.
        const host = await server.connect({ reconnection: true, reconnectionDelay: 50, randomizationFactor: 0 });
        const created = await request(host, 'create-room', { ingestMode: 'browser' });
        assert.equal(created.success, true);
        code = created.code;
        const hostSocketId = host.id;
        const { states, ended } = await joinAsViewer(server, code);

        // The link drops and the host stops before the socket is back: the
        // page's stop goes into Socket.IO's send buffer.
        const stoppedWhileDown = new Promise((resolve) => host.once('disconnect', () => {
            assert.equal(host.connected, false);
            host.emit('host-stopped', { code, hostToken: created.hostToken, hostSocketIds: [hostSocketId] });
            resolve();
        }));
        host.io.engine.close();
        await stoppedWhileDown;
        await within(5_000, 'the host socket reconnecting', new Promise((resolve) => host.once('connect', resolve)));
        assert.notEqual(host.id, hostSocketId, 'the stop went out on a new connection');

        assert.deepEqual(await within(1_000, 'the viewer told the room ended', ended), {
            code: 'host-stopped',
            reason: 'Host stopped sharing',
            recoverable: false,
            terminal: true,
        });
        assert.deepEqual(states, ['host-disconnected', 'host-stopped'], 'what the viewer was told');
        assert.equal(findRoomByCode(code), null, 'the room the host stopped');
        code = null;
    } finally {
        if (code) destroyRoom(code);
        await server.close();
    }
});

test('a host-stopped from another connection without the room\'s own host token ends nothing', { concurrency: false }, async () => {
    const server = await startServer();
    const codes = [];
    try {
        const { code, hostToken, hostSocketId, viewer, next } = await roomWhoseHostDropped(server);
        codes.push(code);
        const otherHost = await server.connect();
        const other = await request(otherHost, 'create-room', { ingestMode: 'browser' });
        assert.equal(other.success, true);
        codes.push(other.code);
        assert.notEqual(other.hostToken, hostToken);

        await sendHostStopped(next);
        await sendHostStopped(next, null);
        await sendHostStopped(next, { code, hostSocketIds: [hostSocketId] });
        await sendHostStopped(next, { code, hostToken: '', hostSocketIds: [hostSocketId] });
        await sendHostStopped(next, { code, hostToken: 'f'.repeat(hostToken.length), hostSocketIds: [hostSocketId] });
        await sendHostStopped(next, { code, hostToken: hostToken.slice(0, -1), hostSocketIds: [hostSocketId] });
        await sendHostStopped(next, { code, hostToken: other.hostToken, hostSocketIds: [hostSocketId] });
        // The right token with the other room's code.
        await sendHostStopped(next, { code: other.code, hostToken, hostSocketIds: [hostSocketId, otherHost.id] });

        assert.ok(findRoomByCode(code), 'the room whose token was not given');
        assert.ok(findRoomByCode(other.code), 'the other room');
        assert.deepEqual(viewer.states, ['host-disconnected'], 'what the viewer was told');
    } finally {
        codes.forEach((code) => destroyRoom(code));
        await server.close();
    }
});

test('a stopped page\'s host-stopped does not end the room once another connection has reclaimed it', { concurrency: false }, async () => {
    const server = await startServer();
    let code = null;
    try {
        const room = await roomWhoseHostDropped(server);
        code = room.code;
        const { hostToken, hostSocketId, viewer, next } = room;

        // The same room taken over meanwhile, with the same token (it does not
        // change for the room's life), from a connection the stopped page
        // never had.
        const newer = await server.connect();
        assert.equal((await request(newer, 'reclaim-host', { code, hostToken })).success, true);
        await sendHostStopped(next, { code, hostToken, hostSocketIds: [hostSocketId] });
        // Socket ids that do not name the room's host.
        await sendHostStopped(next, { code, hostToken, hostSocketIds: [next.id, 'not-a-socket'] });
        await sendHostStopped(next, { code, hostToken, hostSocketIds: [] });
        await sendHostStopped(next, { code, hostToken, hostSocketIds: newer.id });
        // More ids than a page sends, the host's among them.
        await sendHostStopped(next, {
            code,
            hostToken,
            hostSocketIds: [...Array.from({ length: 16 }, (_, n) => `other-${n}`), newer.id],
        });

        assert.equal(findRoomByCode(code)?.hostSocketId, newer.id, 'the reclaimed room and its host');
        assert.deepEqual(viewer.states, ['host-disconnected', 'host-reconnected'], 'what the viewer was told');

        // The room's host still stops it from its own connection, as before.
        newer.emit('host-stopped');
        assert.equal((await within(1_000, 'the viewer told the room ended', viewer.ended)).code, 'host-stopped');
        assert.equal(await roomGone(code, 1_000), true, 'the room ended');
        code = null;
    } finally {
        if (code) destroyRoom(code);
        await server.close();
    }
});
