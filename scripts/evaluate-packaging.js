'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const lock = require(path.join(root, 'package-lock.json'));
const caxa = lock.packages?.['node_modules/caxa'];
const requiredInputs = [
    'server.js',
    'config.js',
    'lib',
    'public',
    'LICENSE',
    'SOURCE.md',
    'THIRD_PARTY_NOTICES.md',
];
const missingInputs = requiredInputs.filter((entry) => !fs.existsSync(path.join(root, entry)));
const nativeRuntimeDependencies = Object.keys(pkg.dependencies || {}).filter((name) => name === 'mediasoup');

const evaluation = {
    generatedAt: new Date().toISOString(),
    current: {
        format: ['Windows x64 executable', 'macOS arm64 executable'],
        packager: 'caxa',
        version: caxa?.version || null,
        verifiedBy: [
            'scripts/package-app.js',
            'scripts/smoke-packaged.js',
            'Windows CI',
            'macOS CI',
            'tagged artifact smoke test',
        ],
        status: missingInputs.length === 0 && caxa?.version ? 'retain-verified-path' : 'invalid',
    },
    constraints: {
        node: pkg.engines?.node || null,
        nativeRuntimeDependencies,
        requiredInputs,
        missingInputs,
        acceptanceCriteria: [
            'mediasoup worker subprocess starts',
            'runtime assets and compliance files are embedded',
            'FFmpeg/cloudflared child processes and graceful shutdown work',
            'the published executable matches its generated SHA-256 checksum',
            'startup logging and writable runtime directories work on a clean host',
        ],
    },
    candidates: [
        {
            name: 'Node SEA',
            disposition: 'evaluate-only',
            blocker: 'Must prove native mediasoup subprocess/module loading and bundled asset extraction before migration.',
        },
        {
            name: 'Container image',
            disposition: 'new-product-target',
            blocker: 'Requires an explicit service/networking support posture, media-plane exposure, TURN, and FFmpeg validation.',
        },
    ],
};

process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
if (evaluation.current.status === 'invalid') process.exitCode = 1;
