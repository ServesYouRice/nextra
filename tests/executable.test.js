const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveExecutablePath } = require('../lib/executable');

test('resolveExecutablePath resolves an explicit executable path', () => {
    assert.equal(resolveExecutablePath(process.execPath), fs.realpathSync(process.execPath));
});

test('resolveExecutablePath resolves a bare command from PATH', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-executable-'));
    const filename = process.platform === 'win32' ? 'trusted-tool.exe' : 'trusted-tool';
    const executable = path.join(directory, filename);
    try {
        fs.copyFileSync(process.execPath, executable);
        if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
        assert.equal(resolveExecutablePath('trusted-tool', {
            env: { PATH: directory, PATHEXT: '.EXE' },
        }), fs.realpathSync(executable));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('resolveExecutablePath returns null for an unavailable command', () => {
    assert.equal(resolveExecutablePath('definitely-not-a-real-nextra-command', {
        env: { PATH: '' },
    }), null);
});
