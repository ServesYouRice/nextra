const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { spawn, spawnSync } = require('node:child_process');

const { OggOpusMuxer } = require('../lib/oggOpusMuxer');

function commandAvailable(command) {
    const result = spawnSync(command, ['-version'], { stdio: 'ignore', windowsHide: true });
    return !result.error && result.status === 0;
}

function waitForExit(child) {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`process exited with code ${code}, signal ${signal}`));
        });
    });
}

test('OggOpusMuxer output is accepted by FFmpeg', {
    skip: !commandAvailable('ffmpeg') || !commandAvailable('ffprobe'),
}, async () => {
    const socket = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, '127.0.0.1', resolve);
    });
    const port = socket.address().port;
    const muxer = new OggOpusMuxer({ serial: 20260713 });
    const chunks = [muxer.headers()];
    socket.on('message', (packet) => {
        const page = muxer.pushRtp(packet);
        if (page) chunks.push(page);
    });

    const producer = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.25',
        '-c:a', 'libopus', '-frame_duration', '20', '-payload_type', '111',
        '-f', 'rtp', `rtp://127.0.0.1:${port}`,
    ], { stdio: 'ignore', windowsHide: true });

    try {
        await waitForExit(producer);
        await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
        socket.close();
    }

    assert.ok(chunks.length > 2, 'expected Opus RTP packets from FFmpeg');
    const probe = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=codec_name,codec_type,channels,sample_rate',
        '-of', 'json',
        '-i', 'pipe:0',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [];
    const stderr = [];
    probe.stdout.on('data', (chunk) => stdout.push(chunk));
    probe.stderr.on('data', (chunk) => stderr.push(chunk));
    probe.stdin.end(Buffer.concat(chunks));
    await assert.doesNotReject(waitForExit(probe), Buffer.concat(stderr).toString());

    const result = JSON.parse(Buffer.concat(stdout).toString());
    assert.equal(result.streams[0].codec_name, 'opus');
    assert.equal(result.streams[0].codec_type, 'audio');
    assert.equal(result.streams[0].sample_rate, '48000');
});
