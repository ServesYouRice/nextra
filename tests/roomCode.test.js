const test = require('node:test');
const assert = require('node:assert/strict');

test('extractRoomCode upper-cases, unwraps pasted links, drops other characters and cuts to six', async () => {
    const { extractRoomCode } = await import('../src/lib/roomCode.mjs');
    assert.equal(extractRoomCode('abc123'), 'ABC123');
    assert.equal(extractRoomCode('https://example.test/#watch/abc123'), 'ABC123');
    assert.equal(extractRoomCode('a-b c!1@2#3'), 'ABC123');
    assert.equal(extractRoomCode('ABCDEFGH'), 'ABCDEF');
    assert.equal(extractRoomCode(null), '');
});

test('normalizeRoomCode trims, upper-cases and removes hyphens', async () => {
    const { normalizeRoomCode } = await import('../src/lib/roomCode.mjs');
    assert.equal(normalizeRoomCode(' abc-123 '), 'ABC123');
    assert.equal(normalizeRoomCode(undefined), '');
});

test('formatRoomCode inserts a hyphen after the third character', async () => {
    const { formatRoomCode } = await import('../src/lib/roomCode.mjs');
    assert.equal(formatRoomCode('ABC123'), 'ABC-123');
    assert.equal(formatRoomCode('ABC'), 'ABC');
});
