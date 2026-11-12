const test = require('node:test');
const assert = require('node:assert/strict');
const { REPOSITORY, parseArgs, proxyBuildArgs, proxyRunArgs, registryDigest } = require('../scripts/release-image');

test('the image release is a dry run unless --push is given, and refuses unknown options', () => {
    assert.deepEqual(parseArgs([]), { push: false });
    assert.deepEqual(parseArgs(['--push']), { push: true });
    assert.throws(() => parseArgs(['--publish']), /Unknown option: --publish/);
    assert.throws(() => parseArgs(['--push', 'now']), /Unknown option: now/);
});

test('no proxy adds nothing to the build or to helper containers', () => {
    assert.deepEqual(proxyBuildArgs({}, () => true), []);
    assert.deepEqual(proxyRunArgs({}, () => true), []);
});

test('a loopback inspecting proxy builds on the host network with its CA as a secret, never as a layer', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:40199', NODE_EXTRA_CA_CERTS: '/etc/proxy-ca.crt' };
    assert.deepEqual(proxyBuildArgs(env, () => true), [
        '--build-arg', 'HTTPS_PROXY=http://127.0.0.1:40199', '--build-arg', 'https_proxy=http://127.0.0.1:40199',
        '--network', 'host', '--secret', 'id=build_ca,src=/etc/proxy-ca.crt',
    ]);
    assert.deepEqual(proxyRunArgs(env, () => true), [
        '-e', 'HTTPS_PROXY=http://127.0.0.1:40199', '--network', 'host',
        '-v', '/etc/proxy-ca.crt:/etc/ssl/certs/proxy-ca.crt:ro', '-e', 'SSL_CERT_FILE=/etc/ssl/certs/proxy-ca.crt',
    ]);
});

test('a remote proxy keeps normal networking, and a CA file that is not there is left out', () => {
    const env = { https_proxy: 'http://proxy.example:3128', NODE_EXTRA_CA_CERTS: '/missing.crt' };
    assert.deepEqual(proxyBuildArgs(env, () => false), [
        '--build-arg', 'HTTPS_PROXY=http://proxy.example:3128', '--build-arg', 'https_proxy=http://proxy.example:3128',
    ]);
    assert.deepEqual(proxyRunArgs(env, () => false), ['-e', 'HTTPS_PROXY=http://proxy.example:3128']);
});

test('the release record takes the digest of this repository only', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    assert.equal(registryDigest([`other/image@sha256:${'b'.repeat(64)}`, `${REPOSITORY}@${digest}`]), digest);
    assert.equal(registryDigest([`${REPOSITORY}-fork@${digest}`]), '');
    assert.equal(registryDigest([]), '');
    assert.equal(registryDigest(null), '');
});
