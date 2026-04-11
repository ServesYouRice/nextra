const test = require('node:test');
const assert = require('node:assert/strict');

const {
    hasCloudflareTurnCredentialSource,
    normalizeCloudflareTurnTtlSeconds,
    isBrowserBlockedTurnUrl,
    extractCloudflareTurnConfig,
} = require('../lib/cloudflareTurn');

test('Cloudflare TURN autofill requires both key id and API token', () => {
    assert.equal(hasCloudflareTurnCredentialSource({ keyId: '', apiToken: '' }), false);
    assert.equal(hasCloudflareTurnCredentialSource({ keyId: 'key', apiToken: '' }), false);
    assert.equal(hasCloudflareTurnCredentialSource({ keyId: 'key', apiToken: 'token' }), true);
});

test('Cloudflare TURN ttl is clamped to safe bounds', () => {
    assert.equal(normalizeCloudflareTurnTtlSeconds('10'), 60);
    assert.equal(normalizeCloudflareTurnTtlSeconds('21600'), 21600);
    assert.equal(normalizeCloudflareTurnTtlSeconds('999999'), 86400);
});

test('Cloudflare TURN parser strips browser-blocked port 53 URLs', () => {
    assert.equal(isBrowserBlockedTurnUrl('turn:turn.cloudflare.com:53?transport=udp'), true);
    assert.equal(isBrowserBlockedTurnUrl('turns:turn.cloudflare.com:443?transport=tcp'), false);
});

test('Cloudflare TURN parser extracts static credentials and browser-safe TURN URLs', () => {
    const result = extractCloudflareTurnConfig({
        iceServers: [
            {
                urls: [
                    'stun:stun.cloudflare.com:3478',
                    'stun:stun.cloudflare.com:53',
                ],
            },
            {
                urls: [
                    'turn:turn.cloudflare.com:3478?transport=udp',
                    'turn:turn.cloudflare.com:53?transport=udp',
                    'turn:turn.cloudflare.com:80?transport=tcp',
                    'turns:turn.cloudflare.com:5349?transport=tcp',
                    'turns:turn.cloudflare.com:443?transport=tcp',
                ],
                username: 'cf-turn-user',
                credential: 'cf-turn-pass',
            },
        ],
    });

    assert.deepEqual(result, {
        urls: [
            'turn:turn.cloudflare.com:3478?transport=udp',
            'turn:turn.cloudflare.com:80?transport=tcp',
            'turns:turn.cloudflare.com:5349?transport=tcp',
            'turns:turn.cloudflare.com:443?transport=tcp',
        ],
        authType: 'static',
        username: 'cf-turn-user',
        credential: 'cf-turn-pass',
    });
});
