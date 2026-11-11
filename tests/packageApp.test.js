'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
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
} = require('../scripts/package-app');
const cloudflaredManifest = require('../scripts/cloudflared-manifest.json');

// The platform/arch pairs packaging supports. Each one must resolve to an asset
// the manifest pins, because on macOS the pinned digest is the only check a
// downloaded cloudflared gets -- Authenticode is Windows-only.
const supportedTargets = [
    { platform: 'darwin', arch: 'arm64', asset: 'cloudflared-darwin-arm64.tgz' },
    { platform: 'darwin', arch: 'x64', asset: 'cloudflared-darwin-amd64.tgz' },
    { platform: 'win32', arch: 'x64', asset: 'cloudflared-windows-amd64.exe' },
    { platform: 'win32', arch: 'ia32', asset: 'cloudflared-windows-386.exe' },
];

test('each supported packaging target resolves to its cloudflared asset', () => {
    for (const { platform, arch, asset } of supportedTargets) {
        assert.equal(getCloudflaredAssetName(platform, arch), asset, `${platform}/${arch}`);
    }
});

// Fails loudly when the pinned cloudflared version is bumped and a platform is
// forgotten: without an entry, bundleCloudflared() has nothing to verify against.
test('every resolvable cloudflared asset is pinned in the manifest', () => {
    for (const { platform, arch } of supportedTargets) {
        const asset = getCloudflaredAssetName(platform, arch);
        assert.match(
            cloudflaredManifest.assets[asset] || '',
            /^[0-9a-f]{64}$/,
            `Missing or malformed pinned SHA-256 for ${asset} (${platform}/${arch})`
        );
    }
});

test('an unsupported architecture has no pinned asset and throws', () => {
    assert.throws(() => getCloudflaredAssetName('darwin', 'ppc64'), /Unsupported macOS architecture/);
    assert.throws(() => getCloudflaredAssetName('win32', 'ppc64'), /Unsupported Windows architecture/);
    assert.throws(() => getCloudflaredAssetName('linux', 'x64'), /Windows and macOS packaging only/);
});

// FFmpeg ships only for the two published release targets. Each must pin an
// HTTPS archive, its SHA-256, and the archive member that is the binary, since
// the digest is the only check the downloaded archive gets before extraction.
test('each release target resolves to a pinned FFmpeg archive', () => {
    for (const [platform, arch, binaryName] of [['win32', 'x64', 'ffmpeg.exe'], ['darwin', 'arm64', 'ffmpeg']]) {
        const asset = getFfmpegAsset(platform, arch);
        assert.match(asset.url, /^https:\/\/\S+\.zip$/, `${platform}/${arch} url`);
        assert.match(asset.sha256, /^[0-9a-f]{64}$/, `${platform}/${arch} sha256`);
        assert.equal(asset.entry.split('/').pop(), binaryName, `${platform}/${arch} entry`);
    }
});

test('a target without a pinned FFmpeg archive throws', () => {
    assert.throws(() => getFfmpegAsset('darwin', 'x64'), /No pinned FFmpeg build for darwin-x64/);
    assert.throws(() => getFfmpegAsset('linux', 'x64'), /No pinned FFmpeg build for linux-x64/);
});

// ---------------------------------------------------------------------------
// downloadFileWithRedirects
//
// The real transport is HTTPS-only, so these tests inject `http.get` (or a fake
// request) through the `get` option and talk to a local server. Timeouts are a
// few hundred milliseconds. Every failure case also asserts that nothing is left
// at the destination: a half-written file must never look like a download.
// ---------------------------------------------------------------------------

const fastTimeouts = { connectTimeoutMs: 300, idleTimeoutMs: 300 };
// A rejection must come well inside this; a download that never settles is the defect.
const hangLimitMs = 4000;
const testTimeoutMs = 15000;

async function withTempDir(run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-download-test-'));
    try {
        return await run(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function withServer(handler, run) {
    const sockets = new Set();
    const server = http.createServer(handler);
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        return await run(base, sockets);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
    }
}

async function waitFor(condition, limitMs = 2000) {
    const deadline = Date.now() + limitMs;
    while (!condition()) {
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return true;
}

// Resolves to { resolved: true } or { error }, or { hung: true } when the promise
// is still pending after the limit.
async function settleWithin(promise, limitMs = hangLimitMs) {
    let timer;
    const outcome = await Promise.race([
        promise.then(() => ({ resolved: true }), (error) => ({ error })),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ hung: true }), limitMs); }),
    ]);
    clearTimeout(timer);
    return outcome;
}

function download(url, destination, options = {}, redirectsLeft = 6) {
    return downloadFileWithRedirects(url, destination, redirectsLeft, { get: http.get, ...options });
}

async function assertRejects(promise, pattern) {
    const outcome = await settleWithin(promise);
    assert.ok(!outcome.hung, `the download should reject, but it was still pending after ${hangLimitMs} ms`);
    assert.ok(!outcome.resolved, 'the download should reject, but it resolved');
    assert.match(outcome.error.message, pattern);
}

// A stand-in for http.get that hands the test the request and a way to answer it.
function fakeGet(onRequest) {
    return (url, requestOptions, onResponse) => {
        const request = new EventEmitter();
        request.destroyed = false;
        request.destroy = () => { request.destroyed = true; };
        const respond = (statusCode = 200, headers = {}) => {
            const response = new PassThrough();
            response.statusCode = statusCode;
            response.headers = headers;
            onResponse(response);
            return response;
        };
        setImmediate(() => onRequest({ request, respond }));
        return request;
    };
}

test('downloadFileWithRedirects saves a 200 response in full', { timeout: testTimeoutMs }, async () => {
    const body = Buffer.alloc(300 * 1024, 'nextra');
    await withTempDir(async (dir) => {
        await withServer((req, res) => {
            res.writeHead(200, { 'Content-Length': body.length });
            res.end(body);
        }, async (base) => {
            const destination = path.join(dir, 'nested', 'file.bin');
            const outcome = await settleWithin(download(`${base}/file`, destination, fastTimeouts));
            assert.ok(outcome.resolved, `the download should resolve: ${outcome.hung ? 'still pending' : outcome.error}`);
            assert.ok(fs.readFileSync(destination).equals(body), 'the saved file should equal the served body');
        });
    });
});

test('downloadFileWithRedirects follows a redirect to the complete file', { timeout: testTimeoutMs }, async () => {
    const body = Buffer.alloc(100 * 1024, 'redirected');
    await withTempDir(async (dir) => {
        const seen = [];
        await withServer((req, res) => {
            seen.push(`${req.url} ${req.headers['user-agent']}`);
            if (req.url === '/start') {
                res.writeHead(302, { Location: '/middle' });
                res.end();
            } else if (req.url === '/middle') {
                res.writeHead(307, { Location: `http://${req.headers.host}/final` });
                res.end();
            } else {
                res.writeHead(200, { 'Content-Length': body.length });
                res.end(body);
            }
        }, async (base) => {
            const destination = path.join(dir, 'file.bin');
            const outcome = await settleWithin(download(`${base}/start`, destination, fastTimeouts));
            assert.ok(outcome.resolved, `the download should resolve: ${outcome.hung ? 'still pending' : outcome.error}`);
            assert.ok(fs.readFileSync(destination).equals(body));
            assert.deepEqual(seen, [
                '/start nextra-packager',
                '/middle nextra-packager',
                '/final nextra-packager',
            ]);
        });
    });
});

test('downloadFileWithRedirects gives up after the redirect limit', { timeout: testTimeoutMs }, async () => {
    await withTempDir(async (dir) => {
        await withServer((req, res) => {
            res.writeHead(302, { Location: '/again' });
            res.end();
        }, async (base) => {
            const destination = path.join(dir, 'file.bin');
            await assertRejects(download(`${base}/start`, destination, fastTimeouts, 2), /Too many redirects/);
            assert.equal(fs.existsSync(destination), false);
        });
    });
});

test('downloadFileWithRedirects rejects a non-200 answer and leaves no file', { timeout: testTimeoutMs }, async () => {
    await withTempDir(async (dir) => {
        await withServer((req, res) => {
            res.writeHead(404);
            res.end('not here');
        }, async (base) => {
            const destination = path.join(dir, 'file.bin');
            await assertRejects(download(`${base}/missing`, destination, fastTimeouts), /Failed to download \(404\)/);
            assert.equal(fs.existsSync(destination), false);
        });
    });
});

test('downloadFileWithRedirects rejects within connectTimeoutMs when the server never sends headers', { timeout: testTimeoutMs }, async () => {
    await withTempDir(async (dir) => {
        await withServer(() => { /* accept the request, never answer */ }, async (base, sockets) => {
            const destination = path.join(dir, 'file.bin');
            const startedAt = Date.now();
            await assertRejects(download(`${base}/silent`, destination, fastTimeouts), /no response|timed out/i);
            assert.ok(Date.now() - startedAt < 3000, 'it should reject about connectTimeoutMs after the request');
            assert.equal(fs.existsSync(destination), false);
            assert.ok(await waitFor(() => sockets.size === 0), 'the stalled connection should have been closed');
        });
    });
});

test('downloadFileWithRedirects applies the connect timeout to the hop after a redirect', { timeout: testTimeoutMs }, async () => {
    await withTempDir(async (dir) => {
        await withServer((req, res) => {
            if (req.url === '/start') {
                res.writeHead(302, { Location: '/silent' });
                res.end();
            }
            // /silent: never answered
        }, async (base) => {
            const destination = path.join(dir, 'file.bin');
            await assertRejects(download(`${base}/start`, destination, fastTimeouts), /no response|timed out/i);
            assert.equal(fs.existsSync(destination), false);
        });
    });
});

test('downloadFileWithRedirects rejects within idleTimeoutMs when the body stalls and removes the partial file', { timeout: testTimeoutMs }, async () => {
    await withTempDir(async (dir) => {
        await withServer((req, res) => {
            res.writeHead(200, { 'Content-Length': 1000000 });
            res.write(Buffer.alloc(4096, 1));
            // never sends the rest
        }, async (base, sockets) => {
            const destination = path.join(dir, 'file.bin');
            const startedAt = Date.now();
            await assertRejects(download(`${base}/stall`, destination, fastTimeouts), /stalled|idle|no data/i);
            assert.ok(Date.now() - startedAt < 3000, 'it should reject about idleTimeoutMs after the last data');
            assert.equal(fs.existsSync(destination), false, 'the partial file should be gone when the promise rejects');
            assert.ok(await waitFor(() => sockets.size === 0), 'the stalled connection should have been closed');
        });
    });
});

test('downloadFileWithRedirects resets the idle timer on every chunk', { timeout: testTimeoutMs }, async () => {
    // Slower in total than idleTimeoutMs, but never silent for that long.
    const chunk = Buffer.alloc(1024, 'x');
    const chunks = 6;
    await withTempDir(async (dir) => {
        await withServer((req, res) => {
            res.writeHead(200, { 'Content-Length': chunk.length * chunks });
            let sent = 0;
            const timer = setInterval(() => {
                res.write(chunk);
                sent += 1;
                if (sent === chunks) {
                    clearInterval(timer);
                    res.end();
                }
            }, 120);
            res.on('close', () => clearInterval(timer));
        }, async (base) => {
            const destination = path.join(dir, 'file.bin');
            const options = { connectTimeoutMs: 1000, idleTimeoutMs: 500 };
            const outcome = await settleWithin(download(`${base}/slow`, destination, options));
            assert.ok(outcome.resolved, `a steady slow download should resolve: ${outcome.hung ? 'still pending' : outcome.error}`);
            assert.equal(fs.statSync(destination).size, chunk.length * chunks);
        });
    });
});

for (const [label, headers] of [
    ['with a Content-Length', { 'Content-Length': 1000000 }],
    ['chunked', {}],
]) {
    test(`downloadFileWithRedirects rejects when the server destroys the socket mid-body (${label})`, { timeout: testTimeoutMs }, async () => {
        await withTempDir(async (dir) => {
            await withServer((req, res) => {
                res.writeHead(200, headers);
                res.write(Buffer.alloc(4096, 1), () => setTimeout(() => res.socket.destroy(), 30));
            }, async (base) => {
                const destination = path.join(dir, 'file.bin');
                await assertRejects(download(`${base}/reset`, destination, fastTimeouts), /./);
                assert.equal(fs.existsSync(destination), false);
            });
        });
    });
}

test('downloadFileWithRedirects rejects when the server ends the connection before the whole body arrived', { timeout: testTimeoutMs }, async () => {
    await withTempDir(async (dir) => {
        await withServer((req, res) => {
            res.writeHead(200, { 'Content-Length': 1000000 });
            res.write(Buffer.alloc(4096, 1), () => setTimeout(() => res.socket.end(), 30));
        }, async (base) => {
            const destination = path.join(dir, 'file.bin');
            await assertRejects(download(`${base}/short`, destination, fastTimeouts), /./);
            assert.equal(fs.existsSync(destination), false);
        });
    });
});

test('downloadFileWithRedirects rejects, instead of throwing, when the destination directory cannot be made', { timeout: testTimeoutMs }, async () => {
    await withTempDir(async (dir) => {
        const blocker = path.join(dir, 'a-file');
        fs.writeFileSync(blocker, 'x');
        await withServer((req, res) => {
            res.writeHead(200, { 'Content-Length': 4 });
            res.end('data');
        }, async (base) => {
            const destination = path.join(blocker, 'sub', 'file.bin');
            await assertRejects(download(`${base}/file`, destination, fastTimeouts), /./);
            assert.equal(fs.existsSync(destination), false);
        });
    });
});

test('downloadFileWithRedirects rejects on a file-stream error and does not delete a directory at the destination', { timeout: testTimeoutMs }, async () => {
    await withTempDir(async (dir) => {
        await withServer((req, res) => {
            res.writeHead(200, { 'Content-Length': 4 });
            res.end('data');
        }, async (base) => {
            const destination = path.join(dir, 'a-directory');
            fs.mkdirSync(destination);
            await assertRejects(download(`${base}/file`, destination, fastTimeouts), /./);
            assert.ok(fs.statSync(destination).isDirectory(), 'whatever sat at the destination and could not be written must stay');
        });
    });
});

test('downloadFileWithRedirects refuses plain http with the default transport', { timeout: testTimeoutMs }, async () => {
    await withTempDir(async (dir) => {
        let requests = 0;
        await withServer((req, res) => {
            requests += 1;
            res.writeHead(200);
            res.end('data');
        }, async (base) => {
            const destination = path.join(dir, 'file.bin');
            await assertRejects(downloadFileWithRedirects(`${base}/file`, destination), /https/i);
            assert.equal(requests, 0, 'no request may reach a plain-http server');
            assert.equal(fs.existsSync(destination), false);
        });
    });
});

test('downloadFileWithRedirects rejects, instead of throwing, on an unusable redirect target', { timeout: testTimeoutMs }, async () => {
    await withTempDir(async (dir) => {
        const get = fakeGet(({ respond }) => respond(302, { location: 'http://[bad' }));
        await assertRejects(
            downloadFileWithRedirects('http://example.test/file', path.join(dir, 'file.bin'), 6, { get, ...fastTimeouts }),
            /./
        );
    });
});

test('downloadFileWithRedirects rejects when the response stream errors, once, and removes the partial file', { timeout: testTimeoutMs }, async () => {
    await withTempDir(async (dir) => {
        const destination = path.join(dir, 'file.bin');
        let fakeRequest;
        const get = fakeGet(({ request, respond }) => {
            fakeRequest = request;
            const response = respond(200, {});
            response.write(Buffer.alloc(1024, 1));
            setTimeout(() => response.destroy(new Error('connection reset by peer')), 30);
        });
        await assertRejects(
            downloadFileWithRedirects('http://example.test/file', destination, 6, { get, ...fastTimeouts }),
            /connection reset by peer/
        );
        assert.equal(fs.existsSync(destination), false);
        assert.equal(fakeRequest.destroyed, true, 'the request should be destroyed');
        // A late error from the abandoned request must not throw: the listener stays attached.
        fakeRequest.emit('error', new Error('late'));
    });
});

test('downloadFileWithRedirects rejects when the response closes without ending', { timeout: testTimeoutMs }, async () => {
    await withTempDir(async (dir) => {
        const destination = path.join(dir, 'file.bin');
        const get = fakeGet(({ respond }) => {
            const response = respond(200, {});
            response.write(Buffer.alloc(1024, 1));
            // Closed with no 'end' and no 'error': pipe() leaves the file stream open for ever.
            setTimeout(() => response.destroy(), 30);
        });
        await assertRejects(
            downloadFileWithRedirects('http://example.test/file', destination, 6, { get, ...fastTimeouts }),
            /closed|ended|before/i
        );
        assert.equal(fs.existsSync(destination), false);
    });
});

test('downloadFileWithRedirects rejects when the response is aborted', { timeout: testTimeoutMs }, async () => {
    await withTempDir(async (dir) => {
        const destination = path.join(dir, 'file.bin');
        const get = fakeGet(({ respond }) => {
            const response = respond(200, {});
            response.write(Buffer.alloc(1024, 1));
            setTimeout(() => response.emit('aborted'), 30);
        });
        await assertRejects(
            downloadFileWithRedirects('http://example.test/file', destination, 6, { get, ...fastTimeouts }),
            /abort/i
        );
        assert.equal(fs.existsSync(destination), false);
    });
});

test('downloadFileWithRedirects rejects when the request errors before any response', { timeout: testTimeoutMs }, async () => {
    await withTempDir(async (dir) => {
        const destination = path.join(dir, 'file.bin');
        const get = fakeGet(({ request }) => request.emit('error', new Error('getaddrinfo ENOTFOUND')));
        await assertRejects(
            downloadFileWithRedirects('http://example.test/file', destination, 6, { get, ...fastTimeouts }),
            /ENOTFOUND/
        );
        assert.equal(fs.existsSync(destination), false);
    });
});

test('downloadFileWithRedirects rejects when the transport throws while starting the request', { timeout: testTimeoutMs }, async () => {
    await withTempDir(async (dir) => {
        const get = () => { throw new Error('transport refused'); };
        await assertRejects(
            downloadFileWithRedirects('http://example.test/file', path.join(dir, 'file.bin'), 6, { get }),
            /transport refused/
        );
    });
});

// ---------------------------------------------------------------------------
// cloudflared candidates: CLOUDFLARED_PATH, project-root files and PATH
//
// On macOS the pinned digest covers the .tgz archive, not the Mach-O inside it.
// A candidate is therefore either that archive (verified, then extracted) or
// nothing: a bare binary can never match the digest and must never be copied to
// the stage as if it had. These tests run on any host by passing the platform
// in and replacing the extractor (/usr/bin/tar exists only on macOS/Linux).
// ---------------------------------------------------------------------------

const darwinAssets = ['cloudflared-darwin-arm64.tgz', 'cloudflared-darwin-amd64.tgz'];
const windowsAsset = 'cloudflared-windows-amd64.exe';
const archiveBytes = Buffer.from('pretend this is the pinned cloudflared .tgz archive');
const bareBinaryBytes = Buffer.from('pretend this is a bare cloudflared Mach-O binary');
const extractedMarker = 'EXTRACTED cloudflared entry';
const sha256Of = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const archiveSha256 = sha256Of(archiveBytes);
const windowsExeBytes = Buffer.from('pretend this is the signed cloudflared.exe');
const windowsExeSha256 = sha256Of(windowsExeBytes);
const alwaysValid = () => ({ valid: true, reason: '' });

function makeStagePaths(dir) {
    const stage = path.join(dir, 'stage');
    return {
        primary: path.join(stage, 'cloudflared'),
        lib: path.join(stage, 'lib', 'cloudflared'),
        bin: path.join(stage, 'node_modules', '.bin', 'cloudflared'),
    };
}

function stagedFiles(stagePaths) {
    return Object.values(stagePaths).filter((stagedPath) => fs.existsSync(stagedPath));
}

// Real copy, fake extractor/chmod/log, all recorded so a test can say exactly
// which bytes were staged, from where, and what was extracted.
function instrumentedDeps() {
    const calls = { copy: [], extract: [], chmod: [], log: [] };
    const deps = {
        log: (line) => { calls.log.push(line); },
        copy: (source, ...targets) => {
            calls.copy.push(source);
            copyCloudflaredToStage(source, ...targets);
        },
        extract: (archivePath, destinationDir) => {
            calls.extract.push({ archivePath, destinationDir, bytes: fs.readFileSync(archivePath) });
            const extractedPath = path.join(destinationDir, 'cloudflared');
            fs.writeFileSync(extractedPath, extractedMarker);
            return extractedPath;
        },
        chmod: (target, mode) => { calls.chmod.push({ target, mode }); },
    };
    return { calls, deps };
}

function assertStagedFromExtraction(stagePaths, calls) {
    assert.equal(stagedFiles(stagePaths).length, 3, 'all three stage locations should be filled');
    for (const stagedPath of Object.values(stagePaths)) {
        assert.equal(fs.readFileSync(stagedPath, 'utf8'), extractedMarker, `${stagedPath} should hold the extracted entry`);
    }
    assert.deepEqual(
        calls.chmod.map(({ mode }) => mode),
        [0o755, 0o755, 0o755],
        'each staged copy should be made executable (0755)'
    );
    assert.deepEqual(calls.chmod.map(({ target }) => target).sort(), Object.values(stagePaths).sort());
}

test('decideCloudflaredCandidate stages a verified macOS archive only through extraction', () => {
    for (const assetName of darwinAssets) {
        for (const explicit of [true, false]) {
            assert.equal(
                decideCloudflaredCandidate({ platform: 'darwin', assetName, verified: true, explicit }),
                'stage-via-extract',
                `${assetName} explicit=${explicit}`
            );
        }
    }
});

test('decideCloudflaredCandidate rejects an explicit and skips an implicit macOS candidate that is not the archive', () => {
    for (const assetName of darwinAssets) {
        assert.equal(decideCloudflaredCandidate({ platform: 'darwin', assetName, verified: false, explicit: true }), 'reject');
        assert.equal(decideCloudflaredCandidate({ platform: 'darwin', assetName, verified: false, explicit: false }), 'skip');
    }
});

test('decideCloudflaredCandidate never stages a macOS candidate as-is, whatever the asset', () => {
    for (const assetName of [...darwinAssets, windowsAsset]) {
        for (const verified of [true, false]) {
            for (const explicit of [true, false]) {
                const outcome = decideCloudflaredCandidate({ platform: 'darwin', assetName, verified, explicit });
                assert.notEqual(outcome, 'stage-direct', `${assetName} verified=${verified} explicit=${explicit}`);
            }
        }
    }
});

test('decideCloudflaredCandidate keeps the Windows outcomes for bare .exe candidates', () => {
    for (const explicit of [true, false]) {
        assert.equal(decideCloudflaredCandidate({ platform: 'win32', assetName: windowsAsset, verified: true, explicit }), 'stage-direct');
    }
    assert.equal(decideCloudflaredCandidate({ platform: 'win32', assetName: windowsAsset, verified: false, explicit: true }), 'reject');
    assert.equal(decideCloudflaredCandidate({ platform: 'win32', assetName: windowsAsset, verified: false, explicit: false }), 'skip');
});

test('stageVerifiedCloudflaredArchive verifies a snapshot of the archive, extracts that, and stages the extracted entry', async () => {
    await withTempDir(async (dir) => {
        const candidate = path.join(dir, 'cloudflared-darwin-arm64.tgz');
        fs.writeFileSync(candidate, archiveBytes);
        const stagePaths = makeStagePaths(dir);
        const { calls, deps } = instrumentedDeps();

        stageVerifiedCloudflaredArchive(candidate, archiveSha256, stagePaths, { platform: 'darwin', ...deps });

        assert.equal(calls.extract.length, 1);
        const [{ archivePath, destinationDir, bytes }] = calls.extract;
        assert.ok(bytes.equals(archiveBytes), 'the extractor should be handed the verified bytes');
        assert.notEqual(path.resolve(archivePath), path.resolve(candidate), 'extraction must not read the caller\'s file');
        assert.notEqual(path.dirname(path.resolve(archivePath)), path.dirname(path.resolve(candidate)));
        assert.ok(!path.resolve(destinationDir).startsWith(path.resolve(dir)), 'nothing is extracted next to the candidate');
        assert.equal(calls.copy.length, 1);
        assert.ok(!calls.copy.includes(candidate), 'the archive itself is never copied to the stage');
        assertStagedFromExtraction(stagePaths, calls);
        assert.equal(fs.existsSync(path.dirname(archivePath)), false, 'the scratch directory should be removed');
        assert.ok(fs.readFileSync(candidate).equals(archiveBytes), 'the candidate file is left alone');
    });
});

test('stageVerifiedCloudflaredArchive does not extract or stage anything whose digest does not match', async () => {
    await withTempDir(async (dir) => {
        const candidate = path.join(dir, 'cloudflared');
        fs.writeFileSync(candidate, bareBinaryBytes);
        const stagePaths = makeStagePaths(dir);
        const { calls, deps } = instrumentedDeps();

        assert.throws(
            () => stageVerifiedCloudflaredArchive(candidate, archiveSha256, stagePaths, { platform: 'darwin', ...deps }),
            /failed pinned verification: SHA-256 mismatch/
        );
        assert.equal(calls.extract.length, 0, 'an unverified archive must never be extracted');
        assert.equal(calls.copy.length, 0);
        assert.deepEqual(stagedFiles(stagePaths), []);
    });
});

test('stageVerifiedCloudflaredArchive extracts the bytes it verified even if the file changes afterwards', async () => {
    await withTempDir(async (dir) => {
        const candidate = path.join(dir, 'cloudflared-darwin-arm64.tgz');
        fs.writeFileSync(candidate, archiveBytes);
        const { calls, deps } = instrumentedDeps();
        const swapAfterVerify = (filePath, expectedSha256, platform) => {
            const verification = verifyCloudflared(filePath, expectedSha256, platform);
            fs.writeFileSync(candidate, bareBinaryBytes);
            return verification;
        };

        stageVerifiedCloudflaredArchive(candidate, archiveSha256, makeStagePaths(dir), {
            platform: 'darwin', ...deps, verify: swapAfterVerify,
        });

        assert.ok(calls.extract[0].bytes.equals(archiveBytes), 'the extractor must see the verified bytes, not the swapped ones');
    });
});

test('stageVerifiedCloudflaredArchive works when the candidate is itself named cloudflared', async () => {
    await withTempDir(async (dir) => {
        const candidate = path.join(dir, 'cloudflared');
        fs.writeFileSync(candidate, archiveBytes);
        const stagePaths = makeStagePaths(dir);
        const { calls, deps } = instrumentedDeps();

        stageVerifiedCloudflaredArchive(candidate, archiveSha256, stagePaths, { platform: 'darwin', ...deps });

        assertStagedFromExtraction(stagePaths, calls);
    });
});

test('stageVerifiedCloudflaredArchive removes everything it staged when a later step fails', async () => {
    await withTempDir(async (dir) => {
        const candidate = path.join(dir, 'cloudflared-darwin-arm64.tgz');
        fs.writeFileSync(candidate, archiveBytes);
        const stagePaths = makeStagePaths(dir);
        const { calls, deps } = instrumentedDeps();
        const failingChmod = () => { throw new Error('chmod refused'); };

        assert.throws(
            () => stageVerifiedCloudflaredArchive(candidate, archiveSha256, stagePaths, {
                platform: 'darwin', ...deps, chmod: failingChmod,
            }),
            /chmod refused/
        );
        assert.equal(calls.copy.length, 1, 'the copy had happened before the failure');
        assert.deepEqual(stagedFiles(stagePaths), [], 'a half-staged cloudflared must not be left behind');
        assert.equal(fs.existsSync(path.dirname(calls.extract[0].archivePath)), false, 'the scratch directory should be removed');
    });
});

function stageOptions(dir, overrides = {}) {
    return {
        platform: 'darwin',
        assetName: 'cloudflared-darwin-arm64.tgz',
        expectedSha256: archiveSha256,
        stagePaths: makeStagePaths(dir),
        explicit: true,
        label: 'CLOUDFLARED_PATH',
        ...overrides,
    };
}

test('on macOS a candidate that is the pinned archive is staged only by extracting it', async () => {
    for (const explicit of [true, false]) {
        await withTempDir(async (dir) => {
            const candidate = path.join(dir, 'candidate.tgz');
            fs.writeFileSync(candidate, archiveBytes);
            const options = stageOptions(dir, { explicit });
            const { calls, deps } = instrumentedDeps();

            assert.equal(stageCloudflaredCandidate(candidate, { ...options, ...deps }), true);

            assert.equal(calls.extract.length, 1, `explicit=${explicit}`);
            assert.ok(!calls.copy.includes(candidate), 'the candidate path must never be a copy source');
            assertStagedFromExtraction(options.stagePaths, calls);
        });
    }
});

test('on macOS an explicit candidate that is not the archive is rejected with the reason and never staged', async () => {
    await withTempDir(async (dir) => {
        const candidate = path.join(dir, 'cloudflared');
        fs.writeFileSync(candidate, bareBinaryBytes);
        const options = stageOptions(dir, { explicit: true });
        const { calls, deps } = instrumentedDeps();

        assert.throws(
            () => stageCloudflaredCandidate(candidate, { ...options, ...deps }),
            (error) => {
                assert.match(error.message, /^CLOUDFLARED_PATH must be the pinned cloudflared \S+ archive cloudflared-darwin-arm64\.tgz/);
                assert.match(error.message, /macOS/);
                assert.match(error.message, /bare .*binary/);
                assert.match(error.message, /SHA-256 mismatch/);
                return true;
            }
        );
        assert.deepEqual(calls.copy, []);
        assert.deepEqual(calls.extract, []);
        assert.deepEqual(stagedFiles(options.stagePaths), []);
    });
});

test('on macOS an implicit candidate that is not the archive is skipped with a log line and never staged', async () => {
    await withTempDir(async (dir) => {
        const candidate = path.join(dir, 'cloudflared');
        fs.writeFileSync(candidate, bareBinaryBytes);
        const options = stageOptions(dir, { explicit: false, label: 'cloudflared on PATH' });
        const { calls, deps } = instrumentedDeps();

        assert.equal(stageCloudflaredCandidate(candidate, { ...options, ...deps }), false);

        assert.equal(calls.log.length, 1);
        assert.match(calls.log[0], /Skipping cloudflared on PATH/);
        assert.match(calls.log[0], /cloudflared-darwin-arm64\.tgz/);
        assert.deepEqual(calls.copy, []);
        assert.deepEqual(calls.extract, []);
        assert.deepEqual(stagedFiles(options.stagePaths), []);
    });
});

test('on Windows a verified bare .exe candidate is still copied straight to the stage', async () => {
    await withTempDir(async (dir) => {
        const candidate = path.join(dir, 'cloudflared.exe');
        fs.writeFileSync(candidate, windowsExeBytes);
        const options = stageOptions(dir, { platform: 'win32', assetName: windowsAsset, expectedSha256: windowsExeSha256 });
        const { calls, deps } = instrumentedDeps();

        assert.equal(stageCloudflaredCandidate(candidate, { ...options, ...deps, verify: alwaysValid }), true);

        assert.deepEqual(calls.copy, [candidate]);
        assert.deepEqual(calls.extract, []);
        assert.deepEqual(calls.chmod, [], 'Windows staging has never chmodded');
        for (const stagedPath of Object.values(options.stagePaths)) {
            assert.ok(fs.readFileSync(stagedPath).equals(windowsExeBytes));
        }
    });
});

test('on Windows an unverified candidate keeps the old outcomes: explicit throws the old message, implicit is skipped', async () => {
    await withTempDir(async (dir) => {
        const candidate = path.join(dir, 'cloudflared.exe');
        fs.writeFileSync(candidate, bareBinaryBytes);
        const base = stageOptions(dir, { platform: 'win32', assetName: windowsAsset, expectedSha256: windowsExeSha256 });
        const { calls, deps } = instrumentedDeps();

        assert.throws(
            () => stageCloudflaredCandidate(candidate, { ...base, ...deps, explicit: true }),
            /^Error: CLOUDFLARED_PATH is not the signed, pinned cloudflared \S+ asset: SHA-256 mismatch \(expected \w+, got \w+\)\.$/
        );
        assert.equal(stageCloudflaredCandidate(candidate, { ...base, ...deps, explicit: false, label: 'PATH' }), false);
        assert.deepEqual(calls.copy, []);
        assert.deepEqual(stagedFiles(base.stagePaths), []);
    });
});

// The candidate lookup as bundleCloudflared runs it: CLOUDFLARED_PATH first, then
// project-root files (only with ALLOW_LOCAL_CLOUDFLARED=1), then PATH. It returns
// false when nothing staged, which is where the verified download takes over.
function localOptions(dir, overrides = {}) {
    const root = path.join(dir, 'project');
    fs.mkdirSync(root, { recursive: true });
    return {
        platform: 'darwin',
        assetName: 'cloudflared-darwin-arm64.tgz',
        expectedSha256: archiveSha256,
        stagePaths: makeStagePaths(dir),
        env: {},
        root,
        findOnPath: () => '',
        ...overrides,
    };
}

test('on macOS CLOUDFLARED_PATH set to the pinned archive is extracted and staged executable', async () => {
    await withTempDir(async (dir) => {
        const archive = path.join(dir, 'cloudflared-darwin-arm64.tgz');
        fs.writeFileSync(archive, archiveBytes);
        const options = localOptions(dir, { env: { CLOUDFLARED_PATH: archive } });
        const { calls, deps } = instrumentedDeps();

        assert.equal(stageLocalCloudflared({ ...options, ...deps }), true);

        assert.equal(calls.extract.length, 1);
        assert.ok(!calls.copy.includes(archive));
        assertStagedFromExtraction(options.stagePaths, calls);
        assert.match(calls.log.join('\n'), new RegExp(`Bundled cloudflared from CLOUDFLARED_PATH: ${archive.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
    });
});

test('on macOS CLOUDFLARED_PATH set to a bare binary fails and nothing is staged', async () => {
    await withTempDir(async (dir) => {
        const binary = path.join(dir, 'cloudflared');
        fs.writeFileSync(binary, bareBinaryBytes);
        const options = localOptions(dir, { env: { CLOUDFLARED_PATH: binary } });
        const { calls, deps } = instrumentedDeps();

        assert.throws(() => stageLocalCloudflared({ ...options, ...deps }), /cloudflared-darwin-arm64\.tgz on macOS/);
        assert.deepEqual(calls.copy, []);
        assert.deepEqual(calls.extract, []);
        assert.deepEqual(stagedFiles(options.stagePaths), []);
    });
});

test('CLOUDFLARED_PATH that does not exist still fails with the missing path', async () => {
    await withTempDir(async (dir) => {
        const missing = path.join(dir, 'nowhere', 'cloudflared');
        const options = localOptions(dir, { env: { CLOUDFLARED_PATH: missing } });

        assert.throws(() => stageLocalCloudflared({ ...options, ...instrumentedDeps().deps }), /^Error: CLOUDFLARED_PATH does not exist: /);
    });
});

test('on macOS project-root cloudflared files are ignored unless ALLOW_LOCAL_CLOUDFLARED=1', async () => {
    await withTempDir(async (dir) => {
        const options = localOptions(dir);
        fs.writeFileSync(path.join(options.root, 'cloudflared'), archiveBytes);
        const { calls, deps } = instrumentedDeps();

        assert.equal(stageLocalCloudflared({ ...options, ...deps }), false);

        assert.match(calls.log.join('\n'), /Ignoring local cloudflared binary for security\. Set ALLOW_LOCAL_CLOUDFLARED=1 to override\./);
        assert.deepEqual(calls.extract, []);
        assert.deepEqual(calls.copy, []);
        assert.deepEqual(stagedFiles(options.stagePaths), []);
    });
});

test('on macOS an allowed project-root bare binary is skipped once with a log line, not copied', async () => {
    await withTempDir(async (dir) => {
        const options = localOptions(dir, { env: { ALLOW_LOCAL_CLOUDFLARED: '1' } });
        fs.writeFileSync(path.join(options.root, 'cloudflared'), bareBinaryBytes);
        const { calls, deps } = instrumentedDeps();

        assert.equal(stageLocalCloudflared({ ...options, ...deps }), false);

        const skips = calls.log.filter((line) => /Skipping/.test(line));
        assert.equal(skips.length, 1, 'the same file listed twice among the candidates is reported once');
        assert.deepEqual(calls.copy, []);
        assert.deepEqual(calls.extract, []);
        assert.deepEqual(stagedFiles(options.stagePaths), []);
    });
});

test('on macOS an allowed project-root file that is the pinned archive is extracted', async () => {
    await withTempDir(async (dir) => {
        const options = localOptions(dir, { env: { ALLOW_LOCAL_CLOUDFLARED: '1' } });
        const candidate = path.join(options.root, 'cloudflared');
        fs.writeFileSync(candidate, archiveBytes);
        const { calls, deps } = instrumentedDeps();

        assert.equal(stageLocalCloudflared({ ...options, ...deps }), true);

        assert.ok(!calls.copy.includes(candidate));
        assertStagedFromExtraction(options.stagePaths, calls);
    });
});

test('on macOS a PATH cloudflared that is a bare binary is skipped and the lookup falls through', async () => {
    await withTempDir(async (dir) => {
        const onPath = path.join(dir, 'bin-cloudflared');
        fs.writeFileSync(onPath, bareBinaryBytes);
        const options = localOptions(dir, { findOnPath: () => onPath });
        const { calls, deps } = instrumentedDeps();

        assert.equal(stageLocalCloudflared({ ...options, ...deps }), false);

        assert.match(calls.log.join('\n'), /Skipping cloudflared on PATH/);
        assert.deepEqual(calls.copy, []);
        assert.deepEqual(calls.extract, []);
        assert.deepEqual(stagedFiles(options.stagePaths), []);
    });
});

test('on macOS a PATH file that is the pinned archive is extracted', async () => {
    await withTempDir(async (dir) => {
        const onPath = path.join(dir, 'bin-cloudflared');
        fs.writeFileSync(onPath, archiveBytes);
        const options = localOptions(dir, { findOnPath: () => onPath });
        const { calls, deps } = instrumentedDeps();

        assert.equal(stageLocalCloudflared({ ...options, ...deps }), true);

        assert.ok(!calls.copy.includes(onPath));
        assertStagedFromExtraction(options.stagePaths, calls);
    });
});

test('on Windows the lookup still copies a verified project-root .exe directly and skips an unverified PATH one', async () => {
    await withTempDir(async (dir) => {
        const windows = { platform: 'win32', assetName: windowsAsset, expectedSha256: windowsExeSha256, verify: alwaysValid };
        const options = localOptions(dir, { ...windows, env: { ALLOW_LOCAL_CLOUDFLARED: '1' } });
        const candidate = path.join(options.root, 'cloudflared.exe');
        fs.writeFileSync(candidate, windowsExeBytes);
        const { calls, deps } = instrumentedDeps();

        assert.equal(stageLocalCloudflared({ ...options, ...deps }), true);
        assert.deepEqual(calls.copy, [candidate]);
        assert.deepEqual(calls.extract, []);

        const onPath = path.join(dir, 'path-cloudflared.exe');
        fs.writeFileSync(onPath, bareBinaryBytes);
        const second = localOptions(path.join(dir, 'second'), {
            ...windows, verify: (filePath) => ({ valid: filePath !== onPath, reason: 'not the pinned build' }), findOnPath: () => onPath,
        });
        const secondRun = instrumentedDeps();
        assert.equal(stageLocalCloudflared({ ...second, ...secondRun.deps }), false);
        assert.deepEqual(secondRun.calls.copy, []);
    });
});

// ---------------------------------------------------------------------------
// How the packager starts npm ci and caxa (run, buildPackagerCommand)
//
// On Windows npm and npx are .cmd shims, which Node will not start without
// cmd.exe. run() used to pass shell: true, so Node joined the command and its
// arguments into one unquoted cmd.exe line: the caxa paths (stage directory,
// output exe, icon stub in the temp folder) were split at every space, and &,
// |, ^, ( and ) in them were acted on by cmd.exe. The paths below are what a
// user profile or project folder can look like.
//
// No test here ever starts the real npm: the npm tests use a stand-in
// npm-cli.js and check the route before anything is spawned.
// ---------------------------------------------------------------------------

const awkwardStageDir = 'C:\\Users\\A B\\proj & x\\.caxa-stage';
const awkwardOutputExe = 'C:\\Users\\A B\\proj & x\\Nextra.exe';
const awkwardIconStub = 'C:\\Users\\A B\\AppData\\Local\\Temp (1)\\a^b|c\\nextra-caxa-stub-42.exe';
const npmCiArgs = ['ci', '--omit=dev', '--no-audit', '--no-fund'];
const windowsNode = 'C:\\Program Files\\nodejs\\node.exe';
const windowsNpmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
const windowsCaxaBin = 'C:\\Users\\A B\\proj & x\\node_modules\\caxa\\build\\index.mjs';

function caxaArgsFor(input, output, stub) {
    return [
        'caxa',
        '--input', input,
        '--output', output,
        '--identifier', 'nextra-0123456789ab',
        '--stub', stub,
        '--',
        '{{caxa}}/node_modules/.bin/node',
        '-r',
        '{{caxa}}/lib/startupRuntime.js',
        '{{caxa}}/server.js',
    ];
}

// Records the arguments and working directory it was started with.
function writeArgvProbe(scriptPath, recordPath) {
    fs.writeFileSync(
        scriptPath,
        `require('fs').writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`
    );
}

test('off Windows buildPackagerCommand returns the command and arguments as given, without a shell', () => {
    for (const platform of ['darwin', 'linux']) {
        const caxaArgs = caxaArgsFor('/Users/A B/proj & x/.caxa-stage', '/Users/A B/proj & x/Nextra-macos-arm64', '/tmp/a (b)');
        assert.deepEqual(
            buildPackagerCommand('npx', caxaArgs, { platform, resolveCaxaBin: () => '/never/used.mjs' }),
            { command: 'npx', args: caxaArgs, shell: false, windowsVerbatimArguments: false },
            platform
        );
        assert.deepEqual(
            buildPackagerCommand('npm', npmCiArgs, { platform, env: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' } }),
            { command: 'npm', args: npmCiArgs, shell: false, windowsVerbatimArguments: false },
            platform
        );
    }
});

test('on Windows npm ci runs as node plus npm_execpath, with no shell and its flags unchanged', () => {
    assert.deepEqual(
        buildPackagerCommand('npm', npmCiArgs, { platform: 'win32', execPath: windowsNode, env: { npm_execpath: windowsNpmCli } }),
        { command: windowsNode, args: [windowsNpmCli, ...npmCiArgs], shell: false, windowsVerbatimArguments: false }
    );
});

test('on Windows an npm_execpath that is not npm\'s own CLI is not used to run npm ci', () => {
    const notNpm = [
        '',
        'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
        'C:\\Users\\A\\AppData\\Local\\pnpm\\pnpm.cjs',
        'C:\\Users\\A\\AppData\\Roaming\\yarn\\bin\\yarn.js',
        'node_modules\\npm\\bin\\npm-cli.js',
    ];
    for (const npmExecpath of notNpm) {
        assert.deepEqual(
            buildPackagerCommand('npm', npmCiArgs, {
                platform: 'win32',
                execPath: windowsNode,
                env: { npm_execpath: npmExecpath, ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' },
            }),
            {
                command: 'C:\\WINDOWS\\system32\\cmd.exe',
                args: ['/d', '/s', '/c', '"npm "ci" "--omit=dev" "--no-audit" "--no-fund""'],
                shell: false,
                windowsVerbatimArguments: true,
            },
            JSON.stringify(npmExecpath)
        );
    }
});

test('on Windows caxa runs as node plus its bin script, each path one argument, the -- and {{caxa}} placeholders verbatim', () => {
    for (const stub of [awkwardIconStub, 'C:\\Users\\100% !done\\Temp\\nextra-caxa-stub-42.exe']) {
        const caxaArgs = caxaArgsFor(awkwardStageDir, awkwardOutputExe, stub);
        const invocation = buildPackagerCommand('npx', caxaArgs, {
            platform: 'win32',
            execPath: windowsNode,
            env: {},
            resolveCaxaBin: () => windowsCaxaBin,
        });

        assert.deepEqual(invocation, {
            command: windowsNode,
            args: [windowsCaxaBin, ...caxaArgs.slice(1)],
            shell: false,
            windowsVerbatimArguments: false,
        });
        const valueOf = (flag) => invocation.args[invocation.args.indexOf(flag) + 1];
        assert.equal(valueOf('--input'), awkwardStageDir);
        assert.equal(valueOf('--output'), awkwardOutputExe);
        assert.equal(valueOf('--stub'), stub);
        assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--')), [
            '--', '{{caxa}}/node_modules/.bin/node', '-r', '{{caxa}}/lib/startupRuntime.js', '{{caxa}}/server.js',
        ]);
    }
});

test('the Windows cmd.exe fallback double-quotes every argument, so spaces and & | ^ ( ) stay inside one argument', () => {
    const invocation = buildPackagerCommand(
        'npx',
        ['other-tool', awkwardStageDir, awkwardIconStub, 'C:\\dir with space\\', ''],
        { platform: 'win32', env: { comspec: 'C:\\WINDOWS\\system32\\cmd.exe' } }
    );

    assert.equal(invocation.command, 'C:\\WINDOWS\\system32\\cmd.exe');
    assert.equal(invocation.shell, false);
    assert.equal(invocation.windowsVerbatimArguments, true);
    // A trailing backslash is doubled so it does not escape the closing quote
    // for the child's own argument parser. The bare command name stays
    // unquoted: a batch file started by a quoted bare name gets a wrong %~dp0.
    assert.deepEqual(invocation.args, [
        '/d', '/s', '/c',
        `"npx "other-tool" "${awkwardStageDir}" "${awkwardIconStub}" "C:\\dir with space\\\\" """`,
    ]);
    assert.equal(buildPackagerCommand('npm', ['ci'], { platform: 'win32', env: {} }).command, 'cmd.exe');
    // A command given as a path is quoted like an argument.
    assert.deepEqual(
        buildPackagerCommand('C:\\Program Files (x86)\\A & B\\tool.cmd', ['x y'], { platform: 'win32', env: {} }).args,
        ['/d', '/s', '/c', '""C:\\Program Files (x86)\\A & B\\tool.cmd" "x y""']
    );
});

test('the Windows cmd.exe fallback refuses ", %, ! and line breaks instead of escaping them', () => {
    const unsafe = [
        'C:\\Users\\A "B"\\proj',
        'C:\\Users\\%USERNAME%\\proj',
        'C:\\Users\\100%\\proj',
        'C:\\Users\\wow!\\proj',
        'C:\\Users\\A\r\nB',
    ];
    for (const value of unsafe) {
        assert.throws(
            () => buildPackagerCommand('npm', ['ci', value], { platform: 'win32', env: {} }),
            /cannot pass .* through cmd\.exe/,
            JSON.stringify(value)
        );
    }
});

test('getCaxaBinPath finds the bin caxa\'s package.json names, and node runs it as the caxa CLI', () => {
    const caxaRoot = path.resolve(path.dirname(require.resolve('caxa')), '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(caxaRoot, 'package.json'), 'utf8'));
    const binScript = getCaxaBinPath();

    assert.equal(binScript, path.resolve(caxaRoot, typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.caxa));
    const result = spawnSync(process.execPath, [binScript, '--version'], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), manifest.version);
});

test('getCaxaBinPath walks past a nested package.json to caxa\'s own, reads an object bin, and says when caxa is missing', async () => {
    await withTempDir(async (dir) => {
        const caxaRoot = path.join(dir, 'node_modules', 'caxa');
        fs.mkdirSync(path.join(caxaRoot, 'build'), { recursive: true });
        fs.writeFileSync(path.join(caxaRoot, 'package.json'), JSON.stringify({ name: 'caxa', bin: { caxa: './build/cli.mjs' } }));
        fs.writeFileSync(path.join(caxaRoot, 'build', 'package.json'), JSON.stringify({ type: 'module' }));

        assert.equal(getCaxaBinPath(() => path.join(caxaRoot, 'build', 'index.mjs')), path.join(caxaRoot, 'build', 'cli.mjs'));
    });
    assert.throws(
        () => getCaxaBinPath(() => { throw new Error("Cannot find module 'caxa'"); }),
        /caxa is not installed \(it is a devDependency; run npm install first\): Cannot find module 'caxa'/
    );
});

test('caxa started the Windows way receives a path with spaces, & ^ ( ), % and ! as one argument', async () => {
    await withTempDir(async (dir) => {
        // Never created: caxa names the --input it was given and stops before doing any work.
        const awkwardDir = path.join(dir, 'A B (1) & x ^y 100% !z');
        const missingInput = path.join(awkwardDir, '.caxa-stage');
        const caxaArgs = [
            'caxa', '--input', missingInput, '--output', path.join(awkwardDir, 'Nextra.exe'),
            '--', '{{caxa}}/node_modules/.bin/node', '{{caxa}}/server.js',
        ];
        const invocation = buildPackagerCommand('npx', caxaArgs, { platform: 'win32' });
        assert.equal(invocation.command, process.execPath);
        assert.equal(invocation.args[0], getCaxaBinPath());

        const result = spawnSync(invocation.command, invocation.args, { cwd: dir, encoding: 'utf8', windowsHide: true });
        assert.equal(result.status, 1, result.stderr);
        const expected = `Input isn\u2019t a directory: \u2018${missingInput}\u2019.`;
        assert.ok(result.stderr.includes(expected), `expected ${JSON.stringify(expected)} in caxa's stderr: ${result.stderr}`);
    });
});

test('npm ci started the Windows way keeps its flags and runs in a stage directory with spaces and & ( ) in its path', async () => {
    await withTempDir(async (dir) => {
        const stage = path.join(dir, 'A B (1) & x', '.caxa-stage');
        fs.mkdirSync(stage, { recursive: true });
        const standInNpmCli = path.join(dir, 'stand-in npm', 'bin', 'npm-cli.js');
        const record = path.join(dir, 'npm-call.json');
        fs.mkdirSync(path.dirname(standInNpmCli), { recursive: true });
        writeArgvProbe(standInNpmCli, record);

        const invocation = buildPackagerCommand('npm', npmCiArgs, { platform: 'win32', env: { npm_execpath: standInNpmCli } });
        // Checked before anything is spawned, so a wrong route can never start the real npm ci.
        assert.deepEqual([invocation.command, invocation.args[0]], [process.execPath, standInNpmCli]);

        const result = spawnSync(invocation.command, invocation.args, { cwd: stage, encoding: 'utf8', windowsHide: true });
        assert.equal(result.status, 0, result.stderr);
        const call = JSON.parse(fs.readFileSync(record, 'utf8'));
        assert.deepEqual(call.argv, npmCiArgs);
        assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(stage));
    });
});

// The child's own record of its argv is the ground truth here. Every fragment
// an unquoted cmd.exe line could act on is a relative path that does not exist.
const awkwardChildArgs = [awkwardStageDir, awkwardOutputExe, awkwardIconStub, 'C:\\dir with space\\', '--', '{{caxa}}/server.js'];

test('run passes path arguments with spaces and cmd.exe metacharacters to the child unchanged', async () => {
    await withTempDir(async (dir) => {
        const awkwardDir = path.join(dir, 'A B (1) & x');
        fs.mkdirSync(awkwardDir);
        const probe = path.join(awkwardDir, 'probe.js');
        const record = path.join(awkwardDir, 'argv.json');
        writeArgvProbe(probe, record);

        run(process.execPath, [probe, ...awkwardChildArgs], { cwd: awkwardDir });

        assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')).argv, awkwardChildArgs);
    });
});

test('run passes them unchanged through a .cmd shim built like npm.cmd', { skip: process.platform !== 'win32' && '.cmd shims run only on Windows' }, async () => {
    await withTempDir(async (dir) => {
        const awkwardDir = path.join(dir, 'A B (1) & x');
        fs.mkdirSync(awkwardDir);
        const probe = path.join(awkwardDir, 'probe.js');
        const record = path.join(awkwardDir, 'argv.json');
        writeArgvProbe(probe, record);
        const shim = path.join(awkwardDir, 'tool.cmd');
        fs.writeFileSync(shim, `@"${process.execPath}" "%~dp0probe.js" %*\r\n`);

        run(shim, awkwardChildArgs, { cwd: awkwardDir });

        assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')).argv, awkwardChildArgs);
    });
});

// This is how the fallback reaches npm.cmd when npm_execpath is not set: by its
// bare name through PATH. The shim finds its script through %~dp0, as npm.cmd
// finds npm-cli.js, and runs from another directory so a wrong %~dp0 shows.
test('run passes them unchanged to a .cmd shim found by its bare name through PATH', { skip: process.platform !== 'win32' && '.cmd shims run only on Windows' }, async () => {
    await withTempDir(async (dir) => {
        const shimDir = path.join(dir, 'A B (1) & x');
        const elsewhere = path.join(dir, 'elsewhere');
        fs.mkdirSync(shimDir);
        fs.mkdirSync(elsewhere);
        const record = path.join(dir, 'argv.json');
        writeArgvProbe(path.join(shimDir, 'probe.js'), record);
        fs.writeFileSync(path.join(shimDir, 'nextra-test-shim.cmd'), `@"${process.execPath}" "%~dp0probe.js" %*\r\n`);
        const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';

        run('nextra-test-shim', awkwardChildArgs, {
            cwd: elsewhere,
            env: { [pathKey]: `${shimDir}${path.delimiter}${process.env[pathKey] || ''}` },
        });

        assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')).argv, awkwardChildArgs);
    });
});

test('run still throws "<command> failed with code <status>" when the child exits non-zero', () => {
    assert.throws(
        () => run(process.execPath, ['-e', 'process.exit(3)']),
        { message: `${process.execPath} failed with code 3` }
    );
});
