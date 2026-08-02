const test = require('node:test');
const assert = require('node:assert/strict');

test('shared media-debug parsing covers query, storage, and denied storage access', async () => {
    const { isMediaDebugEnabled } = await import('../src/lib/mediaDebug.mjs');
    assert.equal(isMediaDebugEnabled({ search: '?debugMedia' }, { getItem: () => null }), true);
    assert.equal(isMediaDebugEnabled({ search: '' }, { getItem: () => '1' }), true);
    assert.equal(isMediaDebugEnabled({ search: '' }, { getItem: () => null }), false);
    assert.equal(isMediaDebugEnabled({ search: '' }, { getItem: () => { throw new Error('denied'); } }), false);
});
