const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');
const cloudflaredManifest = require('./cloudflared-manifest.json');

const projectRoot = path.resolve(__dirname, '..');
const stageDir = path.join(projectRoot, '.caxa-stage');
const outputExe = path.join(projectRoot, 'Nextra.exe');
const outputSha256 = path.join(projectRoot, 'Nextra.exe.sha256');
const appIcon = path.join(projectRoot, 'public', 'app.ico');
// Bump when the startup file layout changes; caxa trusts any existing cache for an identifier.
const caxaCacheSchema = 'startup-runtime-preload-v2';

const sourceEntries = [
    'server.js',
    'config.js',
    'package.json',
    'package-lock.json',
    'LICENSE',
    'README.md',
    'SOURCE.md',
    'THIRD_PARTY_NOTICES.md',
    'lib',
    'dist',
];

const buildIdentifierEntries = [
    ...sourceEntries,
    'node_modules',
];

function copyEntry(relativePath) {
    const src = path.join(projectRoot, relativePath);
    const dest = path.join(stageDir, relativePath);

    if (!fs.existsSync(src)) {
        throw new Error(`Missing required package input: ${relativePath}`);
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true, dereference: true });
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd || projectRoot,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: {
            ...process.env,
            ...(options.env || {}),
        },
    });

    if (result.status !== 0) {
        throw new Error(`${command} failed with code ${result.status}`);
    }
}

function installProductionDependencies() {
    run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stageDir });
}

function prepareStageManifest() {
    const manifestPath = path.join(stageDir, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest.devDependencies;
    delete manifest.scripts;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function writeSbom() {
    const result = spawnSync('npm', ['sbom', '--omit=dev', '--sbom-format', 'cyclonedx'], {
        cwd: stageDir,
        encoding: 'utf8',
        shell: process.platform === 'win32',
    });
    if (result.status !== 0 || !result.stdout) {
        throw new Error(`npm sbom failed: ${(result.stderr || '').trim()}`);
    }
    fs.writeFileSync(path.join(stageDir, 'SBOM.cdx.json'), result.stdout, 'utf8');
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

function getFileSha256(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function verifyCloudflared(filePath, expectedSha256) {
    const actualSha256 = getFileSha256(filePath);
    if (actualSha256 !== expectedSha256) {
        return {
            valid: false,
            reason: `SHA-256 mismatch (expected ${expectedSha256}, got ${actualSha256})`,
        };
    }
    if (process.platform !== 'win32') return { valid: true, reason: '' };

    const escapedPath = filePath.replace(/'/g, "''");
    const signature = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '$ErrorActionPreference = \'Stop\'; '
        + `$result = Get-AuthenticodeSignature -LiteralPath '${escapedPath}' -ErrorAction Stop; `
        + "if ($null -eq $result) { throw 'Get-AuthenticodeSignature returned no result.' }; "
        + '[pscustomobject]@{ status = [string]$result.Status; '
        + 'statusMessage = [string]$result.StatusMessage; '
        + 'signerSubject = [string]$result.SignerCertificate.Subject } '
        + '| ConvertTo-Json -Compress',
    ], { encoding: 'utf8', windowsHide: true });
    const stdout = (signature.stdout || '').replace(/^\uFEFF/, '').trim();
    const stderr = (signature.stderr || '').trim();

    if (signature.error || signature.status !== 0) {
        return {
            valid: false,
            reason: `Authenticode query failed (exit ${signature.status ?? 'unknown'}; ${signature.error?.message || stderr || stdout || 'no error output'})`,
        };
    }

    let details;
    try {
        details = JSON.parse(stdout);
    } catch {
        return {
            valid: false,
            reason: `Authenticode query returned invalid JSON: ${JSON.stringify(stdout)}`,
        };
    }

    if (details.status !== 'Valid') {
        return {
            valid: false,
            reason: `Authenticode status ${details.status || 'unknown'} (${details.statusMessage || 'no status message'}; signer ${details.signerSubject || 'unavailable'})`,
        };
    }

    return { valid: true, reason: '' };
}

function hashPathRecursive(hash, fullPath, relativePath) {
    const normalizedRelativePath = relativePath.split(path.sep).join('/');
    const stats = fs.statSync(fullPath);

    if (stats.isDirectory()) {
        hash.update(`dir:${normalizedRelativePath}\n`);
        fs.readdirSync(fullPath)
            .sort((left, right) => left.localeCompare(right))
            .forEach((name) => {
                hashPathRecursive(
                    hash,
                    path.join(fullPath, name),
                    path.join(relativePath, name)
                );
            });
        return;
    }

    hash.update(`file:${normalizedRelativePath}:${stats.size}\n`);
    hash.update(fs.readFileSync(fullPath));
}

function getBuildIdentifier() {
    const hash = crypto.createHash('sha256');
    const identifierInputs = buildIdentifierEntries;

    hash.update(`cache-schema:${caxaCacheSchema}\n`);

    identifierInputs.forEach((relativePath) => {
        const fullPath = path.join(stageDir, relativePath);
        if (!fs.existsSync(fullPath)) return;
        hashPathRecursive(hash, fullPath, relativePath);
    });

    const bundledCloudflared = path.join(stageDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    if (fs.existsSync(bundledCloudflared)) {
        hashPathRecursive(hash, bundledCloudflared, path.basename(bundledCloudflared));
    }

    return `nextra-${hash.digest('hex').slice(0, 12)}`;
}

// Windows refuses to delete or overwrite a running executable, which fails the
// packaging step after every gate has already passed. Renaming a running image
// is allowed, so move the locked file aside and let caxa write a fresh one; the
// already-running process keeps using its extracted copy.
function clearOutputExe() {
    const dir = path.dirname(outputExe);
    const base = path.basename(outputExe);

    for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(`${base}.old-`)) continue;
        try { fs.rmSync(path.join(dir, name), { force: true }); } catch { }
    }

    if (!fs.existsSync(outputExe)) return;

    try {
        fs.rmSync(outputExe, { force: true });
        return;
    } catch (err) {
        if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') throw err;
    }

    const parked = `${outputExe}.old-${Date.now()}`;
    fs.renameSync(outputExe, parked);
    console.log(`${base} was locked by a running process; moved the old build to ${path.basename(parked)}.`);
    console.log('Restart Nextra to pick up the new build.');
}

function writeReleaseChecksum() {
    const checksum = getFileSha256(outputExe);
    const line = `${checksum} *${path.basename(outputExe)}\n`;
    fs.writeFileSync(outputSha256, line, 'utf8');
    console.log(`Wrote checksum: ${outputSha256}`);
}

function getPackageVersion() {
    const releaseVersion = String(process.env.RELEASE_VERSION || '').trim().replace(/^v/, '');
    if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion)) return releaseVersion;
    const packageJsonPath = path.join(projectRoot, 'package.json');
    try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        return packageJson.version || '1.0.0';
    } catch {
        return '1.0.0';
    }
}

function getDefaultCaxaStub() {
    const caxaEntry = require.resolve('caxa');
    return path.resolve(path.dirname(caxaEntry), '..', 'stubs', `stub--${process.platform}--${process.arch}`);
}

async function prepareWindowsCaxaStub() {
    if (process.platform !== 'win32') {
        return '';
    }

    if (!fs.existsSync(appIcon)) {
        throw new Error(`Missing Windows app icon: ${path.relative(projectRoot, appIcon)}`);
    }

    const defaultStub = getDefaultCaxaStub();
    if (!fs.existsSync(defaultStub)) {
        throw new Error(`Missing caxa Windows stub: ${defaultStub}`);
    }

    const iconStub = path.join(os.tmpdir(), `nextra-caxa-stub-${process.pid}.exe`);
    fs.copyFileSync(defaultStub, iconStub);

    const { rcedit } = await import('rcedit');
    const version = getPackageVersion();

    const metadata = {
        icon: appIcon,
        'file-version': version,
        'product-version': version,
        'version-string': {
            FileDescription: 'Nextra',
            InternalName: 'Nextra',
            OriginalFilename: 'Nextra.exe',
            ProductName: 'Nextra',
            CompanyName: 'Nextra',
        },
    };

    await rcedit(iconStub, metadata);
    fs.appendFileSync(iconStub, '\nCAXACAXACAXA\n');
    console.log(`Prepared Windows caxa stub with icon: ${path.relative(projectRoot, appIcon)}`);
    return iconStub;
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
    const explicitCloudflaredPath = (process.env.CLOUDFLARED_PATH || '').trim();
    const assetName = getCloudflaredAssetName();
    const expectedSha256 = cloudflaredManifest.assets[assetName];
    if (!expectedSha256) throw new Error(`No pinned cloudflared checksum for ${assetName}.`);

    if (explicitCloudflaredPath) {
        if (!fs.existsSync(explicitCloudflaredPath)) {
            throw new Error(`CLOUDFLARED_PATH does not exist: ${explicitCloudflaredPath}`);
        }
        const verification = verifyCloudflared(explicitCloudflaredPath, expectedSha256);
        if (!verification.valid) {
            throw new Error(`CLOUDFLARED_PATH is not the signed, pinned cloudflared ${cloudflaredManifest.version} asset: ${verification.reason}.`);
        }
        copyCloudflaredToStage(explicitCloudflaredPath, stageCloudflaredPath, stageLibCloudflaredPath, stageBinCloudflaredPath);
        console.log(`Bundled cloudflared from CLOUDFLARED_PATH: ${explicitCloudflaredPath}`);
        return;
    }

    const localCandidates = [
        path.join(projectRoot, bundledName),
        path.join(projectRoot, 'cloudflared'),
        path.join(projectRoot, 'cloudflared.exe'),
    ];

    if (allowLocalCloudflared) {
        for (const candidate of localCandidates) {
            if (!fs.existsSync(candidate)) continue;
            if (!verifyCloudflared(candidate, expectedSha256).valid) continue;
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
    if (pathCandidate && fs.existsSync(pathCandidate) && verifyCloudflared(pathCandidate, expectedSha256).valid) {
        copyCloudflaredToStage(pathCandidate, stageCloudflaredPath, stageLibCloudflaredPath, stageBinCloudflaredPath);
        console.log(`Bundled cloudflared from PATH: ${pathCandidate}`);
        return;
    }

    const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/download/${cloudflaredManifest.version}/${assetName}`;
    console.log(`Downloading cloudflared for packaging: ${downloadUrl}`);
    await downloadFileWithRedirects(downloadUrl, stageCloudflaredPath);
    const verification = verifyCloudflared(stageCloudflaredPath, expectedSha256);
    if (!verification.valid) {
        try { fs.unlinkSync(stageCloudflaredPath); } catch { }
        throw new Error(`Downloaded cloudflared failed pinned verification: ${verification.reason}.`);
    }
    copyCloudflaredToStage(stageCloudflaredPath, stageCloudflaredPath, stageLibCloudflaredPath, stageBinCloudflaredPath);
    console.log('Bundled cloudflared via verified download.');
}

async function main() {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });
    let iconStub = '';

    try {
        sourceEntries.forEach(copyEntry);
        prepareStageManifest();
        installProductionDependencies();
        writeSbom();
        await bundleCloudflared();
        const buildIdentifier = getBuildIdentifier();
        iconStub = await prepareWindowsCaxaStub();
        clearOutputExe();

        const caxaArgs = [
            'caxa',
            '--input',
            stageDir,
            '--output',
            outputExe,
            '--identifier',
            buildIdentifier,
        ];

        if (iconStub) {
            caxaArgs.push('--stub', iconStub);
        }

        caxaArgs.push(
            '--',
            '{{caxa}}/node_modules/.bin/node',
            '-r',
            '{{caxa}}/lib/startupRuntime.js',
            '{{caxa}}/server.js',
        );

        run('npx', caxaArgs);
        writeReleaseChecksum();

        console.log(`Packaged executable: ${outputExe}`);
    } finally {
        fs.rmSync(stageDir, { recursive: true, force: true });
        if (iconStub) {
            try { fs.rmSync(iconStub, { force: true }); } catch { }
        }
    }
}

main().catch((err) => {
    console.error(`Packaging failed: ${err.message}`);
    process.exit(1);
});
