const test = require('node:test');
const assert = require('node:assert/strict');

const relayRecorderFormatModule = import('../src/lib/relayRecorderFormat.mjs');

// iPhone relay viewers can only play H.264 MP4, so hosts that can record it
// prefer it (AAC audio, High profile, 1s keyframes so fragments stay short);
// every other host keeps exactly the historical VP8 chain.
test('relay recorder prefers H.264/AAC MP4 with 1s keyframes when the browser can record it', async () => {
    const { selectRelayRecorderFormat } = await relayRecorderFormatModule;

    assert.deepEqual(selectRelayRecorderFormat(() => true), {
        mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2',
        options: { videoKeyFrameIntervalDuration: 1000 },
    });
});

test('relay recorder falls back to the VP8 chain without MP4 support or after an MP4 failure', async () => {
    const { selectRelayRecorderFormat } = await relayRecorderFormatModule;
    const only = (...types) => (type) => types.includes(type);

    assert.deepEqual(selectRelayRecorderFormat(only('video/webm;codecs=vp8,opus')), {
        mimeType: 'video/webm;codecs=vp8,opus',
        options: {},
    });
    assert.equal(selectRelayRecorderFormat(only('video/webm;codecs=vp8')).mimeType, 'video/webm;codecs=vp8');
    assert.equal(selectRelayRecorderFormat(() => false).mimeType, 'video/webm');
    assert.equal(
        selectRelayRecorderFormat(() => true, { allowMp4: false }).mimeType,
        'video/webm;codecs=vp8,opus',
    );
});

// OBS dynamic bitrate and WebRTC GCC both drop fast and recover slowly; the
// relay does the same, bounded by a floor and by the profile's own target.
test('relay congestion steps the recorder bitrate down to 70% with a 2.5 Mbps floor', async () => {
    const { lowerRelayBitrate } = await relayRecorderFormatModule;

    assert.equal(lowerRelayBitrate(20_000_000), 14_000_000);
    assert.equal(lowerRelayBitrate(3_000_000), 2_500_000);
    assert.equal(lowerRelayBitrate(2_500_000), 2_500_000);
});

// From the 2.5 Mbps floor, 25% steps every 30 s regain a 12 Mbps target in
// about 3.5 minutes; each step restarts the recorder, so it stays gradual.
test('a stable relay steps back up 25% every 30 s and releases the limit at the profile target', async () => {
    const { raiseRelayBitrate, RELAY_BITRATE_STEP_UP_AFTER_MS } = await relayRecorderFormatModule;

    assert.equal(RELAY_BITRATE_STEP_UP_AFTER_MS, 30_000);
    assert.equal(raiseRelayBitrate(10_000_000, 20_000_000), 12_500_000);
    assert.equal(raiseRelayBitrate(17_000_000, 20_000_000), null);
    assert.equal(raiseRelayBitrate(20_000_000, 20_000_000), null);
});
