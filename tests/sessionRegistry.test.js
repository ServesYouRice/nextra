const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionRegistry } = require('../lib/sessionRegistry');

test('SessionRegistry owns room/socket and protocol resource mappings', () => {
    const registry = new SessionRegistry();
    const room = { code: 'ABC123', hostSocketId: 'host', viewers: new Set(['viewer']), whipResourceId: 'whip' };
    registry.rooms.set(room.code, room);
    registry.mapSocket('host', room.code);
    registry.mapSocket('viewer', room.code);
    registry.registerWhipResource('whip', room.code);
    assert.equal(registry.roomForSocket('viewer'), room);
    assert.equal(registry.roomCodeForWhipResource('whip'), room.code);
    registry.clearRoomMappings(room);
    assert.equal(registry.roomForSocket('viewer'), null);
    assert.equal(registry.roomCodeForWhipResource('whip'), null);
});

test('SessionRegistry WHEP admission is atomic and reservations release once', () => {
    const registry = new SessionRegistry();
    const first = registry.tryReserveWhep({
        roomCode: 'ABC123', socketViewers: 0, activeRoomSessions: 0, globalLimit: 1, roomLimit: 1,
    });
    assert.equal(first.ok, true);
    assert.deepEqual(registry.tryReserveWhep({
        roomCode: 'ABC123', socketViewers: 0, activeRoomSessions: 0, globalLimit: 1, roomLimit: 1,
    }), { ok: false, reason: 'global-capacity' });
    assert.equal(first.release(), true);
    assert.equal(first.release(), false);
    assert.equal(registry.pendingWhepGlobal, 0);
});
