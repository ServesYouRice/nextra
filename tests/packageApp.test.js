'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { getCloudflaredAssetName } = require('../scripts/package-app');
const cloudflaredManifest = require('../scripts/cloudflared-manifest.json');

// The platform/arch pairs packaging supports. Each one must resolve to an asset
// the manifest pins, because on macOS the pinned digest is the only check a
// downloaded cloudflared gets -- Authenticode is Windows-only.
const supportedTargets = [
    { platform: 'darwin', arch: 'arm64', asset: 'cloudflared-darwin-arm64.tgz' },
    { platform: 'darwin', arch: 'x64', asset: 'cloudflared-darwin-amd64.tgz' },
    { platform: 'win32', arch: 'x64', asset: 'cloudflared-windows-amd64.exe' },
    { platform: 'win32', arch: 'ia32', asset: 'cloudflared-windows-386.exe' },
];

test('each supported packaging target resolves to its cloudflared asset', () => {
    for (const { platform, arch, asset } of supportedTargets) {
        assert.equal(getCloudflaredAssetName(platform, arch), asset, `${platform}/${arch}`);
    }
});

// Fails loudly when the pinned cloudflared version is bumped and a platform is
// forgotten: without an entry, bundleCloudflared() has nothing to verify against.
test('every resolvable cloudflared asset is pinned in the manifest', () => {
    for (const { platform, arch } of supportedTargets) {
        const asset = getCloudflaredAssetName(platform, arch);
        assert.match(
            cloudflaredManifest.assets[asset] || '',
            /^[0-9a-f]{64}$/,
            `Missing or malformed pinned SHA-256 for ${asset} (${platform}/${arch})`
        );
    }
});

test('an unsupported architecture has no pinned asset and throws', () => {
    assert.throws(() => getCloudflaredAssetName('darwin', 'ppc64'), /Unsupported macOS architecture/);
    assert.throws(() => getCloudflaredAssetName('win32', 'ppc64'), /Unsupported Windows architecture/);
    assert.throws(() => getCloudflaredAssetName('linux', 'x64'), /Windows and macOS packaging only/);
});
