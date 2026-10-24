const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const iconsScript = path.join(__dirname, '..', 'scripts', 'generate-icons.ps1');
const socialScript = path.join(__dirname, '..', 'scripts', 'generate-social-card.js');

test('generate-icons.ps1 does not write the social card', () => {
    const source = fs.readFileSync(iconsScript, 'utf8');
    assert.equal(source.includes('nextra-social-card'), false);
});

test('both brand scripts document that generate-icons.ps1 runs before generate-social-card.js', () => {
    const icons = fs.readFileSync(iconsScript, 'utf8');
    const social = fs.readFileSync(socialScript, 'utf8');
    assert.match(icons, /generate-social-card\.js/);
    assert.match(social, /generate-icons\.ps1/);
});
