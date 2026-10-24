const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');
const cloudflaredManifest = require('./cloudflared-manifest.json');
const ffmpegManifest = require('./ffmpeg-manifest.json');

const projectRoot = path.resolve(__dirname, '..');
const stageDir = path.join(projectRoot, '.caxa-stage');
// macOS carries the architecture in the name so an arm64 and an x64 artifact can
// sit in the same GitHub Release without colliding; Windows keeps the name it has
// always published under.
const outputExe = process.platform === 'win32'
    ? path.join(projectRoot, 'Nextra.exe')
    : path.join(projectRoot, `Nextra-macos-${process.arch}`);
const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const outputSha256 = process.platform === 'win32'
    ? path.join(projectRoot, 'Nextra.exe.sha256')
    : path.join(projectRoot, `Nextra-macos-${process.arch}.sha256`);
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
    'licenses',
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

// Looks a variable up the way Windows does, ignoring case, in a plain copy of
// the environment (only process.env itself is case-insensitive).
function getEnvValue(env, name) {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? env[key] : undefined;
}

// npm sets npm_execpath to its own bin/npm-cli.js for the scripts it runs. Any
// other runner (npx, pnpm, yarn) puts its own entry point there, which cannot
// run `npm ci`, so only npm's CLI is used.
function getNpmCliPath(env) {
    const npmExecpath = String(env.npm_execpath || '');
    if (!path.win32.isAbsolute(npmExecpath)) return '';
    return /^npm-cli\.[cm]?js$/i.test(path.win32.basename(npmExecpath)) ? npmExecpath : '';
}

// caxa's command-line script, from the "bin" field of its package.json. caxa
// exports only its entry module, so its package.json cannot be resolved by
// name; walk up from the entry to the package that calls itself caxa.
function getCaxaBinPath(resolve = require.resolve) {
    let entry;
    try {
        entry = resolve('caxa');
    } catch (err) {
        throw new Error(`caxa is not installed (it is a devDependency; run npm install first): ${err.message}`, { cause: err });
    }

    let dir = path.dirname(entry);
    for (;;) {
        const manifestPath = path.join(dir, 'package.json');
        if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (manifest.name === 'caxa') {
                const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin && manifest.bin.caxa;
                if (!bin) throw new Error(`caxa's package.json names no caxa bin: ${manifestPath}`);
                return path.resolve(dir, bin);
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) throw new Error(`Could not find caxa's package.json above ${entry}`);
        dir = parent;
    }
}

// Inside double quotes cmd.exe leaves spaces, &, |, <, >, ^, ( and ) alone, but
// it still expands %VAR% (and !VAR! when delayed expansion is on), a " ends the
// quoting and a line break ends the command. Such an argument is refused rather
// than escaped.
function quoteForCmd(arg) {
    const value = String(arg);
    if (/["%!\r\n]/.test(value)) {
        throw new Error(`Packaging cannot pass ${JSON.stringify(value)} through cmd.exe: it contains ", %, ! or a line break, which cmd.exe does not leave alone inside double quotes.`);
    }
    // Backslashes right before the closing quote would escape it for the
    // child's own argument parser; doubled, they stay literal backslashes.
    return `"${value.replace(/(\\+)$/, '$1$1')}"`;
}

// A bare command name such as npm stays unquoted: cmd.exe finds it through PATH
// either way, but a batch file started by a quoted bare name gets a wrong %~dp0
// (the current directory instead of its own), and npm.cmd finds npm-cli.js
// through %~dp0. A command given as a path is quoted like any argument.
function commandForCmd(command) {
    return /^[A-Za-z0-9._-]+$/.test(command) ? command : quoteForCmd(command);
}

// How run() starts a command. On Windows npm and npx are .cmd shims, which Node
// will not start without a shell, and with shell: true Node joins the command
// and its arguments into one cmd.exe line without quoting any of them: the caxa
// paths (stage directory, output exe, icon stub in the temp folder) were split
// at spaces and cmd.exe acted on &, |, ^, ( and ) in them. So on Windows npm and
// caxa run as node plus their JavaScript entry point, with no shell at all, and
// any other command goes through cmd.exe as one line in which every argument is
// double-quoted (quoteForCmd). Elsewhere the command is started as given,
// without a shell, as it always was.
function buildPackagerCommand(command, args, options = {}) {
    const platform = options.platform || process.platform;
    if (platform !== 'win32') {
        return { command, args: [...args], shell: false, windowsVerbatimArguments: false };
    }

    const execPath = options.execPath || process.execPath;
    const env = options.env || process.env;
    const npmCli = command === 'npm' ? getNpmCliPath(env) : '';
    if (npmCli) {
        return { command: execPath, args: [npmCli, ...args], shell: false, windowsVerbatimArguments: false };
    }
    if (command === 'npx' && args[0] === 'caxa') {
        const resolveCaxaBin = options.resolveCaxaBin || getCaxaBinPath;
        return { command: execPath, args: [resolveCaxaBin(), ...args.slice(1)], shell: false, windowsVerbatimArguments: false };
    }

    // cmd.exe /s strips the outer quotes and runs the rest as written, the form
    // Node itself uses for shell: true.
    const line = [commandForCmd(command), ...args.map(quoteForCmd)].join(' ');
    return {
        command: getEnvValue(env, 'ComSpec') || 'cmd.exe',
        args: ['/d', '/s', '/c', `"${line}"`],
        shell: false,
        windowsVerbatimArguments: true,
    };
}

function run(command, args, options = {}) {
    const env = {
        ...process.env,
        ...(options.env || {}),
    };
    const invocation = buildPackagerCommand(command, args, { env });
    const result = spawnSync(invocation.command, invocation.args, {
        cwd: options.cwd || projectRoot,
        stdio: 'inherit',
        shell: invocation.shell,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        env,
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

function getCloudflaredAssetName(platform = process.platform, arch = process.arch) {
    if (platform === 'darwin') {
        switch (arch) {
            case 'arm64':
                return 'cloudflared-darwin-arm64.tgz';
            case 'x64':
                return 'cloudflared-darwin-amd64.tgz';
            default:
                throw new Error(`Unsupported macOS architecture for cloudflared download: ${arch}`);
        }
    }

    if (platform !== 'win32') {
        throw new Error('Automatic cloudflared download is currently implemented for Windows and macOS packaging only.');
    }

    switch (arch) {
        case 'x64':
            return 'cloudflared-windows-amd64.exe';
        case 'arm64':
            return 'cloudflared-windows-arm64.exe';
        case 'ia32':
            return 'cloudflared-windows-386.exe';
        default:
            throw new Error(`Unsupported Windows architecture for cloudflared download: ${arch}`);
    }
}

// Production downloads go through https.get only; a plain-http URL, whether given
// or reached through a redirect, is refused before any connection is made.
function httpsOnlyGet(url, requestOptions, onResponse) {
    const { protocol } = new URL(url);
    if (protocol !== 'https:') {
        throw new Error(`Refusing to download over ${protocol.replace(/:$/, '')} (HTTPS only): ${url}`);
    }
    return https.get(url, requestOptions, onResponse);
}

// Downloads `url` to `destinationPath`, following up to `redirectsLeft` redirects.
//
// Every request, including each one after a redirect, gets two bounds:
// - connectTimeoutMs: how long the server may take to answer with response headers;
// - idleTimeoutMs: how long the body may go without a single chunk.
// A stall, a reset, an aborted or prematurely closed response and a file-stream
// error all end the same way: the request, response and file are destroyed, the
// partial file is deleted and the promise rejects, once. `get` is the transport
// (https.get by default; tests inject their own).
function downloadFileWithRedirects(url, destinationPath, redirectsLeft = 6, options = {}) {
    const {
        connectTimeoutMs = 30_000,
        idleTimeoutMs = 60_000,
        get = httpsOnlyGet,
    } = options;

    return new Promise((resolve, reject) => {
        let settled = false;
        let hop = 0; // numbers the requests, so a replaced one (after a redirect) is ignored
        let timer = null;
        let activeRequest = null;
        let activeResponse = null;
        let file = null;

        const clearTimer = () => {
            if (timer) clearTimeout(timer);
            timer = null;
        };
        const armTimer = (ms, message) => {
            clearTimer();
            timer = setTimeout(() => fail(new Error(message)), ms);
        };
        const destroyQuietly = (stream) => {
            try { stream?.destroy(); } catch { }
        };

        const succeed = () => {
            if (settled) return;
            settled = true;
            clearTimer();
            resolve();
        };

        const fail = (err) => {
            if (settled) return;
            settled = true;
            clearTimer();
            destroyQuietly(activeRequest);
            destroyQuietly(activeResponse);
            discardPartialFile(file, destinationPath).then(() => reject(err));
        };

        const fetchUrl = (currentUrl, left) => {
            const thisHop = ++hop;
            const stale = () => settled || thisHop !== hop;
            // Stream and request errors that arrive after the promise settled, or after a
            // redirect replaced this request, still need a listener: an unhandled 'error'
            // event would throw.
            const failIfCurrent = (err) => { if (!stale()) fail(err); };

            armTimer(
                connectTimeoutMs,
                `Timed out: no response from ${currentUrl} within ${connectTimeoutMs} ms`
            );

            let request;
            try {
                request = get(currentUrl, { headers: { 'User-Agent': 'nextra-packager' } }, (response) => {
                    if (stale()) {
                        destroyQuietly(response);
                        return;
                    }
                    clearTimer();
                    activeResponse = response;
                    response.on('error', failIfCurrent);
                    response.on('aborted', () => {
                        failIfCurrent(new Error(`Download from ${currentUrl} was aborted before the whole file arrived`));
                    });

                    const code = response.statusCode || 0;
                    const location = response.headers.location;

                    if ([301, 302, 303, 307, 308].includes(code) && location) {
                        if (left <= 0) {
                            fail(new Error(`Too many redirects while downloading ${currentUrl}`));
                            return;
                        }
                        let nextUrl;
                        try {
                            nextUrl = new URL(location, currentUrl).toString();
                        } catch (err) {
                            fail(err);
                            return;
                        }
                        // The redirect's own body is of no use; drop the connection with it.
                        // Replace this request first, so the 'aborted' and 'close' that
                        // destroying it emits are taken for what they are: stale.
                        hop += 1;
                        destroyQuietly(request);
                        destroyQuietly(response);
                        activeRequest = null;
                        activeResponse = null;
                        fetchUrl(nextUrl, left - 1);
                        return;
                    }

                    if (code !== 200) {
                        fail(new Error(`Failed to download (${code}) from ${currentUrl}`));
                        return;
                    }

                    let ended = false;
                    try {
                        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
                        file = fs.createWriteStream(destinationPath);
                    } catch (err) {
                        fail(err);
                        return;
                    }
                    const resetIdle = () => {
                        if (!stale()) {
                            armTimer(
                                idleTimeoutMs,
                                `Download from ${currentUrl} stalled: no data for ${idleTimeoutMs} ms`
                            );
                        }
                    };

                    file.on('error', failIfCurrent);
                    // A slow disk pauses the response; its drains show the transfer is alive.
                    file.on('drain', resetIdle);
                    file.on('close', () => {
                        if (ended && file.writableFinished && !stale()) succeed();
                    });
                    response.on('data', resetIdle);
                    response.on('end', () => { ended = true; });
                    // pipe() does not end the file when the response closes without 'end', so a
                    // reset connection would otherwise leave the promise pending for ever.
                    response.on('close', () => {
                        if (!ended) {
                            failIfCurrent(new Error(`Connection to ${currentUrl} closed before the whole file arrived`));
                        }
                    });

                    resetIdle();
                    response.pipe(file);
                });
            } catch (err) {
                fail(err);
                return;
            }

            activeRequest = request;
            request.on('error', failIfCurrent);
        };

        fetchUrl(url, redirectsLeft);
    });
}

// Destroys the partial file stream, waits for its handle to close (so the file
// exists and can be deleted, also on Windows), then deletes it. Nothing happens
// if no file was ever opened for this download. A directory at the destination
// is never removed: rmSync without `recursive` refuses it.
function discardPartialFile(file, destinationPath) {
    return new Promise((resolve) => {
        if (!file) {
            resolve();
            return;
        }
        const removeFile = () => {
            try {
                fs.rmSync(destinationPath, { force: true, maxRetries: 5, retryDelay: 50 });
            } catch { }
            resolve();
        };
        if (file.closed) {
            removeFile();
            return;
        }
        file.once('close', removeFile);
        file.destroy();
    });
}

function getFileSha256(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

// The pinned digest, plus the Authenticode signature on Windows. On macOS the
// digest covers the .tgz archive, so a bare Mach-O binary can never pass here.
function verifyCloudflared(filePath, expectedSha256, platform = process.platform) {
    const actualSha256 = getFileSha256(filePath);
    if (actualSha256 !== expectedSha256) {
        return {
            valid: false,
            reason: `SHA-256 mismatch (expected ${expectedSha256}, got ${actualSha256})`,
        };
    }
    if (platform !== 'win32') return { valid: true, reason: '' };

    const escapedPath = filePath.replace(/'/g, "''");
    const signature = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '$ErrorActionPreference = \'Stop\'; '
        + "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; "
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

    const bundledFfmpeg = path.join(stageDir, ffmpegName);
    if (fs.existsSync(bundledFfmpeg)) {
        hashPathRecursive(hash, bundledFfmpeg, ffmpegName);
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

// cloudflared publishes macOS as a gzipped tarball holding a single `cloudflared`
// entry, while Windows publishes a bare .exe. The pinned digest therefore covers
// the archive on macOS, and extraction is the first step that does more than hash
// the downloaded bytes -- so it must never run before that digest has matched.
// bsdtar at /usr/bin/tar ships with macOS; a tar library would be a new dependency.
function extractCloudflaredFromArchive(archivePath, destinationDir) {
    const result = spawnSync('/usr/bin/tar', ['-xzf', archivePath, '-C', destinationDir, 'cloudflared'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.error || result.status !== 0) {
        const detail = result.error?.message || (result.stderr || '').trim() || 'no error output';
        throw new Error(`Failed to extract ${path.basename(archivePath)} (exit ${result.status ?? 'unknown'}; ${detail})`);
    }

    const extractedPath = path.join(destinationDir, 'cloudflared');
    if (!fs.statSync(extractedPath, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Archive ${path.basename(archivePath)} did not contain a cloudflared binary.`);
    }

    fs.chmodSync(extractedPath, 0o755);
    fs.accessSync(extractedPath, fs.constants.X_OK);
    return extractedPath;
}

function isCloudflaredArchiveAsset(assetName) {
    return assetName.endsWith('.tgz');
}

// What to do with one cloudflared candidate (CLOUDFLARED_PATH, a project-root
// file, or the one on PATH). `verified` is whether it passed verifyCloudflared
// against the pinned digest of `assetName`. Pure, so every platform's decision
// can be tested on any host.
//   stage-direct      copy the file as it is (the pinned asset is the bare binary)
//   stage-via-extract the file is the pinned archive: extract it, stage the entry
//   reject            an explicit candidate that cannot be staged: fail loudly
//   skip              an implicit candidate that cannot be staged: log, try the next
// On macOS the pinned asset is the .tgz, so a file is never staged as it is: the
// archive digest says nothing about a bare Mach-O, and a copied archive is not
// an executable.
function decideCloudflaredCandidate({ platform, assetName, verified, explicit }) {
    const unusable = explicit ? 'reject' : 'skip';
    if (!verified) return unusable;
    if (isCloudflaredArchiveAsset(assetName)) return 'stage-via-extract';
    return platform === 'darwin' ? unusable : 'stage-direct';
}

// Stages cloudflared out of the pinned archive. The archive is first copied into
// a private scratch directory and the copy is what gets hashed and extracted, so
// the bytes that matched the digest are the bytes unpacked, and nothing is
// unpacked next to the caller's file. The extracted binary is staged and made
// executable; on any failure the staged copies are removed again, and the scratch
// directory goes either way, so a rejected archive cannot leave a binary behind
// for a later run to pick up.
function stageVerifiedCloudflaredArchive(archivePath, expectedSha256, stagePaths, options = {}) {
    const {
        platform = process.platform,
        description = 'cloudflared archive',
        verify = verifyCloudflared,
        extract = extractCloudflaredFromArchive,
        copy = copyCloudflaredToStage,
        chmod = fs.chmodSync,
    } = options;
    const stagedPaths = [stagePaths.primary, stagePaths.lib, stagePaths.bin];
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-cloudflared-'));
    try {
        // A fixed name: the candidate may itself be called `cloudflared`, which is
        // also the name of the entry extracted from it.
        const snapshotPath = path.join(scratchDir, 'cloudflared-archive.tgz');
        fs.copyFileSync(archivePath, snapshotPath);
        const verification = verify(snapshotPath, expectedSha256, platform);
        if (!verification.valid) {
            throw new Error(`${description} failed pinned verification: ${verification.reason}.`);
        }
        const extractDir = path.join(scratchDir, 'extracted');
        fs.mkdirSync(extractDir);
        const extractedPath = extract(snapshotPath, extractDir);
        copy(extractedPath, stagePaths.primary, stagePaths.lib, stagePaths.bin);
        stagedPaths.forEach((stagedPath) => chmod(stagedPath, 0o755));
    } catch (err) {
        stagedPaths.forEach((stagedPath) => { try { fs.rmSync(stagedPath, { force: true }); } catch { } });
        throw err;
    } finally {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    }
}

// Verifies one candidate and acts on decideCloudflaredCandidate's answer.
// Returns true when cloudflared was staged and false when the candidate was
// skipped; throws for an explicit candidate that cannot be used. `label` names
// the candidate in log lines.
function stageCloudflaredCandidate(candidatePath, options) {
    const {
        explicit,
        label,
        platform = process.platform,
        assetName,
        expectedSha256,
        stagePaths,
        version = cloudflaredManifest.version,
        verify = verifyCloudflared,
        copy = copyCloudflaredToStage,
        log = console.log,
    } = options;
    const verification = verify(candidatePath, expectedSha256, platform);
    const outcome = decideCloudflaredCandidate({ platform, assetName, verified: verification.valid, explicit });
    const archive = isCloudflaredArchiveAsset(assetName);

    switch (outcome) {
        case 'stage-direct':
            copy(candidatePath, stagePaths.primary, stagePaths.lib, stagePaths.bin);
            return true;
        case 'stage-via-extract':
            stageVerifiedCloudflaredArchive(candidatePath, expectedSha256, stagePaths, options);
            return true;
        case 'reject':
            if (archive) {
                throw new Error(`${label} must be the pinned cloudflared ${version} archive ${assetName} on ${platform === 'darwin' ? 'macOS' : platform}, `
                    + `not a bare cloudflared binary or any other file: ${verification.reason}.`);
            }
            throw new Error(`${label} is not the signed, pinned cloudflared ${version} asset: ${verification.reason}.`);
        default:
            log(`Skipping ${label}: it is not the pinned cloudflared ${version} ${archive ? 'archive ' : 'asset '}${assetName} (${verification.reason}).`);
            return false;
    }
}

// Looks for a cloudflared to stage without downloading: CLOUDFLARED_PATH first,
// then project-root files (only with ALLOW_LOCAL_CLOUDFLARED=1), then the one on
// PATH. Returns true when one was staged and false when the verified download
// has to supply it. On macOS every candidate has to be the pinned archive.
function stageLocalCloudflared(options) {
    const {
        env = process.env,
        platform = process.platform,
        root = projectRoot,
        findOnPath = findCloudflaredOnPath,
        log = console.log,
        ...stageOptions
    } = options;
    const bundledName = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const candidateOptions = { ...stageOptions, platform, log };
    const explicitCloudflaredPath = (env.CLOUDFLARED_PATH || '').trim();

    if (explicitCloudflaredPath) {
        if (!fs.existsSync(explicitCloudflaredPath)) {
            throw new Error(`CLOUDFLARED_PATH does not exist: ${explicitCloudflaredPath}`);
        }
        stageCloudflaredCandidate(explicitCloudflaredPath, { ...candidateOptions, explicit: true, label: 'CLOUDFLARED_PATH' });
        log(`Bundled cloudflared from CLOUDFLARED_PATH: ${explicitCloudflaredPath}`);
        return true;
    }

    const localCandidates = [...new Set([
        path.join(root, bundledName),
        path.join(root, 'cloudflared'),
        path.join(root, 'cloudflared.exe'),
    ])];

    if (env.ALLOW_LOCAL_CLOUDFLARED === '1') {
        for (const candidate of localCandidates) {
            if (!fs.existsSync(candidate)) continue;
            const label = `project file ${path.basename(candidate)}`;
            if (!stageCloudflaredCandidate(candidate, { ...candidateOptions, explicit: false, label })) continue;
            log(`Bundled cloudflared from project file: ${path.basename(candidate)}`);
            return true;
        }
    } else {
        const localPresent = localCandidates.some((candidate) => fs.existsSync(candidate));
        if (localPresent) {
            log('Ignoring local cloudflared binary for security. Set ALLOW_LOCAL_CLOUDFLARED=1 to override.');
        }
    }

    const pathCandidate = findOnPath();
    if (pathCandidate && fs.existsSync(pathCandidate)) {
        const label = `cloudflared on PATH (${pathCandidate})`;
        if (stageCloudflaredCandidate(pathCandidate, { ...candidateOptions, explicit: false, label })) {
            log(`Bundled cloudflared from PATH: ${pathCandidate}`);
            return true;
        }
    }

    return false;
}

async function bundleCloudflared() {
    const bundledName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const stagePaths = {
        primary: path.join(stageDir, bundledName),
        lib: path.join(stageDir, 'lib', bundledName),
        bin: path.join(stageDir, 'node_modules', '.bin', bundledName),
    };
    const assetName = getCloudflaredAssetName();
    const expectedSha256 = cloudflaredManifest.assets[assetName];
    if (!expectedSha256) throw new Error(`No pinned cloudflared checksum for ${assetName}.`);

    if (stageLocalCloudflared({ assetName, expectedSha256, stagePaths })) return;

    const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/download/${cloudflaredManifest.version}/${assetName}`;
    console.log(`Downloading cloudflared for packaging: ${downloadUrl}`);

    if (isCloudflaredArchiveAsset(assetName)) {
        // The archive is downloaded into a scratch directory that is removed either
        // way; stageVerifiedCloudflaredArchive then verifies and extracts it.
        const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-cloudflared-download-'));
        try {
            const archivePath = path.join(downloadDir, assetName);
            await downloadFileWithRedirects(downloadUrl, archivePath);
            stageVerifiedCloudflaredArchive(archivePath, expectedSha256, stagePaths, { description: 'Downloaded cloudflared' });
        } finally {
            fs.rmSync(downloadDir, { recursive: true, force: true });
        }
        console.log('Bundled cloudflared via verified download.');
        return;
    }

    await downloadFileWithRedirects(downloadUrl, stagePaths.primary);
    const verification = verifyCloudflared(stagePaths.primary, expectedSha256);
    if (!verification.valid) {
        try { fs.unlinkSync(stagePaths.primary); } catch { }
        throw new Error(`Downloaded cloudflared failed pinned verification: ${verification.reason}.`);
    }
    copyCloudflaredToStage(stagePaths.primary, stagePaths.primary, stagePaths.lib, stagePaths.bin);
    console.log('Bundled cloudflared via verified download.');
}

function getFfmpegAsset(platform = process.platform, arch = process.arch) {
    const asset = ffmpegManifest.assets[`${platform}-${arch}`];
    if (!asset) {
        throw new Error(`No pinned FFmpeg build for ${platform}-${arch}; packaging supports ${Object.keys(ffmpegManifest.assets).join(', ')}.`);
    }
    return asset;
}

// Both upstreams publish FFmpeg as a .zip. bsdtar reads zip archives and ships
// with macOS (/usr/bin/tar) and Windows 10+ (System32\tar.exe), so extraction
// needs no new dependency. Like the cloudflared archive, extraction must never
// run before the pinned archive digest has matched.
function extractFfmpegFromArchive(archivePath, entry, destinationDir) {
    const tar = process.platform === 'win32'
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        : '/usr/bin/tar';
    const result = spawnSync(tar, ['-xf', archivePath, '-C', destinationDir, entry], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    if (result.error || result.status !== 0) {
        const detail = result.error?.message || (result.stderr || '').trim() || 'no error output';
        throw new Error(`Failed to extract ${entry} from ${path.basename(archivePath)} (exit ${result.status ?? 'unknown'}; ${detail})`);
    }

    const extractedPath = path.join(destinationDir, ...entry.split('/'));
    if (!fs.statSync(extractedPath, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Archive ${path.basename(archivePath)} did not contain ${entry}.`);
    }
    return extractedPath;
}

// The FFmpeg archives are large (up to ~115 MB), so a verified download is kept
// in the OS temp directory and reused by later local packaging runs. The cache is
// keyed by the pinned digest and re-verified before every use.
async function bundleFfmpeg() {
    const asset = getFfmpegAsset();
    const cacheDir = path.join(os.tmpdir(), 'nextra-ffmpeg-cache');
    const archivePath = path.join(cacheDir, `${asset.sha256}.zip`);
    const stageFfmpegPath = path.join(stageDir, ffmpegName);

    if (!fs.existsSync(archivePath) || getFileSha256(archivePath) !== asset.sha256) {
        console.log(`Downloading FFmpeg ${ffmpegManifest.version} for packaging: ${asset.url}`);
        const partialPath = `${archivePath}.${process.pid}.partial`;
        try {
            await downloadFileWithRedirects(asset.url, partialPath);
            const actualSha256 = getFileSha256(partialPath);
            if (actualSha256 !== asset.sha256) {
                throw new Error(`Downloaded FFmpeg failed pinned verification: SHA-256 mismatch (expected ${asset.sha256}, got ${actualSha256}).`);
            }
            fs.renameSync(partialPath, archivePath);
        } finally {
            fs.rmSync(partialPath, { force: true });
        }
    }

    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-ffmpeg-'));
    try {
        const extractedPath = extractFfmpegFromArchive(archivePath, asset.entry, scratchDir);
        fs.copyFileSync(extractedPath, stageFfmpegPath);
        fs.chmodSync(stageFfmpegPath, 0o755);
    } finally {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    }
    console.log(`Bundled FFmpeg ${ffmpegManifest.version} (pinned SHA-256 verified).`);
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
        await bundleFfmpeg();
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

if (require.main === module) {
    main().catch((err) => {
        console.error(`Packaging failed: ${err.message}`);
        process.exit(1);
    });
}

module.exports = {
    buildPackagerCommand,
    copyCloudflaredToStage,
    decideCloudflaredCandidate,
    downloadFileWithRedirects,
    getCaxaBinPath,
    getCloudflaredAssetName,
    getFfmpegAsset,
    run,
    stageCloudflaredCandidate,
    stageLocalCloudflared,
    stageVerifiedCloudflaredArchive,
    verifyCloudflared,
};
