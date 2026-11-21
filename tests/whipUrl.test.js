'use strict';

// The Host page's WHIP address. A host on another computer cannot reach the loopback WHIP listener, so with
// PUBLIC_WHIP_ENABLED the page hands OBS the HTTPS address it was itself opened on.

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/lib/whipUrl.mjs');
const local = { whipHttpHost: '127.0.0.1', whipHttpPort: 3001 };

test('with PUBLIC_WHIP_ENABLED a page on a public HTTPS origin gives OBS the public WHIP address', async () => {
    const { buildWhipBroadcastUrl } = await load();
    assert.equal(
        buildWhipBroadcastUrl('ABC123', { ...local, publicWhipEnabled: true, pageOrigin: 'https://watch.example.com' }),
        'https://watch.example.com/whip/broadcast/ABC123',
    );
    assert.equal(
        buildWhipBroadcastUrl('ABC123', { ...local, publicWhipEnabled: true, pageOrigin: 'https://watch.example.com:8443' }),
        'https://watch.example.com:8443/whip/broadcast/ABC123',
    );
});

test('without PUBLIC_WHIP_ENABLED the page keeps the loopback WHIP listener', async () => {
    const { buildWhipBroadcastUrl } = await load();
    assert.equal(
        buildWhipBroadcastUrl('ABC123', { ...local, publicWhipEnabled: false, pageOrigin: 'https://watch.example.com' }),
        'http://127.0.0.1:3001/whip/broadcast/ABC123',
    );
    assert.equal(
        buildWhipBroadcastUrl('ABC123', { whipHttpHost: '::1', whipHttpPort: 3002 }),
        'http://[::1]:3002/whip/broadcast/ABC123',
    );
});

test('a page on plain HTTP, on this computer or on a private address keeps the loopback WHIP listener', async () => {
    const { buildWhipBroadcastUrl, publicWhipOrigin } = await load();
    for (const pageOrigin of [
        'http://watch.example.com',
        'https://localhost:3000',
        'https://127.0.0.1:3000',
        'https://[::1]:3000',
        'https://192.168.1.20:3000',
        'https://10.0.0.5',
        'https://172.20.0.2',
        '',
        'not a url',
    ]) {
        assert.equal(publicWhipOrigin({ publicWhipEnabled: true, pageOrigin }), '', pageOrigin);
        assert.equal(
            buildWhipBroadcastUrl('ABC123', { ...local, publicWhipEnabled: true, pageOrigin }),
            'http://127.0.0.1:3001/whip/broadcast/ABC123',
            pageOrigin,
        );
    }
});
