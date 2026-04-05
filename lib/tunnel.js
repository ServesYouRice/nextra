// lib/tunnel.js - Optional public internet tunnel helpers (Cloudflare Quick Tunnel)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawn } = require('child_process');

function hasPathSeparator(value) {
    return value.includes('/') || value.includes('\\') || /^[A-Za-z]:/.test(value);
}

function commandExists(command) {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(lookup, [command], {
        stdio: ['ignore', 'ignore', 'ignore'],
        shell: process.platform === 'win32',
    });
    return result.status === 0;
}

function canUseCandidate(candidate) {
    if (!candidate) return false;
    if (!hasPathSeparator(candidate)) return commandExists(candidate);
    try {
        return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function debugTunnel(message) {
    if (process.env.DEBUG_TUNNEL !== '1') return;
    console.warn(`[tunnel-debug] ${message}`);
}

function unique(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        if (!value || seen.has(value)) continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}

function getCloudflaredCandidates(explicitPath = '') {
    const exeDir = path.dirname(process.execPath || process.cwd());
    const isWindows = process.platform === 'win32';
    const localName = isWindows ? 'cloudflared.exe' : 'cloudflared';
    const bundledRoot = path.resolve(__dirname, '..');
    const argvScriptDir = process.argv[1] ? path.dirname(process.argv[1]) : '';
    const caxaDir = process.env.CAXA || process.env.CAXA_TMPDIR || process.env.CAXA_TEMPDIR || '';
    const caxaEntrypointDir = process.env.CAXA_ENTRYPOINT ? path.dirname(process.env.CAXA_ENTRYPOINT) : '';
    const allowSystemCloudflared = process.env.ALLOW_SYSTEM_CLOUDFLARED === '1';
    const explicitIsCommand = !!explicitPath && !hasPathSeparator(explicitPath);
    const includeSystemCommands = allowSystemCloudflared || explicitIsCommand;

    return unique([
        explicitPath,
        path.join(__dirname, localName),
        path.join(bundledRoot, localName),
        caxaDir ? path.join(caxaDir, localName) : '',
        caxaEntrypointDir ? path.join(caxaEntrypointDir, localName) : '',
        argvScriptDir ? path.join(argvScriptDir, localName) : '',
        path.join(exeDir, localName),
        allowSystemCloudflared ? path.join(process.cwd(), localName) : '',
        includeSystemCommands && isWindows ? 'cloudflared.exe' : '',
        includeSystemCommands ? 'cloudflared' : '',
    ]);
}

function stopChildProcess(child) {
    if (!child || child.killed) return;
    try {
        child.kill('SIGTERM');
    } catch {
        return;
    }

    setTimeout(() => {
        if (!child.killed) {
            try { child.kill('SIGKILL'); } catch { }
        }
    }, 1000);
}

function launchCloudflaredCandidate(command, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        const onOutput = (chunk) => {
            if (settled) return;
            const text = chunk.toString();
            const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
            if (!match) return;

            settled = true;
            clearTimeout(timeout);
            child.stdout.off('data', onOutput);
            child.stderr.off('data', onOutput);
            child.off('error', onError);
            child.off('exit', onExitBeforeReady);

            const baseUrl = match[0].toLowerCase();
            resolve({
                baseUrl,
                stop: () => stopChildProcess(child),
                process: child,
                command,
            });
        };

        const onError = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(err);
        };

        const onExitBeforeReady = (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(new Error(`cloudflared exited before publishing tunnel URL (code=${code}, signal=${signal || 'none'})`));
        };

        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            stopChildProcess(child);
            reject(new Error(`cloudflared did not return a public URL within ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout.on('data', onOutput);
        child.stderr.on('data', onOutput);
        child.once('error', onError);
        child.once('exit', onExitBeforeReady);
    });
}

async function startCloudflareQuickTunnel({
    port,
    explicitPath = '',
    timeoutMs = 20000,
    noTlsVerify = true,
} = {}) {
    const allCandidates = getCloudflaredCandidates(explicitPath);
    allCandidates.forEach((candidate) => {
        if (!candidate) return;
        const usable = canUseCandidate(candidate);
        debugTunnel(`candidate="${candidate}" usable=${usable}`);
    });

    const candidates = allCandidates.filter(canUseCandidate);
    if (!candidates.length) {
        throw new Error('No cloudflared binary found (set CLOUDFLARED_PATH or install cloudflared).');
    }

    const args = ['tunnel', '--url', `https://127.0.0.1:${port}`, '--no-autoupdate'];
    if (noTlsVerify) args.push('--no-tls-verify');

    let lastError = null;
    for (const candidate of candidates) {
        try {
            return await launchCloudflaredCandidate(candidate, args, timeoutMs);
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('Unable to start cloudflared quick tunnel.');
}

module.exports = {
    startCloudflareQuickTunnel,
};
