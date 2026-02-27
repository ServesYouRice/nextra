// scripts/opensource-preflight.js - Guardrails before publishing source code
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');

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

function main() {
    const trackedFiles = getTrackedFiles();
    if (!trackedFiles) {
        console.error('[oss:check] FAILED. This command must be run from a git repository root.');
        console.error('[oss:check] Initialize git and run again so tracked files can be validated.');
        process.exit(1);
    }

    const violations = scanTrackedFiles(trackedFiles);
    if (violations.length) {
        console.error('[oss:check] FAILED. Resolve these issues before publishing:');
        for (const issue of violations) {
            console.error(` - ${issue}`);
        }
        process.exit(1);
    }

    console.log('[oss:check] OK. No forbidden tracked files or obvious secret patterns were detected.');
}

main();
