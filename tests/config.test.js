const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config');

test('Opus codec keeps in-band FEC enabled without forcing DTX', () => {
    const opusCodec = config.MEDIA_CODECS.find(
        (codec) => codec.kind === 'audio' && codec.mimeType === 'audio/opus'
    );

    assert.ok(opusCodec, 'Expected an Opus audio codec entry.');
    assert.equal(opusCodec.parameters?.useinbandfec, 1);
    assert.equal(opusCodec.parameters?.usedtx, undefined);
});

test('Router media codecs advertise AV1 alongside the stable H.264 profiles', () => {
    const av1Codec = config.MEDIA_CODECS.find(
        (codec) => codec.kind === 'video' && codec.mimeType === 'video/AV1'
    );

    assert.ok(av1Codec, 'Expected an AV1 router codec entry.');
    assert.equal(av1Codec.clockRate, 90000);
});

test('buildIceServers returns STUN-only defaults when TURN is not configured', () => {
    const servers = config.buildIceServers(null);

    assert.deepEqual(servers, config.DEFAULT_STUN_SERVERS);
    assert.equal(config.iceServersIncludeTurn(servers), false);
});

test('buildIceServers derives ephemeral TURN credentials from a shared secret', () => {
    const servers = config.buildIceServers({
        urls: ['turn:room-turn.example.com:3478?transport=udp'],
        authType: 'secret',
        secret: 'room-secret',
    });

    const turnEntry = servers.find((server) => String(server.urls || '').startsWith('turn:'));
    assert.ok(turnEntry, 'Expected a TURN server entry.');
    assert.match(turnEntry.username, /^\d+:nextra$/);
    assert.ok(turnEntry.credential);
    assert.equal(config.iceServersIncludeTurn(servers), true);
});

test('buildIceServers preserves static TURN credentials', () => {
    const servers = config.buildIceServers({
        urls: ['turns:room-turn.example.com:5349?transport=tcp'],
        authType: 'static',
        username: 'viewer-user',
        credential: 'viewer-pass',
    });

    const turnEntry = servers.find((server) => String(server.urls || '').startsWith('turns:'));
    assert.ok(turnEntry, 'Expected a TURNS server entry.');
    assert.equal(turnEntry.username, 'viewer-user');
    assert.equal(turnEntry.credential, 'viewer-pass');
});

test('Cloudflare TURN autofill availability follows runtime config values', () => {
    const previousKeyId = config.CLOUDFLARE_TURN_KEY_ID;
    const previousApiToken = config.CLOUDFLARE_TURN_API_TOKEN;

    try {
        config.CLOUDFLARE_TURN_KEY_ID = '';
        config.CLOUDFLARE_TURN_API_TOKEN = '';
        assert.equal(config.hasCloudflareTurnCredentialSource(), false);

        config.CLOUDFLARE_TURN_KEY_ID = 'turn-key-id';
        config.CLOUDFLARE_TURN_API_TOKEN = 'turn-api-token';
        assert.equal(config.hasCloudflareTurnCredentialSource(), true);
    } finally {
        config.CLOUDFLARE_TURN_KEY_ID = previousKeyId;
        config.CLOUDFLARE_TURN_API_TOKEN = previousApiToken;
    }
});

test('bitrate defaults reflect the finalized H.264 plan', () => {
    assert.equal(config.CODEC_OPTIONS.videoGoogleStartBitrate, 5_000);
    assert.equal(config.RELAY_VIDEO_BITS_PER_SECOND, 45_000_000);
});

test('production safety limits include room creation throttles', () => {
    assert.equal(config.MAX_ACTIVE_ROOMS, 100);
    assert.equal(config.CREATE_ROOM_RATE_LIMIT_MAX, 10);
    assert.equal(config.CREATE_ROOM_RATE_LIMIT_WINDOW_MS, 60000);
    assert.equal(config.JOIN_RATE_LIMIT_MAX, 20);
    assert.equal(config.JOIN_RATE_LIMIT_WINDOW_MS, 60000);
});

test('socket heartbeat defaults tolerate slow watcher links', () => {
    assert.equal(config.SOCKET_PING_INTERVAL_MS, 25000);
    assert.equal(config.SOCKET_PING_TIMEOUT_MS, 60000);
});
