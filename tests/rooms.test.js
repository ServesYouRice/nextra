const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createRoom,
    joinRoom,
    findRoomByCode,
    findRoomByHost,
    findRoomBySocket,
    reclaimHostRoom,
    removeViewer,
    destroyRoom,
    refreshRoomIceServers,
    startRoomCleanup,
    stopRoomCleanup,
    verifyRoomPassphrase,
    prepareRoom,
} = require('../lib/rooms');
const config = require('../config');

test('room lifecycle tracks host and viewer membership', { concurrency: false }, async () => {
    const room = await createRoom('host-a');

    try {
        assert.equal(findRoomByCode(room.code)?.code, room.code);
        assert.equal(findRoomByHost('host-a')?.code, room.code);

        const joinedRoom = joinRoom(room.code, 'viewer-a');
        assert.equal(joinedRoom?.code, room.code);
        assert.equal(findRoomBySocket('viewer-a')?.code, room.code);

        const updatedRoom = removeViewer('viewer-a');
        assert.equal(updatedRoom?.code, room.code);
        assert.equal(findRoomBySocket('viewer-a'), null);
    } finally {
        destroyRoom(room.code);
    }
});

test('reclaimHostRoom swaps host ownership using the host token', { concurrency: false }, async () => {
    const room = await createRoom('host-old');

    try {
        const reclaimedRoom = reclaimHostRoom(room.code, 'host-new', room.hostToken);
        assert.equal(reclaimedRoom?.code, room.code);
        assert.equal(findRoomByHost('host-old'), null);
        assert.equal(findRoomByHost('host-new')?.code, room.code);
    } finally {
        destroyRoom(room.code);
    }
});

test('optional room passphrases are salted, hashed, and asynchronously verified', { concurrency: false }, async () => {
    const first = await createRoom('host-protected-a', { passphrase: 'correct horse battery staple' });
    const second = await createRoom('host-protected-b', { passphrase: 'correct horse battery staple' });
    try {
        assert.ok(Buffer.isBuffer(first.passphraseSalt));
        assert.ok(Buffer.isBuffer(first.passphraseHash));
        assert.notDeepEqual(first.passphraseSalt, second.passphraseSalt);
        assert.notDeepEqual(first.passphraseHash, second.passphraseHash);
        assert.equal(await verifyRoomPassphrase(first, 'correct horse battery staple'), true);
        assert.equal(await verifyRoomPassphrase(first, 'wrong'), false);
        assert.equal(await verifyRoomPassphrase(first, ''), false);
    } finally {
        destroyRoom(first.code);
        destroyRoom(second.code);
    }
});

test('room passphrase hashing yields to the event loop and failures allocate nothing', { concurrency: false }, async () => {
    let eventLoopAdvanced = false;
    const tick = new Promise((resolve) => setImmediate(() => {
        eventLoopAdvanced = true;
        resolve();
    }));
    const roomPromise = createRoom('host-async-hash', { passphrase: 'responsive hashing' });
    const room = await roomPromise;
    try {
        assert.equal(eventLoopAdvanced, true);
        await tick;
        assert.equal(await verifyRoomPassphrase(room, 'responsive hashing'), true);
    } finally {
        destroyRoom(room.code);
    }

    const before = findRoomByHost('host-hash-failure');
    await assert.rejects(prepareRoom('host-hash-failure', {
        passphrase: 'will fail',
        scrypt: (_passphrase, _salt, _length, callback) => {
            setImmediate(() => callback(new Error('injected scrypt failure')));
        },
    }), /injected scrypt failure/);
    assert.equal(findRoomByHost('host-hash-failure'), before);
});

test('unprotected rooms remain joinable and reload recovery is opt-in', { concurrency: false }, async () => {
    const defaultRoom = await createRoom('host-default');
    const recoverableRoom = await createRoom('host-recoverable', { reloadRecoveryEnabled: true });
    try {
        assert.equal(await verifyRoomPassphrase(defaultRoom, ''), true);
        assert.equal(defaultRoom.reloadRecoveryEnabled, false);
        assert.equal(recoverableRoom.reloadRecoveryEnabled, true);
    } finally {
        destroyRoom(defaultRoom.code);
        destroyRoom(recoverableRoom.code);
    }
});

test('AV1 OBS rooms keep room-scoped TURN config in memory and disable relay fallback', { concurrency: false }, async () => {
    const room = await createRoom('host-av1', {
        ingestMode: 'obs',
        obsAv1Mode: true,
        turnConfig: {
            urls: ['turn:room-turn.example.com:3478?transport=udp'],
            authType: 'secret',
            secret: 'room-secret',
        },
    });

    try {
        assert.equal(room.obsAv1Mode, true);
        assert.equal(room.obsVideoCodec, 'av1');
        assert.equal(room.relayAllowed, false);
        assert.equal(room.relaySupported, false);
        assert.equal(room.turnConfig?.secret, 'room-secret');
        assert.equal(room.hasRoomTurnServer, true);
        assert.ok(room.iceServers.some((server) => String(server.urls || '').startsWith('turn:')));

        const joinedRoom = joinRoom(room.code, 'viewer-av1');
        assert.equal(joinedRoom?.hasRoomTurnServer, true);
    } finally {
        destroyRoom(room.code);
    }

    assert.equal(findRoomByCode(room.code), null);
});

test('room-scoped TURN ICE overrides global TURN config and is cleared with the room', { concurrency: false }, async () => {
    const previousTurnUrl = config.TURN_URL;
    const previousTurnSecret = config.TURN_SECRET;
    const previousTurnUsername = config.TURN_USERNAME;
    const previousTurnCredential = config.TURN_CREDENTIAL;

    config.TURN_URL = 'turn:global-turn.example.com:3478?transport=udp';
    config.TURN_SECRET = 'global-secret';
    config.TURN_USERNAME = '';
    config.TURN_CREDENTIAL = '';

    const room = await createRoom('host-room-turn', {
        ingestMode: 'obs',
        obsAv1Mode: true,
        turnConfig: {
            urls: ['turns:room-turn.example.com:5349?transport=tcp'],
            authType: 'static',
            username: 'room-user',
            credential: 'room-pass',
        },
    });

    try {
        const roomIceServers = refreshRoomIceServers(room);
        assert.ok(roomIceServers.some((server) => String(server.urls || '').startsWith('turns:room-turn.example.com')));
        assert.equal(roomIceServers.some((server) => String(server.urls || '').startsWith('turn:global-turn.example.com')), false);
    } finally {
        destroyRoom(room.code);
        config.TURN_URL = previousTurnUrl;
        config.TURN_SECRET = previousTurnSecret;
        config.TURN_USERNAME = previousTurnUsername;
        config.TURN_CREDENTIAL = previousTurnCredential;
    }

    const plainRoom = await createRoom('host-no-turn');
    try {
        assert.equal(plainRoom.turnConfig, null);
    } finally {
        destroyRoom(plainRoom.code);
    }
});

test('startRoomCleanup can delegate stale-room teardown to a callback', { concurrency: false }, async () => {
    const room = await createRoom('host-stale');
    const previousInterval = config.ROOM_HEARTBEAT_INTERVAL_MS;
    const previousTimeout = config.ROOM_STALE_TIMEOUT_MS;
    const cleanedRooms = [];

    try {
        config.ROOM_HEARTBEAT_INTERVAL_MS = 10;
        config.ROOM_STALE_TIMEOUT_MS = 5;
        room.lastHeartbeat = Date.now() - 1000;

        startRoomCleanup({
            onStaleRoom: (staleRoom) => {
                cleanedRooms.push(staleRoom.code);
                destroyRoom(staleRoom.code);
                return true;
            },
        });

        await new Promise((resolve) => setTimeout(resolve, 40));

        assert.deepEqual(cleanedRooms, [room.code]);
        assert.equal(findRoomByCode(room.code), null);
    } finally {
        stopRoomCleanup();
        config.ROOM_HEARTBEAT_INTERVAL_MS = previousInterval;
        config.ROOM_STALE_TIMEOUT_MS = previousTimeout;
        destroyRoom(room.code);
    }
});
