const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const stageDir = path.join(projectRoot, '.caxa-stage');
const outputExe = path.join(projectRoot, 'Nextra.exe');

const requiredEntries = [
    'server.js',
    'config.js',
    'lib',
    'dist',
    'node_modules',
];

function copyEntry(relativePath) {
    const src = path.join(projectRoot, relativePath);
    const dest = path.join(stageDir, relativePath);

    if (!fs.existsSync(src)) {
        throw new Error(`Missing required package input: ${relativePath}`);
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
}

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: projectRoot,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });

    if (result.status !== 0) {
        throw new Error(`${command} failed with code ${result.status}`);
    }
}

function findCloudflaredOnPath() {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(lookupCommand, ['cloudflared'], {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: process.platform === 'win32',
    });

    if (result.status !== 0 || !result.stdout) return '';
    const lines = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    return lines[0] || '';
}

function getCloudflaredAssetName() {
    if (process.platform !== 'win32') {
        throw new Error('Automatic cloudflared download is currently implemented for Windows packaging only.');
    }

    switch (process.arch) {
        case 'x64':
            return 'cloudflared-windows-amd64.exe';
        case 'arm64':
            return 'cloudflared-windows-arm64.exe';
        case 'ia32':
            return 'cloudflared-windows-386.exe';
        default:
            throw new Error(`Unsupported Windows architecture for cloudflared download: ${process.arch}`);
    }
}

function downloadFileWithRedirects(url, destinationPath, redirectsLeft = 6) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, { headers: { 'User-Agent': 'nextra-packager' } }, (response) => {
            const code = response.statusCode || 0;
            const location = response.headers.location;

            if ([301, 302, 303, 307, 308].includes(code) && location) {
                response.resume();
                if (redirectsLeft <= 0) {
                    reject(new Error(`Too many redirects while downloading cloudflared from ${url}`));
                    return;
                }
                const nextUrl = new URL(location, url).toString();
                downloadFileWithRedirects(nextUrl, destinationPath, redirectsLeft - 1)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            if (code !== 200) {
                response.resume();
                reject(new Error(`Failed to download cloudflared (${code}) from ${url}`));
                return;
            }

            fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
            const file = fs.createWriteStream(destinationPath);
            response.pipe(file);

            file.on('finish', () => {
                file.close(() => resolve());
            });

            file.on('error', (err) => {
                response.destroy();
                try { fs.unlinkSync(destinationPath); } catch { }
                reject(err);
            });
        });

        request.on('error', (err) => reject(err));
    });
}

function copyCloudflaredToStage(sourcePath, stageCloudflaredPath, stageLibCloudflaredPath, stageBinCloudflaredPath) {
    const sameAsPrimary = path.resolve(sourcePath) === path.resolve(stageCloudflaredPath);
    if (!sameAsPrimary) {
        fs.mkdirSync(path.dirname(stageCloudflaredPath), { recursive: true });
        fs.cpSync(sourcePath, stageCloudflaredPath, { recursive: false });
    }
    fs.mkdirSync(path.dirname(stageLibCloudflaredPath), { recursive: true });
    fs.cpSync(stageCloudflaredPath, stageLibCloudflaredPath, { recursive: false });
    fs.mkdirSync(path.dirname(stageBinCloudflaredPath), { recursive: true });
    fs.cpSync(stageCloudflaredPath, stageBinCloudflaredPath, { recursive: false });
}

async function bundleCloudflared() {
    const bundledName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const stageCloudflaredPath = path.join(stageDir, bundledName);
    const stageLibCloudflaredPath = path.join(stageDir, 'lib', bundledName);
    const stageBinCloudflaredPath = path.join(stageDir, 'node_modules', '.bin', bundledName);
    const allowLocalCloudflared = process.env.ALLOW_LOCAL_CLOUDFLARED === '1';

    const localCandidates = [
        path.join(projectRoot, bundledName),
        path.join(projectRoot, 'cloudflared'),
        path.join(projectRoot, 'cloudflared.exe'),
    ];

    if (allowLocalCloudflared) {
        for (const candidate of localCandidates) {
            if (!fs.existsSync(candidate)) continue;
            copyCloudflaredToStage(candidate, stageCloudflaredPath, stageLibCloudflaredPath, stageBinCloudflaredPath);
            console.log(`Bundled cloudflared from project file: ${path.basename(candidate)}`);
            return;
        }
    } else {
        const localPresent = localCandidates.some((candidate) => fs.existsSync(candidate));
        if (localPresent) {
            console.log('Ignoring local cloudflared binary for security. Set ALLOW_LOCAL_CLOUDFLARED=1 to override.');
        }
    }

    const pathCandidate = findCloudflaredOnPath();
    if (pathCandidate && fs.existsSync(pathCandidate)) {
        copyCloudflaredToStage(pathCandidate, stageCloudflaredPath, stageLibCloudflaredPath, stageBinCloudflaredPath);
        console.log(`Bundled cloudflared from PATH: ${pathCandidate}`);
        return;
    }

    const assetName = getCloudflaredAssetName();
    const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/${assetName}`;
    console.log(`Downloading cloudflared for packaging: ${downloadUrl}`);
    await downloadFileWithRedirects(downloadUrl, stageCloudflaredPath);
    copyCloudflaredToStage(stageCloudflaredPath, stageCloudflaredPath, stageLibCloudflaredPath, stageBinCloudflaredPath);
    console.log('Bundled cloudflared via automatic download.');
}

async function main() {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });

    requiredEntries.forEach(copyEntry);
    await bundleCloudflared();

    run('npx', [
        'caxa',
        '--input',
        stageDir,
        '--output',
        outputExe,
        '--',
        '{{caxa}}/node_modules/.bin/node',
        'server.js',
    ]);

    fs.rmSync(stageDir, { recursive: true, force: true });
    console.log(`Packaged executable: ${outputExe}`);
}

main().catch((err) => {
    console.error(`Packaging failed: ${err.message}`);
    process.exit(1);
});
