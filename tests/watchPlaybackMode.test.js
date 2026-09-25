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

// iPhone browsers expose ManagedMediaSource but no window.MediaSource, so the
// relay check must answer "unsupported" instead of throwing a ReferenceError.
test('relay format support is false when MediaSource is missing or rejects the format', async () => {
    const { canPlayRelayFormat } = await watchPlaybackModeModule;
    const mime = 'video/webm;codecs=vp8,opus';

    assert.equal(canPlayRelayFormat(mime, {}), false);
    assert.equal(canPlayRelayFormat(mime, { MediaSource: { isTypeSupported: () => false } }), false);
    assert.equal(canPlayRelayFormat(mime, { MediaSource: { isTypeSupported: (type) => type === mime } }), true);
});

test('the unsupported-relay error is recognised from an Error or a message', async () => {
    const { RELAY_PLAYBACK_UNSUPPORTED_MESSAGE, isRelayPlaybackUnsupported } = await watchPlaybackModeModule;

    assert.match(RELAY_PLAYBACK_UNSUPPORTED_MESSAGE, /iPhone/);
    assert.equal(isRelayPlaybackUnsupported(new Error(RELAY_PLAYBACK_UNSUPPORTED_MESSAGE)), true);
    assert.equal(isRelayPlaybackUnsupported(RELAY_PLAYBACK_UNSUPPORTED_MESSAGE), true);
    assert.equal(isRelayPlaybackUnsupported(new Error('Connection timed out.')), false);
    assert.equal(isRelayPlaybackUnsupported(null), false);
});

test('relay playback resolves MediaSource first and ManagedMediaSource on iPhone', async () => {
    const { canPlayRelayFormat, getMediaSourceClass } = await watchPlaybackModeModule;
    const mime = 'video/mp4;codecs=avc1.640028,mp4a.40.2';
    class Standard { static isTypeSupported() { return true; } }
    class Managed { static isTypeSupported(type) { return type === mime; } }

    assert.equal(getMediaSourceClass({ MediaSource: Standard, ManagedMediaSource: Managed }), Standard);
    assert.equal(getMediaSourceClass({ ManagedMediaSource: Managed }), Managed);
    assert.equal(getMediaSourceClass({}), null);
    assert.equal(canPlayRelayFormat(mime, { ManagedMediaSource: Managed }), true);
    assert.equal(canPlayRelayFormat('video/webm;codecs=vp8,opus', { ManagedMediaSource: Managed }), false);
});
