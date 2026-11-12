'use strict';

// The host page must not describe screens or controls that are not there:
// quality is chosen below the preview, not in Settings, and the page shows
// a link, not a room code, while the public link is unavailable.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'HostView.jsx'), 'utf8');

test('host page does not tell the host to pick quality in Settings', () => {
    assert.doesNotMatch(source, /quality in Settings/i);
});

test('host page does not offer a room code next to the local link', () => {
    assert.doesNotMatch(source, /local link or room code/i);
});
