const test = require('node:test');
const assert = require('node:assert/strict');

function memoryStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => { map.set(key, String(value)); },
        removeItem: (key) => { map.delete(key); },
    };
}

test('a remembered intent is taken once', async () => {
    const { rememberJoinIntent, takeJoinIntent } = await import('../src/lib/joinIntent.mjs');
    const storage = memoryStorage();
    rememberJoinIntent('ABC123', storage, 1000);
    assert.equal(takeJoinIntent('ABC123', storage, 2000), true);
    assert.equal(takeJoinIntent('ABC123', storage, 2000), false);
});

test('an intent for another code is not taken', async () => {
    const { rememberJoinIntent, takeJoinIntent } = await import('../src/lib/joinIntent.mjs');
    const storage = memoryStorage();
    rememberJoinIntent('ABC123', storage, 1000);
    assert.equal(takeJoinIntent('XYZ789', storage, 2000), false);
});

test('an intent older than 10 seconds is not taken', async () => {
    const { rememberJoinIntent, takeJoinIntent } = await import('../src/lib/joinIntent.mjs');
    const storage = memoryStorage();
    rememberJoinIntent('ABC123', storage, 1000);
    assert.equal(takeJoinIntent('ABC123', storage, 12000), false);
    assert.equal(storage.getItem('nextra.joinIntent.v1'), null);
});

test('an intent exactly 10 seconds old is still taken', async () => {
    const { rememberJoinIntent, takeJoinIntent } = await import('../src/lib/joinIntent.mjs');
    const storage = memoryStorage();
    rememberJoinIntent('ABC123', storage, 1000);
    assert.equal(takeJoinIntent('ABC123', storage, 11000), true);
});

test('a storage that throws gives false and does not throw', async () => {
    const { rememberJoinIntent, takeJoinIntent } = await import('../src/lib/joinIntent.mjs');
    const boom = () => { throw new Error('denied'); };
    const storage = { getItem: boom, setItem: boom, removeItem: boom };
    assert.doesNotThrow(() => rememberJoinIntent('ABC123', storage, 1000));
    assert.equal(takeJoinIntent('ABC123', storage, 2000), false);
});

test('null storage is fine', async () => {
    const { rememberJoinIntent, takeJoinIntent, getSessionStorageSafely } = await import('../src/lib/joinIntent.mjs');
    assert.doesNotThrow(() => rememberJoinIntent('ABC123', null, 1000));
    assert.equal(takeJoinIntent('ABC123', null, 2000), false);
    const blocked = { get sessionStorage() { throw new Error('SecurityError'); } };
    assert.equal(getSessionStorageSafely(blocked), null);
    const storage = memoryStorage();
    assert.equal(getSessionStorageSafely({ sessionStorage: storage }), storage);
    assert.equal(getSessionStorageSafely({}), null);
});
