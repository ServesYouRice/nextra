const test = require('node:test');
const assert = require('node:assert/strict');

const { FFmpegRelay } = require('../lib/ffmpegRelay');

function createRelay(videoCodec) {
    return new FFmpegRelay({
        roomCode: 'TEST01',
        videoCodec,
        hasAudio: true,
        videoRtpPort: 5004,
        videoRtcpPort: 5005,
        audioRtpPort: 5006,
        audioRtcpPort: 5007,
        videoPayloadType: 96,
        audioPayloadType: 111,
    });
}

test('FFmpeg relay uses the hardened H.264 probe window', () => {
    const h264Relay = createRelay('h264');
    const h264Args = h264Relay._buildArgs('test.sdp');

    assert.equal(h264Args[h264Args.indexOf('-probesize') + 1], '8000000');
    assert.equal(h264Args[h264Args.indexOf('-analyzeduration') + 1], '8000000');
    assert.equal(h264Args[h264Args.indexOf('-muxpreload') + 1], '0');
    assert.equal(h264Args[h264Args.indexOf('-muxdelay') + 1], '0');
});

test('FFmpeg relay rejects non-H.264 input', () => {
    assert.throws(() => createRelay('av1'), /H\.264 input/i);
});
