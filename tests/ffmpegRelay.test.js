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

test('FFmpeg relay uses larger probe window for H.264 than AV1', () => {
    const h264Relay = createRelay('h264');
    const av1Relay = createRelay('av1');

    const h264Args = h264Relay._buildArgs('test.sdp');
    const av1Args = av1Relay._buildArgs('test.sdp');

    assert.equal(h264Args[h264Args.indexOf('-probesize') + 1], '5000000');
    assert.equal(h264Args[h264Args.indexOf('-analyzeduration') + 1], '5000000');
    assert.equal(av1Args[av1Args.indexOf('-probesize') + 1], '1000000');
    assert.equal(av1Args[av1Args.indexOf('-analyzeduration') + 1], '1000000');
});
