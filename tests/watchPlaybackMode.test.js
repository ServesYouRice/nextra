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

function fakeSourceBuffer({ changeType = true, failOn = null } = {}) {
    const calls = [];
    const sourceBuffer = {
        calls,
        abort() {
            calls.push('abort');
            if (failOn === 'abort') throw new DOMException('busy', 'InvalidStateError');
        },
    };
    if (changeType) {
        sourceBuffer.changeType = (type) => {
            calls.push(`changeType ${type}`);
            if (failOn === 'changeType') throw new DOMException('no', 'NotSupportedError');
        };
    }
    return sourceBuffer;
}

const MP4 = 'video/mp4;codecs=avc1.640028,mp4a.40.2';
const VP8 = 'video/webm;codecs=vp8,opus';

// A recorder timeslice ends inside a WebM element. When the old generation's
// queued chunks are dropped for a new one, the parser must be reset or it reads
// the new init segment as the rest of that element.
test('a new relay generation on a playing SourceBuffer resets its parser first', async () => {
    const { prepareSourceBufferForGeneration } = await watchPlaybackModeModule;
    const sourceBuffer = fakeSourceBuffer();

    assert.equal(prepareSourceBufferForGeneration(sourceBuffer, { readyState: 'open' }, { fromMimeType: VP8, toMimeType: VP8 }), true);
    assert.deepEqual(sourceBuffer.calls, ['abort']);
});

// The host's MP4 recorder falls back to VP8 mid-stream (relay-mp4-failed).
test('a new relay generation in another format switches the SourceBuffer type after the reset', async () => {
    const { prepareSourceBufferForGeneration } = await watchPlaybackModeModule;
    const sourceBuffer = fakeSourceBuffer();

    assert.equal(prepareSourceBufferForGeneration(sourceBuffer, { readyState: 'open' }, { fromMimeType: MP4, toMimeType: VP8 }), true);
    assert.deepEqual(sourceBuffer.calls, ['abort', `changeType ${VP8}`]);
});

test('a SourceBuffer that cannot take the new relay generation is reported, not reused', async () => {
    const { prepareSourceBufferForGeneration } = await watchPlaybackModeModule;
    const formats = { fromMimeType: MP4, toMimeType: VP8 };

    assert.equal(prepareSourceBufferForGeneration(fakeSourceBuffer({ changeType: false }), { readyState: 'open' }, formats), false);
    assert.equal(prepareSourceBufferForGeneration(fakeSourceBuffer({ failOn: 'changeType' }), { readyState: 'open' }, formats), false);
    assert.equal(prepareSourceBufferForGeneration(fakeSourceBuffer({ failOn: 'abort' }), { readyState: 'open' }, formats), false);
    const ended = fakeSourceBuffer();
    assert.equal(prepareSourceBufferForGeneration(ended, { readyState: 'ended' }, { fromMimeType: VP8, toMimeType: VP8 }), false);
    assert.deepEqual(ended.calls, []);
});
