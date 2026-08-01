const test = require('node:test');
const assert = require('node:assert/strict');

test('viewer room links retain only origin, app path, and normalized room code', async () => {
    const { buildViewerRoomUrl } = await import('../src/lib/roomLink.mjs');
    assert.equal(buildViewerRoomUrl({
        href: 'https://user:password@nextra.example/app/?passphrase=open-sesame#watch/OLD123',
    }, 'abc-123'), 'https://nextra.example/app/#watch/ABC123');
    assert.equal(buildViewerRoomUrl({ href: 'http://127.0.0.1:3000/#watch' }, 'ABC123'),
        'http://127.0.0.1:3000/#watch/ABC123');
    assert.equal(buildViewerRoomUrl({ href: 'http://127.0.0.1:3000/' }, 'short'), '');
});
