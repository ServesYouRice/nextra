const test = require('node:test');
const assert = require('node:assert/strict');

const { ROOM_STATE_CODES, createRoomState } = require('../lib/roomState');

test('room transition payloads expose stable recoverable and terminal state', () => {
    assert.deepEqual(
        createRoomState(ROOM_STATE_CODES.HOST_DISCONNECTED, 'retry', true),
        {
            code: 'host-disconnected',
            reason: 'retry',
            recoverable: true,
            terminal: false,
        }
    );
    assert.deepEqual(
        createRoomState(ROOM_STATE_CODES.SERVER_SHUTDOWN, 'ended'),
        {
            code: 'server-shutdown',
            reason: 'ended',
            recoverable: false,
            terminal: true,
        }
    );
});
