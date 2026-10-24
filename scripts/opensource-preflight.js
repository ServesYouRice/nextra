// scripts/opensource-preflight.js - Guardrails before publishing source code
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');

const productionLockfiles = [
    'package-lock.json',
    'poc-mediasoup/package-lock.json',
];

// Keep this deliberately narrow. A new license is a review event, even when it is
// probably compatible, so the release gate should fail until it is acknowledged.
const reviewedDependencyLicenses = new Set([
    '0BSD',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'BlueOak-1.0.0',
    'ISC',
    'MIT',
]);

const forbiddenTracked = new Set([
    '.env',
    '.env.local',
    '.env.production',
    '.env.development',
    '.env.test',
    'certs/server.key',
    'certs/server.crt',
    'Nextra.exe',
    'Nextra-macos-arm64',
    'Nextra-macos-x64',
    'cloudflared.exe',
    'cloudflared',
    'ffmpeg.exe',
    'ffmpeg',
]);

// The only tracked .env-style file that is allowed, by basename, at any depth.
const allowedEnvTemplate = '.env.example';

const forbiddenPathRegexes = [
    /(?:^|\/)\.env(?:\..+)?$/i,
    /(?:^|\/)certs\/.+\.(?:key|crt|pem|p12|pfx)$/i,
    /(?:^|\/)(?:Nextra|cloudflared|ffmpeg)\.exe$/i,
    /(?:^|\/)Nextra-macos-(?:arm64|x64)$/i,
    /(?:^|\/)(?:cloudflared|ffmpeg)$/i,
];

const sensitiveRegexes = [
    { name: 'Private key block', regex: /-----BEGIN\s+(?:RSA\s+|EC\s+)?PRIVATE KEY-----/ },
    { name: 'OpenSSH private key block', regex: /-----BEGIN\s+OPENSSH\s+PRIVATE KEY-----/ },
    { name: 'Hardcoded AWS key pattern', regex: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: 'Hardcoded GitHub token pattern', regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
    { name: 'Hardcoded OpenAI-style API key pattern', regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
    { name: 'Hardcoded Google API key pattern', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

// Splits the output of `git ls-files -z`. Entries are NUL-terminated and are the
// exact on-disk names (no quoting, no escaping), so they must not be trimmed.
function parseTrackedFileList(output) {
    const text = Buffer.isBuffer(output) ? output.toString('utf-8') : String(output);
    return text.split('\0').filter((entry) => entry.length > 0);
}

function getTrackedFiles(cwd = root) {
    try {
        const output = execSync('git ls-files -z', {
            cwd,
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 256 * 1024 * 1024,
        });
        return parseTrackedFileList(output);
    } catch {
        return null;
    }
}

// Returns 'forbidden-file' (an exact forbidden name), 'forbidden-pattern' (a forbidden
// path pattern at any depth) or 'allowed'. A .env.example template is allowed at any depth.
function classifyTrackedPath(relPath) {
    const normalized = relPath.replace(/\\/g, '/');
    if (forbiddenTracked.has(normalized)) return 'forbidden-file';
    if (normalized.slice(normalized.lastIndexOf('/') + 1) === allowedEnvTemplate) return 'allowed';
    if (forbiddenPathRegexes.some((regex) => regex.test(normalized))) return 'forbidden-pattern';
    return 'allowed';
}

// Classifies what is on disk at a tracked path:
//   { kind: 'text', text }        readable, scanned for secrets
//   { kind: 'binary' }            NUL in the first 1024 bytes, not content-scanned
//   { kind: 'directory' }         a gitlink (submodule) checkout, not scanned
//   { kind: 'unreadable', code }  missing or unreadable, which must fail the gate
function classifyTrackedFile(absPath) {
    let buffer;
    try {
        if (fs.statSync(absPath).isDirectory()) return { kind: 'directory' };
        buffer = fs.readFileSync(absPath);
    } catch (err) {
        return { kind: 'unreadable', code: err?.code || 'UNKNOWN' };
    }

    const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
    if (sample.includes(0)) return { kind: 'binary' };
    return { kind: 'text', text: buffer.toString('utf-8') };
}

function scanTrackedFiles(trackedFiles, scanRoot = root) {
    const violations = [];

    for (const relPath of trackedFiles) {
        const pathClass = classifyTrackedPath(relPath);
        if (pathClass === 'forbidden-file') {
            violations.push(`Forbidden tracked file: ${relPath}`);
            continue;
        }
        if (pathClass === 'forbidden-pattern') {
            violations.push(`Forbidden tracked path pattern: ${relPath}`);
            continue;
        }

        const file = classifyTrackedFile(path.join(scanRoot, relPath));
        if (file.kind === 'unreadable') {
            violations.push(`Cannot read tracked file: ${relPath} (${file.code})`);
            continue;
        }
        if (file.kind !== 'text') continue;

        for (const { name, regex } of sensitiveRegexes) {
            if (regex.test(file.text)) {
                violations.push(`${name} found in tracked file: ${relPath}`);
            }
        }
    }

    return violations;
}

function findDependencyLicenseViolations(lockfile, label) {
    if (!lockfile || typeof lockfile !== 'object' || !lockfile.packages || typeof lockfile.packages !== 'object') {
        return [`Invalid package lock structure: ${label}`];
    }

    const violations = [];
    for (const [packagePath, metadata] of Object.entries(lockfile.packages)) {
        if (!packagePath || !packagePath.includes('node_modules/') || metadata?.dev === true) continue;

        const packageName = packagePath.slice(packagePath.lastIndexOf('node_modules/') + 'node_modules/'.length);
        const license = typeof metadata?.license === 'string' ? metadata.license.trim() : '';
        if (!license) {
            violations.push(`Missing production dependency license in ${label}: ${packageName}`);
        } else if (!reviewedDependencyLicenses.has(license)) {
            violations.push(`Unreviewed production dependency license in ${label}: ${packageName} (${license})`);
        }
    }

    return violations;
}

function scanDependencyLockfiles() {
    const violations = [];

    for (const relativePath of productionLockfiles) {
        const absolutePath = path.join(root, relativePath);
        let lockfile;
        try {
            lockfile = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
        } catch (err) {
            violations.push(`Cannot read dependency license metadata from ${relativePath}: ${err.message}`);
            continue;
        }
        violations.push(...findDependencyLicenseViolations(lockfile, relativePath));
    }

    return violations;
}

function main() {
    const trackedFiles = getTrackedFiles();
    if (!trackedFiles) {
        console.error('[oss:check] FAILED. This command must be run from a git repository root.');
        console.error('[oss:check] Initialize git and run again so tracked files can be validated.');
        process.exit(1);
    }

    const violations = [
        ...scanTrackedFiles(trackedFiles),
        ...scanDependencyLockfiles(),
    ];
    if (violations.length) {
        console.error('[oss:check] FAILED. Resolve these issues before publishing:');
        for (const issue of violations) {
            console.error(` - ${issue}`);
        }
        process.exit(1);
    }

    console.log('[oss:check] OK. Tracked-file safeguards and reviewed production dependency licenses passed.');
}

if (require.main === module) main();

module.exports = {
    classifyTrackedFile,
    classifyTrackedPath,
    findDependencyLicenseViolations,
    parseTrackedFileList,
    reviewedDependencyLicenses,
    scanTrackedFiles,
};
