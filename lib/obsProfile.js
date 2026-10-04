// lib/obsProfile.js - Writes OBS's stream encoder settings and reads which
// encoders OBS has.
//
// OBS's WebSocket API can choose an encoder but has no request for the encoder's
// own settings (bitrate, keyframe interval, B-frames, look-ahead). In Advanced
// output mode OBS reads those from streamEncoder.json in the profile folder each
// time a stream starts — nowhere else. Without that file OBS streams on its
// defaults: a keyframe every 250 frames, B-frames and look-ahead on. So when OBS
// runs on the same machine as this server, the file is written directly.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ENCODER_SETTINGS_FILE = 'streamEncoder.json';
// OBS lists its encoders while starting up, in the first few hundred lines.
const LOG_HEAD_BYTES = 256 * 1024;
const LOGS_TO_CHECK = 2;
const MAX_LISTED_ENCODERS = 64;

const STRING_ENUMS = {
    rate_control: ['CBR'],
    tune: ['hq', 'll', 'ull', 'zerolatency'],
    multipass: ['disabled', 'qres', 'fullres'],
    profile: ['high', 'main', 'baseline'],
    latency: ['ultra-low', 'low', 'normal'],
    // The only x264 option this app sets; anything else would be a way to pass
    // arbitrary encoder options through.
    x264opts: ['bframes=0'],
};
const INT_RANGES = {
    bitrate: [500, 100_000],
    max_bitrate: [500, 100_000],
    keyint_sec: [1, 10],
    bf: [0, 4],
    bframes: [0, 4],
};
const BOOLEANS = ['lookahead', 'adaptive_quantization', 'repeat_headers', 'disable_scenecut'];
const PRESET_KEYS = ['preset', 'preset2'];

/** Reduce client-supplied settings to the keys and values this app may write. */
function sanitizeEncoderSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const settings = {};
    for (const [key, allowed] of Object.entries(STRING_ENUMS)) {
        if (input[key] === undefined) continue;
        if (!allowed.includes(input[key])) return null;
        settings[key] = input[key];
    }
    for (const [key, [min, max]] of Object.entries(INT_RANGES)) {
        if (input[key] === undefined) continue;
        if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) return null;
        settings[key] = input[key];
    }
    for (const key of BOOLEANS) {
        if (input[key] === undefined) continue;
        if (typeof input[key] !== 'boolean') return null;
        settings[key] = input[key];
    }
    for (const key of PRESET_KEYS) {
        if (input[key] === undefined) continue;
        if (typeof input[key] !== 'string' || !/^[a-z0-9]{1,16}$/i.test(input[key])) return null;
        settings[key] = input[key];
    }
    return Object.keys(settings).length > 0 ? settings : null;
}

/** Folders OBS may keep its configuration in, most likely first. */
function obsConfigRoots({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
    const roots = [];
    if (platform === 'win32') {
        if (env.APPDATA) roots.push(path.join(env.APPDATA, 'obs-studio'));
    } else if (platform === 'darwin') {
        roots.push(path.join(homedir, 'Library', 'Application Support', 'obs-studio'));
    } else {
        if (env.XDG_CONFIG_HOME) roots.push(path.join(env.XDG_CONFIG_HOME, 'obs-studio'));
        roots.push(path.join(homedir, '.config', 'obs-studio'));
        roots.push(path.join(homedir, '.var', 'app', 'com.obsproject.Studio', 'config', 'obs-studio'));
    }
    return roots;
}

function readProfileName(basicIniPath) {
    let text;
    try {
        text = fs.readFileSync(basicIniPath, 'utf8');
    } catch {
        return null;
    }
    let section = '';
    for (const rawLine of text.split(/\r?\n/)) {
        const line = (rawLine.charCodeAt(0) === 0xfeff ? rawLine.slice(1) : rawLine).trim();
        const header = /^\[(.+)\]$/.exec(line);
        if (header) {
            section = header[1];
            continue;
        }
        if (section !== 'General') continue;
        const match = /^Name=(.*)$/.exec(line);
        if (match) return match[1];
    }
    return null;
}

/**
 * The folder of the OBS profile called `profileName`. The name is only compared
 * against the profiles found on disk, never used to build a path.
 */
function findProfileDir(profileName, options) {
    if (typeof profileName !== 'string' || !profileName) return null;
    for (const root of obsConfigRoots(options)) {
        const profilesDir = path.join(root, 'basic', 'profiles');
        let entries;
        try {
            entries = fs.readdirSync(profilesDir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(profilesDir, entry.name);
            if (readProfileName(path.join(dir, 'basic.ini')) === profileName) return dir;
        }
    }
    return null;
}

function readFileHead(file, bytes) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(bytes);
        return buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, bytes, 0));
    } catch {
        return '';
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { }
    }
}

/** The encoder ids under "Video Encoders:" in an OBS log, or null if it has no such list. */
function parseVideoEncoders(logText) {
    const lines = logText.split(/\r?\n/);
    const start = lines.findIndex((line) => /Video Encoders:\s*$/.test(line));
    if (start < 0) return null;
    const encoders = [];
    for (const line of lines.slice(start + 1, start + 1 + MAX_LISTED_ENCODERS)) {
        const match = /^[\d:.]+:\s+-\s+([\w.-]{1,96})\s+\(/.exec(line);
        if (!match) break;
        encoders.push(match[1]);
    }
    return encoders.length > 0 ? encoders : null;
}

/**
 * The video encoders OBS says it has on this machine, read from the list OBS
 * writes to its log when it starts. Null when OBS is not on this machine or its
 * log has no such list. A web page can only guess the GPU, and browsers that
 * hide it would otherwise leave a machine with a hardware encoder on x264.
 */
function listObsVideoEncoders(options) {
    for (const root of obsConfigRoots(options)) {
        const logsDir = path.join(root, 'logs');
        let names;
        try {
            names = fs.readdirSync(logsDir).filter((name) => name.endsWith('.txt'));
        } catch {
            continue;
        }
        // OBS names its logs by start time, so the last names are the newest.
        for (const name of names.sort().reverse().slice(0, LOGS_TO_CHECK)) {
            const encoders = parseVideoEncoders(readFileHead(path.join(logsDir, name), LOG_HEAD_BYTES));
            if (encoders) return encoders;
        }
    }
    return null;
}

/**
 * Merge `settings` into the profile's streamEncoder.json. Returns
 * { ok: true, path } or { ok: false, reason }: 'invalid-settings',
 * 'profile-not-found' (OBS is not on this machine, or runs in portable mode), or
 * 'write-failed'.
 */
function writeStreamEncoderSettings({ profileName, settings }, options) {
    const sanitized = sanitizeEncoderSettings(settings);
    if (!sanitized) return { ok: false, reason: 'invalid-settings' };
    const dir = findProfileDir(profileName, options);
    if (!dir) return { ok: false, reason: 'profile-not-found' };

    const file = path.join(dir, ENCODER_SETTINGS_FILE);
    let existing = {};
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
    } catch {
        // Missing or unreadable: start from what this app sets.
    }

    const temp = `${file}.nextra-tmp`;
    try {
        fs.writeFileSync(temp, JSON.stringify({ ...existing, ...sanitized }), 'utf8');
        fs.renameSync(temp, file);
    } catch {
        try { fs.unlinkSync(temp); } catch { }
        return { ok: false, reason: 'write-failed' };
    }
    return { ok: true, path: file };
}

module.exports = {
    findProfileDir,
    listObsVideoEncoders,
    obsConfigRoots,
    sanitizeEncoderSettings,
    writeStreamEncoderSettings,
};
