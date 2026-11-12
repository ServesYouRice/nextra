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

// Media always goes through the Nextra server (mediasoup, or the relay), so the card must not call it peer-to-peer.
test('the social card tagline does not call Nextra peer-to-peer', () => {
    const social = fs.readFileSync(socialScript, 'utf8');
    const tagline = /const TAGLINE = '([^']+)';/.exec(social);
    assert.ok(tagline, 'the script declares its tagline');
    assert.doesNotMatch(tagline[1], /peer[- ]to[- ]peer|p2p/i);
    assert.match(tagline[1], /self-hosted screen sharing/i);
});
