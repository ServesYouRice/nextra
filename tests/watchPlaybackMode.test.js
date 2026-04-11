const test = require('node:test');
const assert = require('node:assert/strict');

const watchPlaybackModeModule = import('../src/lib/watchPlaybackMode.mjs');

test('relay-first playback is disabled for AV1 WebRTC-only rooms', async () => {
    const { shouldPreferRelayPlayback } = await watchPlaybackModeModule;

    assert.equal(shouldPreferRelayPlayback({
        isTunnelOrigin: true,
        hasTurnServer: false,
        relayAllowed: false,
    }), false);
});

test('relay-first playback stays enabled for tunnel viewers when TURN is unavailable and relay is allowed', async () => {
    const { shouldPreferRelayPlayback } = await watchPlaybackModeModule;

    assert.equal(shouldPreferRelayPlayback({
        isTunnelOrigin: true,
        hasTurnServer: false,
        relayAllowed: true,
    }), true);
});

test('AV1 unsupported warning only appears for AV1 rooms without AV1 playback support', async () => {
    const { isAv1PlaybackUnsupported } = await watchPlaybackModeModule;

    assert.equal(isAv1PlaybackUnsupported({
        obsVideoCodec: 'av1',
        mediaSourceSupported: false,
    }), true);
    assert.equal(isAv1PlaybackUnsupported({
        obsVideoCodec: 'h264',
        mediaSourceSupported: false,
    }), false);
    assert.equal(isAv1PlaybackUnsupported({
        obsVideoCodec: 'av1',
        mediaSourceSupported: true,
    }), false);
});
