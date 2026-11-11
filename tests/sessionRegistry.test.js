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

test('SessionRegistry.unmapSocketIfRoom deletes a mapping only while it points at that room', () => {
    const registry = new SessionRegistry();
    registry.mapSocket('socket', 'ROOMA1');

    assert.equal(registry.unmapSocketIfRoom('socket', 'ROOMB2'), false);
    assert.equal(registry.socketToRoom.get('socket'), 'ROOMA1');
    assert.equal(registry.unmapSocketIfRoom('missing', 'ROOMA1'), false);
    assert.equal(registry.unmapSocketIfRoom('socket', 'ROOMA1'), true);
    assert.equal(registry.socketToRoom.has('socket'), false);
});

test('SessionRegistry.clearRoomMappings leaves sockets that now belong to another room mapped', () => {
    const registry = new SessionRegistry();
    const roomA = { code: 'ROOMA1', hostSocketId: 'host-a', viewers: new Set(['stayer', 'mover']), whipResourceId: 'whip-a' };
    const roomB = { code: 'ROOMB2', hostSocketId: 'host-b', viewers: new Set(['mover']) };
    registry.rooms.set(roomA.code, roomA);
    registry.rooms.set(roomB.code, roomB);
    registry.mapSocket('host-a', roomA.code);
    registry.mapSocket('stayer', roomA.code);
    registry.mapSocket('mover', roomB.code);
    // The host socket of A has since been mapped to B as well.
    registry.mapSocket('host-a', roomB.code);
    registry.registerWhipResource('whip-a', roomA.code);

    registry.clearRoomMappings(roomA);

    assert.equal(registry.socketToRoom.has('stayer'), false);
    assert.equal(registry.socketToRoom.get('mover'), roomB.code);
    assert.equal(registry.socketToRoom.get('host-a'), roomB.code);
    assert.equal(registry.roomCodeForWhipResource('whip-a'), null);
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
