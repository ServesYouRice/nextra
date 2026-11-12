'use strict';

// The HowTo "Security and privacy" copy must describe each media path as the
// code carries it: WebRTC paths (browser viewing, OBS WHIP ingest, WHEP) run over
// mediasoup WebRtcTransport, so they are DTLS-SRTP; the relay is Socket.IO bytes
// on the page connection, so it is only as private as that connection; the
// public link's TLS ends at the tunnel provider (cloudflared forwards to
// 127.0.0.1); the local link is plain HTTP unless LOCAL_HTTPS is on.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'HowToView.jsx'), 'utf8');

function toText(jsx) {
    return jsx
        .replace(/<[^>]+>/g, ' ')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

function securitySection() {
    const start = source.indexOf('<h2>Security and privacy</h2>');
    const end = source.indexOf('<div className="article-cta">');
    assert.ok(start !== -1 && end > start, 'the Security and privacy section is present');
    return toText(source.slice(start, end));
}

// One sentence-sized chunk of the section, split at full stops and list items.
function sentencesOf(text) {
    return text.split(/(?<=[.!?])\s+/);
}

test('the blanket "media is encrypted ... WebRTC DTLS" sentence is gone', () => {
    const page = toText(source);
    assert.ok(
        !/media is encrypted in transit with WebRTC DTLS/i.test(page),
        'HowToView still says media is encrypted in transit with WebRTC DTLS',
    );
    assert.ok(!/all media is/i.test(securitySection()), 'the section must not make an all-media claim');
});

test('WebRTC viewing, OBS WHIP ingest and WHEP are described as DTLS-SRTP', () => {
    const sentence = sentencesOf(securitySection()).find((s) => /DTLS-SRTP/.test(s));
    assert.ok(sentence, 'a sentence names DTLS-SRTP');
    assert.match(sentence, /WebRTC/);
    assert.match(sentence, /WHIP/);
    assert.match(sentence, /WHEP/);
});

test('relay media is described as travelling over the page connection, encrypted only as far as that is', () => {
    const sentence = sentencesOf(securitySection()).find((s) => /relay/i.test(s) && /page connection/i.test(s));
    assert.ok(sentence, 'a sentence ties the relay to the page connection');
    assert.match(sentence, /only as far as|only as much as|only to the extent/i);
    assert.doesNotMatch(sentence, /DTLS-SRTP/, 'the relay sentence must not claim DTLS for the relay');
});

test('public links are HTTPS that ends at the tunnel provider', () => {
    const sentence = sentencesOf(securitySection()).find((s) => /public link/i.test(s));
    assert.ok(sentence, 'a sentence is about public links');
    assert.match(sentence, /HTTPS/);
    assert.match(sentence, /tunnel provider/i);
    assert.match(sentence, /end/i);
});

test('a plain-HTTP local link is unencrypted unless local HTTPS is enabled', () => {
    const sentence = sentencesOf(securitySection()).find((s) => /local link/i.test(s));
    assert.ok(sentence, 'a sentence is about the local link');
    assert.match(sentence, /plain HTTP/i);
    assert.match(sentence, /unencrypted|not encrypted/i);
    assert.match(sentence, /LOCAL_HTTPS=true/);
});

// The host sign-in as lib/operatorSessions.js and lib/operatorSignIn.js carry it: the password crosses HTTPS only,
// the browser then holds an HttpOnly cookie, and a session lasts OPERATOR_SESSION_TTL_MS.
test('hosting from another computer is described as a host password sent over HTTPS and a cookie scripts cannot read', () => {
    const { OPERATOR_SESSION_TTL_MS } = require('../lib/operatorSessions');
    const hours = OPERATOR_SESSION_TTL_MS / (60 * 60 * 1000);
    const sentences = sentencesOf(securitySection());
    const password = sentences.find((s) => /host password/i.test(s));
    assert.ok(password, 'a sentence is about the host password');
    assert.match(password, /another computer/i);
    assert.match(password, /over HTTPS only/i);
    assert.match(password, /cookie that page scripts cannot read/i);
    const lifetime = sentences.find((s) => /sign-in ends/i.test(s));
    assert.ok(lifetime, 'a sentence says when the sign-in ends');
    assert.match(lifetime, new RegExp(`after ${hours} hours`));
    assert.match(lifetime, /sign out/i);
    assert.match(lifetime, /restarts/i);
    // The host steps say the same and name the setting.
    const page = toText(source);
    assert.match(page, /sets a host password \(\s*OPERATOR_TOKEN\s*, at least 32 characters\) and serves Nextra over HTTPS/);
    assert.match(page, new RegExp(`signed in for ${hours} hours`));
});

test('the rest of the section is unchanged', () => {
    const section = securitySection();
    assert.match(section, /Media is not stored by Nextra\./);
    assert.match(section, /OBS WebSocket traffic stays on localhost\./);
    assert.match(section, /Room access is code-based with no user accounts\./);
    assert.match(section, /If you enable Cloudflare TURN autofill, the long-lived API token stays on the server and the browser only receives short-lived TURN credentials\./);
});
