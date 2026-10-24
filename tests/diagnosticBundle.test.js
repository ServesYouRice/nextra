const test = require('node:test');
const assert = require('node:assert/strict');

test('diagnostic bundle uses an exact allowlist and redacts sensitive error text', async () => {
    const { buildDiagnosticBundle } = await import('../src/lib/diagnosticBundle.mjs');
    const bundle = buildDiagnosticBundle({
        generatedAt: '2026-08-01T12:00:00.000Z',
        packageInfo: { version: '2.0.1', packaged: true, operatorToken: 'do-not-copy' },
        readiness: {
            status: 'ready',
            components: { http: { required: true, status: 'ready', token: 'secret' } },
        },
        publicConfig: {
            whipEnabled: true,
            whepEnabled: false,
            shareBaseUrl: 'https://public.example/watch/SECRET',
            whipHttpUrl: 'http://127.0.0.1:3001',
            turnCredential: 'do-not-copy',
        },
        globalMetrics: {
            process: { pid: 42, uptimeSec: 12, memory: { rss: 100 }, operatorToken: 'do-not-copy' },
            rooms: {
                active: 1,
                totalViewers: 2,
                list: [{ code: 'ABC123', hostToken: 'do-not-copy', passphrase: 'do-not-copy' }],
            },
            sockets: { counters: { activeSockets: 3 }, rooms: [{ code: 'ABC123' }] },
            mediaWorker: { pid: 43, resourceUsage: { ru_utime: 9 } },
            runtimeShareBaseUrl: 'https://public.example/watch/ABC123',
        },
        roomMetrics: {
            roomCode: 'ABC123',
            hostToken: 'do-not-copy',
            viewerCount: 2,
            relay: { bytesForwarded: 1234 },
            fallbackLastError: 'Bearer: do-not-copy',
        },
        hostState: {
            ingestMode: 'obs', obsAv1Mode: false, qualityProfile: '1080p', frameRate: 60,
            publicShareStatus: 'active', hasTurnServer: true, roomHasTurnServer: false,
            whipHttpStatus: 'ready', reloadRecoveryEnabled: false,
            byokTurnSecret: 'do-not-copy', roomPassphrase: 'do-not-copy',
        },
        clientRuntime: { userAgent: 'Test Browser', platform: 'Test OS', language: 'en', secureContext: true },
        errors: [
            'Failed URL https://public.example/watch/ABC123?token=do-not-copy',
            'Authorization: Bearer do-not-copy',
            'password=do-not-copy',
            `token=${'a'.repeat(64)}`,
        ],
    });

    assert.equal(bundle.app.version, '2.0.1');
    assert.equal(bundle.runtime.rooms.active, 1);
    assert.equal(bundle.topology.viewerCount, 2);
    assert.deepEqual(bundle.errors, [
        'Failed URL [redacted-url]',
        'Authorization=[redacted]',
        'password=[redacted]',
        'token=[redacted]',
    ]);
    const serialized = JSON.stringify(bundle);
    for (const forbidden of [
        'ABC123', 'do-not-copy', 'shareBaseUrl', 'whipHttpUrl', 'operatorToken',
        'hostToken', 'passphrase', 'roomCode', 'runtimeShareBaseUrl', 'rooms":[',
    ]) {
        assert.equal(serialized.includes(forbidden), false, `bundle leaked ${forbidden}`);
    }
});

test('diagnostic download writes one JSON blob and revokes its object URL', async () => {
    const { downloadDiagnosticBundle } = await import('../src/lib/diagnosticBundle.mjs');
    const calls = [];
    let blobParts = null;
    let blobOptions = null;
    class FakeBlob {
        constructor(parts, options) {
            blobParts = parts;
            blobOptions = options;
        }
    }
    const link = {
        click: () => calls.push('click'),
        remove: () => calls.push('remove'),
    };
    const documentRef = {
        createElement: (name) => { calls.push(`create:${name}`); return link; },
        body: { appendChild: () => calls.push('append') },
    };
    const urlApi = {
        createObjectURL: () => { calls.push('create-url'); return 'blob:test'; },
        revokeObjectURL: (value) => calls.push(`revoke:${value}`),
    };
    const filename = downloadDiagnosticBundle({ generatedAt: '2026-08-01T12:00:00.000Z', ok: true }, {
        documentRef, urlApi, BlobImpl: FakeBlob,
    });
    assert.equal(filename, 'nextra-diagnostics-2026-08-01T12-00-00-000Z.json');
    assert.deepEqual(calls, ['create-url', 'create:a', 'append', 'click', 'remove', 'revoke:blob:test']);
    assert.equal(blobOptions.type, 'application/json');
    assert.deepEqual(JSON.parse(blobParts[0]), { generatedAt: '2026-08-01T12:00:00.000Z', ok: true });
});

// ---------------------------------------------------------------------------
// sanitizeDiagnosticText: the formats the diagnostics UI promises to exclude
// (credentials, links and room codes). Positive cases are table-driven; every
// row names the text that must not survive and, where the shape matters, the
// exact output.
// ---------------------------------------------------------------------------

const B64_PADDED = 'Y29tbWFuZGVyOnN1cGVyc2VjcmV0K3Rva2VuLw==';
const B64_PLUS_SLASH = 'q83Hs+2KdLx/9TzVn4bYw0RcPjEaFuMgOi1tAb';
const B64_SHORT_PADDED = 'dGVzdC1zZWNyZXQtdmFsdWU=';
const HEX_UPPER_32 = 'ABCDEF0123456789ABCDEF0123456789';
const HEX_UPPER_47 = 'ABCDEF0123456789ABCDEF0123456789ABCDEF012345678';

const MUST_REDACT = [
    // (a) Authorization headers with any scheme
    ['basic auth', 'Authorization: Basic dXNlcjpwYXNz', ['dXNlcjpwYXNz'], 'Authorization=[redacted]'],
    ['basic auth, no space after colon', 'Authorization:Basic dXNlcjpwYXNz', ['dXNlcjpwYXNz'], 'Authorization=[redacted]'],
    ['basic auth, equals sign', 'authorization=Basic dXNlcjpwYXNz', ['dXNlcjpwYXNz']],
    ['basic auth inside a sentence', 'Request failed (Authorization: Basic dXNlcjpwYXNz) after 3 tries', ['dXNlcjpwYXNz'], 'Request failed (Authorization=[redacted]) after 3 tries'],
    ['digest auth with parameters', 'Authorization: Digest username="alice", realm="nextra", nonce="9f8e7d6c", response="c0ffee11"', ['alice', '9f8e7d6c', 'c0ffee11']],
    ['negotiate on a proxy header', 'Proxy-Authorization: Negotiate YIIB6wYGKwYBBQUC', ['YIIB6wYGKwYBBQUC']],
    ['bearer auth keeps its old output', 'Authorization: Bearer do-not-copy', ['do-not-copy'], 'Authorization=[redacted]'],
    ['quoted authorization value', '{"authorization":"Basic dXNlcjpwYXNz"}', ['dXNlcjpwYXNz'], '{"authorization":"[redacted]"}'],
    // (b) quoted keys and values
    ['json token', '{"token":"abc123"}', ['abc123'], '{"token":"[redacted]"}'],
    ['json password with spaces', '{"password": "correct horse battery"}', ['correct', 'horse', 'battery'], '{"password": "[redacted]"}'],
    ['single quoted secret', "{'secret': 'hunter2'}", ['hunter2'], "{'secret': '[redacted]'}"],
    ['json camelCase key keeps the other fields', '{"accessToken":"abc123","ok":true}', ['abc123'], '{"accessToken":"[redacted]","ok":true}'],
    ['json passphrase after another field', '{"user":"bob","passphrase":"s3cr3t value"}', ['s3cr3t', 'value'], '{"user":"bob","passphrase":"[redacted]"}'],
    ['json room code key', '{"roomCode":"AB12CD"}', ['AB12CD'], '{"roomCode":"[redacted]"}'],
    ['escaped quote inside a json value', '{"password":"ab\\"cd efg"}', ['cd efg', 'efg']],
    ['compound key name', 'hostToken=abc123', ['abc123'], 'hostToken=[redacted]'],
    ['snake case key', 'access_token: abc123', ['abc123'], 'access_token=[redacted]'],
    ['credentials key', 'turn credentials=abc123', ['abc123']],
    // (c) room codes outside the literal "room code=" form
    ['room word', 'Room AB12CD not found', ['AB12CD'], 'Room [redacted] not found'],
    ['room word, lower case', 'joined room AB12CD as host', ['AB12CD'], 'joined room [redacted] as host'],
    ['room code words', 'unknown room code AB12CD', ['AB12CD']],
    ['room with colon', 'room: AB12CD', ['AB12CD'], 'room: [redacted]'],
    ['roomCode with colon', 'roomCode: AB12CD', ['AB12CD']],
    ['room id', 'room id=AB12CD', ['AB12CD']],
    ['room code with the display hyphen', 'Room ABC-D23 closed', ['ABC-D23']],
    ['json room', '{"room":"AB12CD"}', ['AB12CD'], '{"room":"[redacted]"}'],
    ['whip path', 'POST /whip/AB12CD failed', ['AB12CD'], 'POST /whip/[redacted] failed'],
    ['whip broadcast path', 'POST /whip/broadcast/AB12CD failed', ['AB12CD'], 'POST /whip/broadcast/[redacted] failed'],
    ['whep path', 'GET /whep/AB12CD failed', ['AB12CD'], 'GET /whep/[redacted] failed'],
    ['whep watch path', 'GET /whep/watch/AB12CD failed', ['AB12CD'], 'GET /whep/watch/[redacted] failed'],
    ['whep watch path with a session id', 'DELETE /whep/watch/3f2b8c1d-9a47-4e0a-b6d1-5c7e2f9a8b10 failed', ['3f2b8c1d']],
    ['watch fragment', 'navigated to #watch/AB12CD', ['AB12CD'], 'navigated to #watch/[redacted]'],
    ['watch fragment with a slash', 'navigated to #/watch/AB12CD.', ['AB12CD']],
    ['watch fragment, lower case', 'navigated to #watch/ab12cd', ['ab12cd']],
    // (d) links and addresses beyond http(s), ws(s), stun and turn
    ['rtmp url', 'push to rtmp://live.example.com/app/streamkey123 failed', ['live.example.com', 'streamkey123'], 'push to [redacted-url] failed'],
    ['rtsp url with ip and port', 'rtsp://10.0.0.5:554/cam1 refused', ['10.0.0.5', 'cam1']],
    ['srt url', 'srt://relay.example.com:9000?passphrase=abc timed out', ['relay.example.com', 'abc']],
    ['file url', 'could not open file:///C:/Users/alice/video.mp4', ['alice', 'video.mp4']],
    ['ftp url', 'ftp://files.example.com/pub', ['files.example.com']],
    ['ipv4 address', 'peer 192.168.1.20 left', ['192.168.1.20'], 'peer [redacted-url] left'],
    ['ipv4 with port', 'connect ECONNREFUSED 127.0.0.1:3001', ['127.0.0.1', '3001'], 'connect ECONNREFUSED [redacted-url]'],
    ['ipv4 at the end of a sentence', 'bind failed on 10.1.2.3.', ['10.1.2.3']],
    ['bracketed ipv6 with port', 'candidate [2001:db8::1]:5000 failed', ['2001:db8::1']],
    ['bare ipv6 loopback with port', 'connect ECONNREFUSED ::1:3001', ['::1']],
    ['bare ipv6 address', 'peer fe80::1ff:fe23:4567:890a left', ['fe80::1ff']],
    ['localhost with port', 'listening on localhost:3001', ['localhost', '3001'], 'listening on [redacted-url]'],
    ['dns name with port', 'fetch failed for relay.example.com:8443', ['relay.example.com'], 'fetch failed for [redacted-url]'],
    ['dns name with port and path', 'GET nextra.example.org:443/health', ['nextra.example.org']],
    // (e) long hex in any case, and base64 that contains + / =
    ['uppercase hex, 32 characters', `key ${HEX_UPPER_32} rejected`, [HEX_UPPER_32], 'key [redacted-value] rejected'],
    ['uppercase hex, 47 characters', `key ${HEX_UPPER_47} rejected`, [HEX_UPPER_47]],
    ['mixed case hex', 'key abcdef0123456789ABCDEF0123456789 rejected', ['abcdef0123456789ABCDEF0123456789']],
    ['lowercase hex still redacted', `key ${'ab12'.repeat(10)} rejected`, ['ab12ab12ab12']],
    ['base64 with padding', `signature ${B64_PADDED} bad`, [B64_PADDED], 'signature [redacted-value] bad'],
    ['base64 with plus and slash', `signature ${B64_PLUS_SLASH} bad`, [B64_PLUS_SLASH]],
    ['short padded base64', `blob ${B64_SHORT_PADDED} bad`, [B64_SHORT_PADDED]],
    ['base64 after an equals sign', `sig=${B64_PLUS_SLASH}`, [B64_PLUS_SLASH]],
];

for (const [name, input, secrets, expected] of MUST_REDACT) {
    test(`sanitizeDiagnosticText redacts ${name}`, async () => {
        const { sanitizeDiagnosticText } = await import('../src/lib/diagnosticBundle.mjs');
        const output = sanitizeDiagnosticText(input);
        for (const secret of secrets) {
            assert.equal(output.includes(secret), false, `"${secret}" survived in: ${output}`);
        }
        if (expected !== undefined) assert.equal(output, expected);
        assert.equal(sanitizeDiagnosticText(output), output, 'redacting twice must change nothing');
    });
}

const MUST_STAY = [
    'ffmpeg encoder libx264 selected',
    'Encoder h264_nvenc not available; using libx264',
    '[h264_nvenc @ 000001b2c4d5e6f0] OpenEncodeSessionEx failed: unsupported device (2)',
    'ffmpeg version 6.1.1 Copyright (c) 2000-2023',
    'node v22.14.0 on win32',
    'version 1.2.3',
    'client 2.0.1 packaged',
    'build 1.2.3.4.5',
    'Windows 10.0.26300.1',
    'at HostView.jsx:538:12',
    'at src/lib/diagnosticBundle.mjs:44:9',
    'Event at 2026-08-01T12:00:00.000Z',
    'elapsed 12:30:45',
    'width:1920 height:1080',
    'mediasoup worker died (code 1, signal null)',
    'Room closed by host',
    'room status: ok',
    'rooms active: 3',
    'bedroom light',
    'token count is 5',
    'tokenizer: fast',
    'passwordless login enabled',
    'POST /whip/broadcast failed',
    'GET /whep/status failed',
    'node_modules/mediasoup/worker/out/Release/mediasoup-worker',
    'nextra-diagnostics-2026-08-01T12-00-00-000Z.json',
    `${'a'.repeat(31)} is not hex`,
    'Failed: NotAllowedError: Permission denied',
];

for (const text of MUST_STAY) {
    test(`sanitizeDiagnosticText leaves benign text alone: ${text.slice(0, 50)}`, async () => {
        const { sanitizeDiagnosticText } = await import('../src/lib/diagnosticBundle.mjs');
        assert.equal(sanitizeDiagnosticText(text), text);
    });
}

test('sanitizeDiagnosticText still truncates to 2000 characters and ignores non-strings', async () => {
    const { sanitizeDiagnosticText } = await import('../src/lib/diagnosticBundle.mjs');
    assert.equal(sanitizeDiagnosticText('word '.repeat(1000)).length, 2000);
    assert.equal(sanitizeDiagnosticText(undefined), '');
    assert.equal(sanitizeDiagnosticText({ token: 'abc' }), '');
});

test('sanitizeDiagnosticText covers every room-code character the server generates', async () => {
    const { sanitizeDiagnosticText } = await import('../src/lib/diagnosticBundle.mjs');
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'rooms.js'), 'utf8');
    const chars = source.match(/const CHARS = '([^']+)'/)[1];
    const length = Number(source.match(/const CODE_LENGTH = (\d+)/)[1]);
    assert.ok(chars.length > 20 && length >= 4);
    for (let start = 0; start < chars.length; start += 1) {
        let code = '';
        for (let i = 0; i < length; i += 1) code += chars[(start + i * 5) % chars.length];
        for (const text of [`Room ${code} not found`, `/whip/${code}`, `/whep/${code}`, `#watch/${code}`]) {
            assert.equal(sanitizeDiagnosticText(text).includes(code), false, `${code} survived in: ${text}`);
        }
    }
});

test('sanitizeDiagnosticText stays fast on long runs of separators', async () => {
    const { sanitizeDiagnosticText } = await import('../src/lib/diagnosticBundle.mjs');
    const started = Date.now();
    for (const text of ['a.'.repeat(1000), 'a-'.repeat(1000), 'a/'.repeat(1000), ':a'.repeat(1000), '1.'.repeat(1000)]) {
        sanitizeDiagnosticText(text);
    }
    assert.ok(Date.now() - started < 1000, 'sanitizing pathological input took too long');
});

test('diagnostic bundle sanitizes the new formats in readiness and top-level errors', async () => {
    const { buildDiagnosticBundle } = await import('../src/lib/diagnosticBundle.mjs');
    const bundle = buildDiagnosticBundle({
        readiness: {
            status: 'degraded',
            components: { whip: { required: true, status: 'failed', error: 'Room AB12CD not found at 10.0.0.5:3001' } },
            fallbackRelay: { nvencProbe: { status: 'failed', encoder: 'h264_nvenc', error: 'Authorization: Basic dXNlcjpwYXNz' } },
        },
        errors: ['{"token":"abc123"}', `rtmp://live.example.com/app/${B64_PADDED}`],
    });
    const serialized = JSON.stringify(bundle);
    for (const forbidden of ['AB12CD', '10.0.0.5', 'dXNlcjpwYXNz', 'abc123', 'live.example.com', B64_PADDED]) {
        assert.equal(serialized.includes(forbidden), false, `bundle leaked ${forbidden}`);
    }
    assert.equal(bundle.schemaVersion, 1);
    assert.equal(bundle.readiness.fallbackRelay.nvencProbe.encoder, 'h264_nvenc');
});
