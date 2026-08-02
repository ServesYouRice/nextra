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
    'cloudflared.exe',
    'cloudflared',
]);

const forbiddenPathRegexes = [
    /^\.env(?:\..+)?$/i,
    /(?:^|\/)certs\/.+\.(?:key|crt|pem|p12|pfx)$/i,
    /(?:^|\/)(?:Nextra|cloudflared)\.exe$/i,
    /(?:^|\/)cloudflared$/i,
];

const sensitiveRegexes = [
    { name: 'Private key block', regex: /-----BEGIN\s+(?:RSA\s+|EC\s+)?PRIVATE KEY-----/ },
    { name: 'OpenSSH private key block', regex: /-----BEGIN\s+OPENSSH\s+PRIVATE KEY-----/ },
    { name: 'Hardcoded AWS key pattern', regex: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: 'Hardcoded GitHub token pattern', regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
    { name: 'Hardcoded OpenAI-style API key pattern', regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
    { name: 'Hardcoded Google API key pattern', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

function getTrackedFiles() {
    try {
        const output = execSync('git ls-files', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf-8');
        return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch {
        return null;
    }
}

function isTextFile(filePath) {
    try {
        const buffer = fs.readFileSync(filePath);
        const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
        return !sample.includes(0);
    } catch {
        return false;
    }
}

function scanTrackedFiles(trackedFiles) {
    const violations = [];

    for (const relPath of trackedFiles) {
        const normalized = relPath.replace(/\\/g, '/');
        if (forbiddenTracked.has(normalized)) {
            violations.push(`Forbidden tracked file: ${relPath}`);
            continue;
        }
        if (normalized !== '.env.example' && forbiddenPathRegexes.some((regex) => regex.test(normalized))) {
            violations.push(`Forbidden tracked path pattern: ${relPath}`);
            continue;
        }

        const absPath = path.join(root, relPath);
        if (!isTextFile(absPath)) continue;

        let text;
        try {
            text = fs.readFileSync(absPath, 'utf-8');
        } catch {
            continue;
        }

        for (const { name, regex } of sensitiveRegexes) {
            if (regex.test(text)) {
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
    findDependencyLicenseViolations,
    reviewedDependencyLicenses,
};
