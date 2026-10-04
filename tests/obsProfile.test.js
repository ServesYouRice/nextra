const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    findProfileDir,
    listObsVideoEncoders,
    obsConfigRoots,
    sanitizeEncoderSettings,
    writeStreamEncoderSettings,
} = require('../lib/obsProfile');

// An OBS configuration folder with the given profiles: { folder: 'Display name' }.
function fakeObsConfig(t, profiles) {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-obs-'));
    t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
    for (const [folder, name] of Object.entries(profiles)) {
        const dir = path.join(appData, 'obs-studio', 'basic', 'profiles', folder);
        fs.mkdirSync(dir, { recursive: true });
        // OBS writes basic.ini with a byte-order mark.
        fs.writeFileSync(path.join(dir, 'basic.ini'), `\uFEFF[General]\r\nName=${name}\r\n\r\n[Output]\r\nMode=Advanced\r\n`);
    }
    return { options: { env: { APPDATA: appData }, platform: 'win32' }, root: path.join(appData, 'obs-studio', 'basic', 'profiles') };
}

const nvenc = { rate_control: 'CBR', bitrate: 18000, keyint_sec: 1, bf: 0, lookahead: false, tune: 'll', preset: 'p5' };

test('the profile folder is found by the name OBS shows, not by its folder name', (t) => {
    const { options, root } = fakeObsConfig(t, { Untitled: 'Untitled', Streaming_2: 'Streaming (2)' });
    assert.equal(findProfileDir('Streaming (2)', options), path.join(root, 'Streaming_2'));
    assert.equal(findProfileDir('Untitled', options), path.join(root, 'Untitled'));
    assert.equal(findProfileDir('Missing', options), null);
    assert.equal(findProfileDir('', options), null);
    // A name is compared, never turned into a path.
    assert.equal(findProfileDir('..', options), null);
    assert.equal(findProfileDir('../../basic', options), null);
});

test('encoder settings are written where OBS reads them, keeping what else is there', (t) => {
    const { options, root } = fakeObsConfig(t, { Untitled: 'Untitled' });
    const file = path.join(root, 'Untitled', 'streamEncoder.json');
    fs.writeFileSync(file, JSON.stringify({ rate_control: 'CBR', device: 1, lookahead: true }));

    const result = writeStreamEncoderSettings({ profileName: 'Untitled', settings: nvenc }, options);

    assert.deepEqual(result, { ok: true, path: file });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...nvenc, device: 1 });
    assert.deepEqual(fs.readdirSync(path.join(root, 'Untitled')).sort(), ['basic.ini', 'streamEncoder.json']);
});

test('a missing or broken settings file is simply replaced', (t) => {
    const { options, root } = fakeObsConfig(t, { Untitled: 'Untitled' });
    const file = path.join(root, 'Untitled', 'streamEncoder.json');

    assert.equal(writeStreamEncoderSettings({ profileName: 'Untitled', settings: nvenc }, options).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), nvenc);

    fs.writeFileSync(file, '{not json');
    assert.equal(writeStreamEncoderSettings({ profileName: 'Untitled', settings: nvenc }, options).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), nvenc);
});

test('nothing is written when OBS is not on this machine or the settings are not ours to write', (t) => {
    const { options, root } = fakeObsConfig(t, { Untitled: 'Untitled' });
    const file = path.join(root, 'Untitled', 'streamEncoder.json');

    assert.deepEqual(writeStreamEncoderSettings({ profileName: 'Elsewhere', settings: nvenc }, options), { ok: false, reason: 'profile-not-found' });
    assert.deepEqual(writeStreamEncoderSettings({ profileName: 'Untitled', settings: nvenc }, { env: {}, platform: 'win32' }), { ok: false, reason: 'profile-not-found' });
    assert.deepEqual(writeStreamEncoderSettings({ profileName: 'Untitled', settings: { bitrate: 'lots' } }, options), { ok: false, reason: 'invalid-settings' });
    assert.equal(fs.existsSync(file), false);
});

test('only known settings with sane values are accepted', () => {
    assert.deepEqual(sanitizeEncoderSettings({ ...nvenc, x264opts: 'bframes=0', multipass: 'qres', profile: 'high', repeat_headers: true }),
        { ...nvenc, x264opts: 'bframes=0', multipass: 'qres', profile: 'high', repeat_headers: true });
    // Unknown keys are dropped rather than passed through to OBS.
    assert.deepEqual(sanitizeEncoderSettings({ bitrate: 6000, ffmpeg_opts: '-vf drawtext=...' }), { bitrate: 6000 });
    // A wrong value rejects the whole request.
    assert.equal(sanitizeEncoderSettings({ bitrate: 6000, keyint_sec: 0 }), null);
    assert.equal(sanitizeEncoderSettings({ bitrate: 10 }), null);
    assert.equal(sanitizeEncoderSettings({ bitrate: 6000.5 }), null);
    assert.equal(sanitizeEncoderSettings({ rate_control: 'CQP' }), null);
    assert.equal(sanitizeEncoderSettings({ x264opts: 'bframes=0:threads=64' }), null);
    assert.equal(sanitizeEncoderSettings({ preset: '../p5' }), null);
    assert.equal(sanitizeEncoderSettings({ lookahead: 'false' }), null);
    assert.equal(sanitizeEncoderSettings({}), null);
    assert.equal(sanitizeEncoderSettings(null), null);
    assert.equal(sanitizeEncoderSettings([1]), null);
});

test('OBS is looked for where each platform keeps it', () => {
    assert.deepEqual(obsConfigRoots({ env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, platform: 'win32', homedir: 'C:\\Users\\me' }),
        [path.join('C:\\Users\\me\\AppData\\Roaming', 'obs-studio')]);
    assert.deepEqual(obsConfigRoots({ env: {}, platform: 'darwin', homedir: '/Users/me' }),
        [path.join('/Users/me', 'Library', 'Application Support', 'obs-studio')]);
    const linux = obsConfigRoots({ env: { XDG_CONFIG_HOME: '/cfg' }, platform: 'linux', homedir: '/home/me' });
    assert.equal(linux[0], path.join('/cfg', 'obs-studio'));
    assert.ok(linux.includes(path.join('/home/me', '.config', 'obs-studio')));
});

// An OBS log directory: { 'file name': 'log text' }.
function fakeObsLogs(t, logs) {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-obs-'));
    t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
    const dir = path.join(appData, 'obs-studio', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(logs)) fs.writeFileSync(path.join(dir, name), text);
    return { env: { APPDATA: appData }, platform: 'win32' };
}

const startupLog = (encoders) => [
    '20:41:59.335: OBS 32.2.2 (64-bit, windows)',
    '20:42:01.369:     obs-nvenc.dll',
    '20:42:01.375: ---------------------------------',
    '20:42:01.375: Available Encoders:',
    '20:42:01.375:   Video Encoders:',
    ...encoders.map((line) => `20:42:01.375: \t- ${line}`),
    '20:42:01.375:   Audio Encoders:',
    '20:42:01.375: \t- ffmpeg_aac (FFmpeg AAC)',
    '20:42:01.375: \t- ffmpeg_opus (FFmpeg Opus)',
    '20:42:01.500: ==== Startup complete ===============================================',
    '',
].join('\r\n');

test('the encoders OBS has are read from the newest OBS log', (t) => {
    const options = fakeObsLogs(t, {
        '2026-08-30 19-39-12.txt': startupLog(['obs_x264 (x264)']),
        '2026-10-03 20-41-58.txt': startupLog([
            'ffmpeg_svt_av1 (SVT-AV1)',
            'obs_nvenc_h264_tex (NVIDIA NVENC H.264)',
            'obs_nvenc_av1_tex (NVIDIA NVENC AV1)',
            'com.apple.videotoolbox.videoencoder.ave.avc (Apple VT H264 Hardware Encoder)',
            'obs_x264 (x264)',
        ]),
        'notes.md': startupLog(['h264_texture_amf (AMD HW H.264 (AVC))']),
    });

    assert.deepEqual(listObsVideoEncoders(options), [
        'ffmpeg_svt_av1',
        'obs_nvenc_h264_tex',
        'obs_nvenc_av1_tex',
        'com.apple.videotoolbox.videoencoder.ave.avc',
        'obs_x264',
    ]);
});

test('a log that stops before the encoder list falls back to the one before it', (t) => {
    const options = fakeObsLogs(t, {
        '2026-10-03 20-41-13.txt': startupLog(['obs_qsv11 (QuickSync H.264)', 'obs_x264 (x264)']),
        '2026-10-03 20-41-58.txt': '20:41:59.335: OBS 32.2.2 (64-bit, windows)\r\n',
    });
    assert.deepEqual(listObsVideoEncoders(options), ['obs_qsv11', 'obs_x264']);
});

test('the encoders are unknown when OBS has no usable log here', (t) => {
    assert.equal(listObsVideoEncoders({ env: {}, platform: 'win32' }), null);
    assert.equal(listObsVideoEncoders(fakeObsLogs(t, {})), null);
    // An OBS too old to list its encoders.
    assert.equal(listObsVideoEncoders(fakeObsLogs(t, { '2023-01-01 10-00-00.txt': '10:00:00.000: OBS 28.0.0\r\n' })), null);
    // A list with nothing in it is not an answer.
    assert.equal(listObsVideoEncoders(fakeObsLogs(t, { '2026-10-03 20-41-58.txt': startupLog([]) })), null);
});
