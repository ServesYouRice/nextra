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
