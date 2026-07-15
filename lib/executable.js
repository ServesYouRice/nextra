'use strict';

const fs = require('fs');
const path = require('path');

function executableCandidates(command, platform, env) {
    if (platform !== 'win32' || path.extname(command)) return [command];
    const extensions = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`),
        ...extensions.map((extension) => `${command}${extension.toUpperCase()}`)];
}

function isUsableFile(candidate, platform) {
    try {
        if (!fs.statSync(candidate).isFile()) return false;
        if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function resolveExecutablePath(command, options = {}) {
    if (!command || typeof command !== 'string') return null;
    const platform = options.platform || process.platform;
    const env = options.env || process.env;
    const cwd = options.cwd || process.cwd();
    const hasPathComponent = path.isAbsolute(command) || /[\\/]/.test(command);
    const roots = hasPathComponent ? [''] : String(env.PATH || '').split(path.delimiter).filter(Boolean);

    for (const root of roots) {
        const base = hasPathComponent
            ? (path.isAbsolute(command) ? command : path.resolve(cwd, command))
            : path.join(root, command);
        for (const candidate of executableCandidates(base, platform, env)) {
            if (isUsableFile(candidate, platform)) {
                try { return fs.realpathSync(candidate); } catch { return path.resolve(candidate); }
            }
        }
    }
    return null;
}

module.exports = { resolveExecutablePath };
