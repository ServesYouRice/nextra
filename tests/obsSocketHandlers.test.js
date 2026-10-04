const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const { findRoomBySocket, destroyRoom } = require('../lib/rooms');
const { registerSocketHandlers, stopJoinCleanup } = require('../lib/socket');

function request(client, event, data = {}) {
    return new Promise((resolve) => client.emit(event, data, resolve));
}

async function withServer(t, options) {
    const httpServer = http.createServer();
    const ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer, {}, options);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    const clients = [];
    const rooms = [];
    t.after(async () => {
        for (const client of clients) client.close();
        for (const code of rooms) destroyRoom(code);
        stopJoinCleanup();
        await ioServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    });
    return {
        async connect() {
            const client = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
            clients.push(client);
            await new Promise((resolve) => client.once('connect', resolve));
            return client;
        },
        async host(client, ingestMode) {
            const created = await request(client, 'create-room', { ingestMode });
            assert.equal(created.success, true);
            rooms.push(findRoomBySocket(client.id).code);
        },
    };
}

const settings = { rate_control: 'CBR', bitrate: 18000, keyint_sec: 1, bf: 0 };

test('only the host of an OBS room can have OBS encoder settings written', { concurrency: false }, async (t) => {
    const calls = [];
    const server = await withServer(t, {
        applyObsEncoderSettings: (_socket, payload) => {
            calls.push(payload);
            return payload.profileName === 'Streaming' ? { ok: true, path: 'ignored' } : { ok: false, reason: 'profile-not-found' };
        },
    });

    const stranger = await server.connect();
    assert.deepEqual(await request(stranger, 'obs-encoder-settings', { profileName: 'Streaming', settings }),
        { success: false, error: 'Not hosting an OBS room.' });

    const browserHost = await server.connect();
    await server.host(browserHost, 'browser');
    assert.equal((await request(browserHost, 'obs-encoder-settings', { profileName: 'Streaming', settings })).success, false);
    assert.deepEqual(calls, []);

    const obsHost = await server.connect();
    await server.host(obsHost, 'obs');
    assert.deepEqual(await request(obsHost, 'obs-encoder-settings', { profileName: 'Streaming', settings }),
        { success: true, applied: true, reason: null });
    assert.deepEqual(calls, [{ profileName: 'Streaming', settings }]);

    // The server's answer never includes where the file is.
    assert.deepEqual(await request(obsHost, 'obs-encoder-settings', { profileName: 'Other', settings }),
        { success: true, applied: false, reason: 'profile-not-found' });
    // A profile name is text of a bounded length, whatever the page sends.
    await request(obsHost, 'obs-encoder-settings', { profileName: { toString: () => 'Streaming' }, settings });
    await request(obsHost, 'obs-encoder-settings', { profileName: 'x'.repeat(5000), settings });
    assert.equal(calls[2].profileName, '');
    assert.equal(calls[3].profileName.length, 200);
});

test('only the host of an OBS room is told which encoders OBS has', { concurrency: false }, async (t) => {
    let encoders = ['obs_nvenc_h264_tex', 'obs_x264'];
    const server = await withServer(t, { listObsEncoders: () => encoders });

    const stranger = await server.connect();
    assert.deepEqual(await request(stranger, 'obs-encoders'), { success: false, error: 'Not hosting an OBS room.' });

    const obsHost = await server.connect();
    await server.host(obsHost, 'obs');
    assert.deepEqual(await request(obsHost, 'obs-encoders'), { success: true, encoders: ['obs_nvenc_h264_tex', 'obs_x264'] });

    encoders = null;
    assert.deepEqual(await request(obsHost, 'obs-encoders'), { success: true, encoders: null });
});

test('without a server that manages OBS, nothing is written and nothing is known', { concurrency: false }, async (t) => {
    const server = await withServer(t, {});
    const obsHost = await server.connect();
    await server.host(obsHost, 'obs');

    assert.deepEqual(await request(obsHost, 'obs-encoder-settings', { profileName: 'Streaming', settings }),
        { success: true, applied: false, reason: 'unavailable' });
    assert.deepEqual(await request(obsHost, 'obs-encoders'), { success: true, encoders: null });
});
