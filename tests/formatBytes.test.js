const test = require('node:test');
const assert = require('node:assert/strict');

test('shared byte formatting preserves Status and Host call-site behavior', async () => {
    const { formatBytes } = await import('../src/lib/formatBytes.mjs');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB');
    assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.00 GB');
    assert.equal(formatBytes(2 * 1024 * 1024 * 1024, { maxUnit: 'MB' }), '2048.0 MB');
});
