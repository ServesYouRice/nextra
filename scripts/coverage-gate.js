'use strict';

const { spawnSync } = require('node:child_process');

const thresholds = {
    lines: 70,
    branches: 60,
    functions: 75,
};
const targets = new Set([
    'lib/roomMediaPipeline.js',
    'src/lib/lifecycleController.mjs',
    'src/lib/mediasoupClient.js',
    'src/lib/fmp4RelayPlayer.js',
]);
const testFiles = [
    'tests/roomMediaPipeline.test.js',
    'tests/lifecycleController.test.js',
    'tests/mediasoupClient.test.js',
    'tests/fmp4RelayPlayer.test.js',
];

const result = spawnSync(process.execPath, [
    '--test',
    '--experimental-test-coverage',
    ...testFiles,
], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
});

process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');

if (result.error) {
    throw result.error;
}
if (result.status !== 0) {
    process.exitCode = result.status || 1;
    return;
}

const observed = new Map();
const pathAtDepth = [];
for (const line of String(result.stdout).split(/\r?\n/)) {
    const match = line.match(/^# (.*?\S)\s+\|\s*([\d.]*)\s+\|\s*([\d.]*)\s+\|\s*([\d.]*)\s+\|/);
    if (!match) continue;
    const rawName = match[1];
    const depth = rawName.length - rawName.trimStart().length;
    pathAtDepth[depth] = rawName.trim();
    pathAtDepth.length = depth + 1;
    const file = pathAtDepth.join('/').replaceAll('\\', '/');
    if (!targets.has(file)) continue;
    if (!match[2] || !match[3] || !match[4]) continue;
    observed.set(file, {
        lines: Number(match[2]),
        branches: Number(match[3]),
        functions: Number(match[4]),
    });
}

const failures = [];
for (const file of targets) {
    const coverage = observed.get(file);
    if (!coverage) {
        failures.push(`${file}: no coverage result`);
        continue;
    }
    for (const [metric, minimum] of Object.entries(thresholds)) {
        if (coverage[metric] < minimum) {
            failures.push(`${file}: ${metric} ${coverage[metric]}% is below ${minimum}%`);
        }
    }
}

if (failures.length > 0) {
    console.error(`Coverage threshold failure:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
} else {
    console.log(`Coverage thresholds passed for ${targets.size} runtime files.`);
}
