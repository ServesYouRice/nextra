const test = require('node:test');
const assert = require('node:assert/strict');

test('shared media-debug parsing covers query, storage, and denied storage access', async () => {
    const { isMediaDebugEnabled } = await import('../src/lib/mediaDebug.mjs');
    assert.equal(isMediaDebugEnabled({ search: '?debugMedia' }, { getItem: () => null }), true);
    assert.equal(isMediaDebugEnabled({ search: '' }, { getItem: () => '1' }), true);
    assert.equal(isMediaDebugEnabled({ search: '' }, { getItem: () => null }), false);
    assert.equal(isMediaDebugEnabled({ search: '' }, { getItem: () => { throw new Error('denied'); } }), false);
});

test('module-scope storage read is guarded when window.localStorage throws SecurityError', async () => {
    const { getLocalStorageSafely, isMediaDebugEnabled } = await import('../src/lib/mediaDebug.mjs');
    const blocked = { location: { search: '' }, get localStorage() { throw new Error('SecurityError: storage denied'); } };
    assert.equal(getLocalStorageSafely(blocked), null);
    assert.equal(isMediaDebugEnabled(blocked.location, getLocalStorageSafely(blocked)), false);
    assert.equal(isMediaDebugEnabled({ search: '?debugMedia' }, getLocalStorageSafely(blocked)), true);
    const storage = { getItem: () => '1' };
    assert.equal(getLocalStorageSafely({ localStorage: storage }), storage);
    assert.equal(getLocalStorageSafely({}), null);
});
