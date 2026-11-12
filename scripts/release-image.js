// scripts/release-image.js - Local release of the server image (no hosted CI)
//
// Verifies a clean commit, runs the full checks, builds the linux/amd64 image
// tagged with that commit, then smoke-tests and scans that exact image. Without
// `--push` it stops there (a dry run). With `--push` it publishes the image and
// prints the registry's sha256 digest, which is what a deployment pins. It never
// edits or pushes any other repository.
const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPOSITORY = 'ghcr.io/servesyourice/nextra';
const PLATFORM = 'linux/amd64';
// Trivy by version from Google's mirror of Docker Hub, which has no anonymous pull limit.
const TRIVY_IMAGE = 'mirror.gcr.io/aquasec/trivy:0.76.1';
const USAGE = 'Usage: npm run release:image [-- --push]';
const root = path.resolve(__dirname, '..');

function parseArgs(argv) {
    const unknown = argv.filter((arg) => arg !== '--push');
    if (unknown.length > 0) throw new Error(`Unknown option: ${unknown.join(' ')}. ${USAGE}`);
    return { push: argv.includes('--push') };
}

function isLoopbackProxy(proxy) {
    return /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(proxy || '');
}

/**
 * A loopback HTTPS proxy (a TLS-inspecting corporate or sandbox proxy) is reachable from the build only with host
 * networking, and its CA is passed as a build secret so it never enters a layer. No proxy: no extra arguments.
 */
function proxyBuildArgs(env = process.env, fileExists = fs.existsSync) {
    const proxy = env.HTTPS_PROXY || env.https_proxy;
    if (!proxy) return [];
    const args = ['--build-arg', `HTTPS_PROXY=${proxy}`, '--build-arg', `https_proxy=${proxy}`];
    if (isLoopbackProxy(proxy)) args.push('--network', 'host');
    const ca = env.NODE_EXTRA_CA_CERTS;
    if (ca && fileExists(ca)) args.push('--secret', `id=build_ca,src=${ca}`);
    return args;
}

/** The same proxy and CA for a helper container such as the scanner. */
function proxyRunArgs(env = process.env, fileExists = fs.existsSync) {
    const proxy = env.HTTPS_PROXY || env.https_proxy;
    if (!proxy) return [];
    const args = ['-e', `HTTPS_PROXY=${proxy}`];
    if (isLoopbackProxy(proxy)) args.push('--network', 'host');
    const ca = env.NODE_EXTRA_CA_CERTS;
    if (ca && fileExists(ca)) args.push('-v', `${ca}:/etc/ssl/certs/proxy-ca.crt:ro`, '-e', 'SSL_CERT_FILE=/etc/ssl/certs/proxy-ca.crt');
    return args;
}

/** The registry digest of `repository` among an image's RepoDigests, or '' when it has none. */
function registryDigest(repoDigests, repository = REPOSITORY) {
    const prefix = `${repository}@sha256:`;
    const match = (Array.isArray(repoDigests) ? repoDigests : []).find((entry) => typeof entry === 'string' && entry.startsWith(prefix));
    return match ? match.slice(repository.length + 1) : '';
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' && command === 'npm', ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args[0]} failed with exit code ${result.status}.`);
}

function capture(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', cwd: root, maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed: ${String(result.stderr).trim().slice(0, 2000)}`);
    return String(result.stdout).trim();
}

function cleanTree() {
    const status = capture('git', ['status', '--porcelain', '--untracked-files=all']);
    if (status) throw new Error(`A release needs a clean working tree:\n${status}`);
    return capture('git', ['rev-parse', 'HEAD']);
}

function httpStatus(url) {
    return new Promise((resolve) => {
        const request = http.get(url, { timeout: 3000 }, (response) => {
            response.resume();
            resolve(response.statusCode || 0);
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => resolve(0));
    });
}

/**
 * Start the image the way a hardened host runs it (read-only root, no capabilities, non-root user) and require the
 * health and readiness routes and the page to answer. Readiness covers the media worker.
 */
async function smokeImage(image, revision) {
    const user = capture('docker', ['image', 'inspect', '--format', '{{.Config.User}}', image]);
    if (user !== '1000:1000') throw new Error(`The image must run as 1000:1000, not "${user}".`);
    const label = capture('docker', ['image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]);
    if (label !== revision) throw new Error(`The image is labelled with revision "${label}", not ${revision}.`);
    const container = capture('docker', ['run', '--detach', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--env', 'BIND_HOST=0.0.0.0', '--publish', '127.0.0.1::3000', image]);
    try {
        const port = capture('docker', ['port', container, '3000/tcp']).split('\n')[0].split(':').pop();
        const base = `http://127.0.0.1:${port}`;
        let healthy = false;
        for (let attempt = 0; attempt < 60 && !healthy; attempt += 1) {
            healthy = await httpStatus(`${base}/healthz`) === 200;
            if (!healthy) await new Promise((resolve) => { setTimeout(resolve, 500); });
        }
        if (!healthy) throw new Error('The container did not become healthy within 30 seconds.');
        for (const route of ['/readyz', '/', '/api/config']) {
            const status = await httpStatus(`${base}${route}`);
            if (status !== 200) throw new Error(`GET ${route} answered ${status}, not 200.`);
        }
        console.log(`Smoke passed on ${base}: /healthz, /readyz, / and /api/config answer 200 as user ${user} on a read-only root.`);
    } catch (error) {
        const logs = spawnSync('docker', ['logs', '--tail', '40', container], { encoding: 'utf8' });
        console.error(`${logs.stdout || ''}${logs.stderr || ''}`);
        throw error;
    } finally {
        spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
    }
}

function scanImage(image) {
    const scan = ['image', '--scanners', 'vuln', '--severity', 'HIGH,CRITICAL', '--ignore-unfixed', '--exit-code', '1', '--no-progress', image];
    const local = spawnSync('trivy', ['--version'], { stdio: 'ignore' });
    if (!local.error && local.status === 0) return run('trivy', scan);
    return run('docker', ['run', '--rm', ...proxyRunArgs(), '-v', '/var/run/docker.sock:/var/run/docker.sock',
        '-v', 'nextra-trivy-cache:/root/.cache', TRIVY_IMAGE, ...scan]);
}

function step(name) {
    console.log(`\n== ${name}`);
}

async function main() {
    const { push } = parseArgs(process.argv.slice(2));
    step('Clean working tree');
    const revision = cleanTree();
    const image = `${REPOSITORY}:${revision.slice(0, 12)}`;
    console.log(`Releasing ${revision} as ${image}${push ? ' (will push)' : ' (dry run; pass --push to publish)'}`);

    step('Full checks (lint, types, tests, coverage, build, production audit)');
    run('npm', ['run', 'release:prep']);
    step(`Build the ${PLATFORM} image`);
    run('docker', ['build', '--platform', PLATFORM, '--provenance=false', '--build-arg', `REVISION=${revision}`,
        ...proxyBuildArgs(), '--tag', image, '.']);
    step('Container smoke test');
    await smokeImage(image, revision);
    step('Image scan (a fixable high or critical finding stops the release)');
    scanImage(image);

    if (cleanTree() !== revision) throw new Error('HEAD or the working tree changed during the release.');
    if (!push) {
        step('Dry run finished');
        console.log(`Verified ${image}; nothing was pushed. Re-run with -- --push to publish it and print its digest.`);
        return;
    }
    step('Push');
    run('docker', ['push', image]);
    const digest = registryDigest(JSON.parse(capture('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', image])));
    if (!digest) throw new Error('The pushed image has no registry digest.');
    step('Release record');
    console.log(`Released commit ${revision} as ${REPOSITORY}@${digest}`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`\nRelease failed: ${error.message}`);
        process.exit(1);
    });
}

module.exports = { REPOSITORY, parseArgs, proxyBuildArgs, proxyRunArgs, registryDigest };
