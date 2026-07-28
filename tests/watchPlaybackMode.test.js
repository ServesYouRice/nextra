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

test('WebRTC AV1 support comes from loaded receive RTP capabilities, not MP4 support', async () => {
    const { hasWebRtcReceiveCodec, isAv1PlaybackUnsupported } = await watchPlaybackModeModule;

    assert.equal(hasWebRtcReceiveCodec({
        codecs: [{ mimeType: 'video/H264' }, { mimeType: 'video/AV1' }],
    }, 'video/AV1'), true);
    assert.equal(hasWebRtcReceiveCodec({
        codecs: [{ mimeType: 'video/H264' }],
    }, 'video/AV1'), false);

    // Before Device.load(), support is unknown and must not produce a warning.
    assert.equal(isAv1PlaybackUnsupported({
        obsVideoCodec: 'av1',
        receiveCapabilitiesLoaded: false,
        av1ReceiveSupported: false,
    }), false);

    assert.equal(isAv1PlaybackUnsupported({
        obsVideoCodec: 'av1',
        receiveCapabilitiesLoaded: true,
        av1ReceiveSupported: false,
    }), true);
    assert.equal(isAv1PlaybackUnsupported({
        obsVideoCodec: 'h264',
        receiveCapabilitiesLoaded: true,
        av1ReceiveSupported: false,
    }), false);
    assert.equal(isAv1PlaybackUnsupported({
        obsVideoCodec: 'av1',
        receiveCapabilitiesLoaded: true,
        av1ReceiveSupported: true,
    }), false);
});
