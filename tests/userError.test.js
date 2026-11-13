const test = require('node:test');
const assert = require('node:assert/strict');

test('known failures get a useful action while retaining technical detail', async () => {
    const { describeUserError } = await import('../src/lib/userError.mjs');
    const cases = [
        ['Failed to start sharing: NotAllowedError', /allow sharing/i],
        ['WebRTC connection timed out (ICE could not connect).', /check your network/i],
        ['Recovered WebRTC transport failed.', /firewall or TURN/i],
    ];
    for (const [technical, action] of cases) {
        const result = describeUserError(technical);
        assert.match(result.action, action);
        assert.equal(result.detail, technical);
    }

    const aborted = new Error('The request was interrupted by the browser.');
    aborted.name = 'AbortError';
    assert.match(describeUserError(aborted).action, /cancelled/i);
    assert.equal(describeUserError('Room not found.').detail, '');
});

test('a start failure that is not a cancelled picker shows its own reason', async () => {
    const { describeUserError } = await import('../src/lib/userError.mjs');
    const inputs = [
        'Failed to start sharing: OBS WHIP is still starting. Wait for it to become ready, then retry.',
        'Failed to start sharing: Screen capture is unavailable in this browser. Use desktop Chrome or Edge.',
    ];
    for (const input of inputs) {
        const result = describeUserError(input);
        assert.equal(result.action, input);
        assert.equal(result.detail, '');
        assert.doesNotMatch(result.action, /choose a screen/i);
    }
    assert.match(describeUserError('Screen sharing was cancelled.').action, /allow sharing/i);
    assert.match(describeUserError('Failed to start sharing: NotAllowedError').action, /allow sharing/i);
});
