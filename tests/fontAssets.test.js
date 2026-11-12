const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('both font licence texts ship in licenses/', () => {
    for (const name of ['Inter-OFL-1.1.txt', 'JetBrainsMono-OFL-1.1.txt']) {
        assert.match(read('licenses', name), /SIL OPEN FONT LICENSE/i, name);
    }
});

test('THIRD_PARTY_NOTICES.md names both typefaces and their licence', () => {
    const notices = read('THIRD_PARTY_NOTICES.md');
    assert.match(notices, /Inter/);
    assert.match(notices, /JetBrains Mono/);
    assert.match(notices, /Open Font License/);
});

test('the font packages are build-time devDependencies only', () => {
    const pkg = JSON.parse(read('package.json'));
    for (const name of ['@fontsource-variable/inter', '@fontsource-variable/jetbrains-mono']) {
        assert.ok(pkg.devDependencies && pkg.devDependencies[name], `${name} in devDependencies`);
        assert.ok(!(pkg.dependencies && pkg.dependencies[name]), `${name} not in dependencies`);
    }
});

test('the font tokens name the bundled families first', () => {
    const css = read('src', 'index.css');
    assert.match(css, /--font-sans:\s*'Inter Variable'/);
    assert.match(css, /--font-mono:\s*'JetBrains Mono Variable'/);
});
