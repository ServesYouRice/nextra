'use strict';

// The invite card must not tell a host to share a link nobody else can open:
// by default Nextra listens on this computer only, so the local link is a
// localhost link.

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/lib/inviteLinks.mjs');

test('isLoopbackLink knows the names of this computer and nothing else', async () => {
    const { isLoopbackLink } = await load();
    for (const link of [
        'http://localhost:3000/#watch/ABC123',
        'https://LOCALHOST:3443',
        'http://127.0.0.1:3000/#watch/ABC123',
        'http://127.8.9.10:3000',
        'http://[::1]:3000/#watch/ABC123',
        'http://nextra.localhost:3000',
    ]) {
        assert.equal(isLoopbackLink(link), true, link);
    }
    for (const link of [
        'http://192.168.0.29:3000/#watch/ABC123',
        'https://listed-loops.trycloudflare.com/#watch/ABC123',
        'http://localhost.example.com:3000',
        'http://1270.0.0.1:3000',
        'http://[fe80::1]:3000',
        'not a link',
        '',
        null,
        undefined,
    ]) {
        assert.equal(isLoopbackLink(link), false, String(link));
    }
});

test('the public link is the one to share whenever there is one', async () => {
    const { inviteLinkRows } = await load();
    const rows = inviteLinkRows({
        localWatchLink: 'http://localhost:3000/#watch/ABC123',
        publicWatchLink: 'https://share.example/#watch/ABC123',
        showPublicLink: true,
        whepPlaybackUrl: 'https://share.example/whep/watch/ABC123',
    });
    assert.deepEqual(rows.map((row) => row.key), ['public', 'local', 'player']);
    assert.deepEqual(rows.map((row) => row.recommended), [true, false, false]);
    assert.equal(rows[0].label, 'Public link');
    assert.equal(rows[2].label, 'Player link · WHEP');
    assert.equal(rows[0].shortenFrom, '/#watch/');
    assert.equal(rows[2].shortenFrom, '/whep/watch/');
});

test('a local link other devices can open is called same network and is the one to share', async () => {
    const { inviteLinkRows } = await load();
    const rows = inviteLinkRows({
        localWatchLink: 'http://192.168.0.29:3000/#watch/ABC123',
        publicWatchLink: '',
        showPublicLink: false,
        whepPlaybackUrl: '',
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, 'Local link · same network');
    assert.equal(rows[0].recommended, true);
    assert.equal(rows[0].copyButtonLabel, 'Copy local link');
});

test('a localhost link is called this computer only and is never the one to share', async () => {
    const { inviteLinkRows } = await load();
    const alone = inviteLinkRows({
        localWatchLink: 'http://localhost:3000/#watch/ABC123',
        publicWatchLink: '',
        showPublicLink: false,
        whepPlaybackUrl: '',
    });
    assert.equal(alone.length, 1);
    assert.equal(alone[0].label, 'Local link · this computer only');
    assert.equal(alone[0].recommended, false);

    const withPublic = inviteLinkRows({
        localWatchLink: 'http://127.0.0.1:3000/#watch/ABC123',
        publicWatchLink: 'https://share.example/#watch/ABC123',
        showPublicLink: true,
        whepPlaybackUrl: '',
    });
    assert.equal(withPublic[1].label, 'Local link · this computer only');
    assert.deepEqual(withPublic.map((row) => row.recommended), [true, false]);
});

test('no rows without a room', async () => {
    const { inviteLinkRows } = await load();
    assert.deepEqual(inviteLinkRows({ localWatchLink: '', publicWatchLink: '', showPublicLink: false, whepPlaybackUrl: '' }), []);
});

test('the note says who the local link reaches while there is no public link', async () => {
    const { publicLinkNote } = await load();
    const lan = 'http://192.168.0.29:3000/#watch/ABC123';
    const here = 'http://localhost:3000/#watch/ABC123';

    assert.equal(publicLinkNote({ showPublicLink: true, publicShareStatus: 'active', localWatchLink: here }), '');
    assert.equal(
        publicLinkNote({ showPublicLink: false, publicShareStatus: 'disabled', localWatchLink: lan }),
        'Works for people on your network. There is no public link on this machine.',
    );
    const alone = publicLinkNote({ showPublicLink: false, publicShareStatus: 'disabled', localWatchLink: here });
    assert.match(alone, /^Nobody else can join yet/);
    assert.match(alone, /only opens on this computer/);
    assert.match(alone, /"No public link\?" in How to Use/);
    assert.doesNotMatch(alone, /people on your network/);

    for (const localWatchLink of [lan, here]) {
        assert.equal(
            publicLinkNote({ showPublicLink: false, publicShareStatus: 'starting', localWatchLink }),
            'Public link is starting automatically. Wait a few seconds and it will appear here.',
        );
    }
    assert.equal(
        publicLinkNote({ showPublicLink: false, publicShareStatus: 'error', publicShareError: 'No cloudflared binary found.', localWatchLink: lan }),
        'Public link unavailable on this machine. No cloudflared binary found.',
    );
    assert.equal(
        publicLinkNote({ showPublicLink: false, publicShareStatus: 'error', publicShareError: '', localWatchLink: here }),
        'Public link unavailable on this machine. Built-in tunnel startup failed. The local link only opens on this computer.',
    );
});
