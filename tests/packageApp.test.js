'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
    downloadFileWithRedirects,
    getCloudflaredAssetName,
    getFfmpegAsset,
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
