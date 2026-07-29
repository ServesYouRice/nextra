const test = require('node:test');
const assert = require('node:assert/strict');

test('restricted Status copy describes the UI that exists', async () => {
    const { STATUS_ACCESS_RESTRICTED_COPY } = await import('../src/lib/statusCopy.mjs');
    assert.match(STATUS_ACCESS_RESTRICTED_COPY, /open it on the host machine/i);
    assert.match(STATUS_ACCESS_RESTRICTED_COPY, /remote API clients must authenticate separately/i);
    assert.doesNotMatch(STATUS_ACCESS_RESTRICTED_COPY, /with a metrics token/i);
});
