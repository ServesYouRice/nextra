'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('version-tagged Windows builds smoke-test and publish truthful unsigned artifacts', () => {
    const workflow = read('.github/workflows/release.yml');

    assert.match(workflow, /tags: \['v\*\.\*\.\*', '\*\.\*\.\*'\]/);
    assert.match(workflow, /runs-on: windows-2022/);
    assert.match(workflow, /node-version: '22'/);
    assert.match(workflow, /run: npm run package\r?$/m);
    assert.match(workflow, /npx playwright install chromium/);
    assert.match(workflow, /\.\\scripts\\smoke-packaged\.ps1/);
    assert.match(workflow, /Nextra\.exe\r?$/m);
    assert.match(workflow, /Nextra\.exe\.sha256\r?$/m);
    assert.match(workflow, /contents: write/);
    assert.match(workflow, /gh release create/);
    assert.match(workflow, /gh release upload/);
    assert.match(workflow, /This is an unsigned Windows build/);
    assert.match(workflow, /other browsers are not tested/);
    assert.match(workflow, /Corresponding GPL-3\.0 source/);
    assert.doesNotMatch(workflow, /SIGNING_PFX|signtool|Authenticode/);
});

test('pull-request Windows CI exercises the same packaged smoke path', () => {
    const workflow = read('.github/workflows/ci.yml');

    assert.match(workflow, /windows-package:/);
    assert.match(workflow, /windows-package:\r?\n\s+runs-on: windows-2022/);
    assert.match(workflow, /run: npm run package:artifact\r?$/m);
    assert.match(workflow, /npx playwright install chromium/);
    assert.match(workflow, /run: \.\\scripts\\smoke-packaged\.ps1/);
});

test('workflows and package metadata use the dependency-supported Node 22 baseline', () => {
    const ciWorkflow = read('.github/workflows/ci.yml');
    const releaseWorkflow = read('.github/workflows/release.yml');
    const pkg = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));

    assert.doesNotMatch(ciWorkflow, /node-version: '20'/);
    assert.doesNotMatch(releaseWorkflow, /node-version: '20'/);
    assert.equal(pkg.engines.node, '>=22.0.0');
    assert.equal(lock.packages[''].engines.node, '>=22.0.0');
});

test('the packager generates a checksum for the artifact under smoke test', () => {
    const packager = read('scripts/package-app.js');

    assert.match(packager, /writeReleaseChecksum\(\);/);
    assert.match(packager, /Nextra\.exe\.sha256/);
});

test('cloudflared verification failures report checksum and signer diagnostics', () => {
    const packager = read('scripts/package-app.js');

    assert.match(packager, /SHA-256 mismatch \(expected \$\{expectedSha256\}, got \$\{actualSha256\}\)/);
    assert.match(packager, /statusMessage = \[string\]\$result\.StatusMessage/);
    assert.match(packager, /signerSubject = \[string\]\$result\.SignerCertificate\.Subject/);
    assert.match(packager, /ErrorActionPreference/);
    assert.match(packager, /Import-Module \(Join-Path \$PSHOME 'Modules\/Microsoft\.PowerShell\.Security\/Microsoft\.PowerShell\.Security\.psd1'\)/);
    assert.match(packager, /-ErrorAction Stop/);
    assert.match(packager, /stderr \|\| stdout/);
    assert.match(packager, /details\.status !== 'Valid'/);
    assert.match(packager, /Downloaded cloudflared failed pinned verification: \$\{verification\.reason\}/);
});

test('release compliance files are trackable and required package inputs', () => {
    const ignore = read('.gitignore');
    const packager = read('scripts/package-app.js');

    assert.match(ignore, /^!SOURCE\.md$/m);
    assert.match(ignore, /^!THIRD_PARTY_NOTICES\.md$/m);
    assert.match(ignore, /^!implementation\/archive\/\*\*\/\*\.md$/m);
    assert.match(packager, /'SOURCE\.md'/);
    assert.match(packager, /'THIRD_PARTY_NOTICES\.md'/);
});
