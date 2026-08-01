const test = require('node:test');
const assert = require('node:assert/strict');

test('Browser preflight blocks unavailable capture and keeps system-audio support advisory', async () => {
    const { evaluateHostPreflight } = await import('../src/lib/hostPreflight.mjs');
    const blocked = evaluateHostPreflight({
        ingestMode: 'browser', captureApiAvailable: false, secureContext: false, chromium: true,
        publicShareStatus: 'disabled',
    });
    assert.deepEqual(blocked.blockers.map(({ code }) => code), ['capture-unavailable']);
    assert.match(blocked.blockers[0].message, /localhost or HTTPS/);

    const advisory = evaluateHostPreflight({
        ingestMode: 'browser', captureApiAvailable: true, secureContext: true, chromium: false,
        publicShareStatus: 'disabled',
    });
    assert.deepEqual(advisory.blockers, []);
    assert.deepEqual(advisory.warnings.map(({ code }) => code), ['system-audio-unsupported']);
});

test('OBS H.264 requires WHIP but treats missing browser WebSocket as a manual-setup warning', async () => {
    const { evaluateHostPreflight } = await import('../src/lib/hostPreflight.mjs');
    const result = evaluateHostPreflight({
        ingestMode: 'obs', whipHttpStatus: 'error', whipHttpError: 'port already in use',
        obsAv1Mode: false, webSocketAvailable: false, publicShareStatus: 'disabled',
    });
    assert.deepEqual(result.blockers.map(({ code }) => code), ['whip-unavailable']);
    assert.match(result.blockers[0].message, /port already in use/);
    assert.deepEqual(result.warnings.map(({ code }) => code), ['obs-websocket-unavailable']);
});

test('OBS AV1 preflight contains TURN, encoder, browser, and public-media blockers', async () => {
    const { evaluateHostPreflight } = await import('../src/lib/hostPreflight.mjs');
    const result = evaluateHostPreflight({
        ingestMode: 'obs', whipHttpStatus: 'ready', obsAv1Mode: true, obsApplySettings: false,
        turnConfigValid: false, turnConfigError: 'TURN username is missing.',
        publicShareStatus: 'active', publicAv1Supported: false, webSocketAvailable: false,
    });
    assert.deepEqual(result.blockers.map(({ code }) => code), [
        'obs-websocket-unavailable',
        'av1-auto-config-required',
        'av1-turn-invalid',
        'av1-public-media-unreachable',
    ]);
});

test('ready H.264 and fully configured AV1 OBS paths pass preflight', async () => {
    const { evaluateHostPreflight } = await import('../src/lib/hostPreflight.mjs');
    const common = {
        ingestMode: 'obs',
        whipHttpStatus: 'ready',
        obsApplySettings: true,
        turnConfigValid: true,
        publicShareStatus: 'disabled',
        publicAv1Supported: false,
        webSocketAvailable: true,
    };
    assert.deepEqual(evaluateHostPreflight({ ...common, obsAv1Mode: false }), {
        blockers: [], warnings: [],
    });
    assert.deepEqual(evaluateHostPreflight({ ...common, obsAv1Mode: true }), {
        blockers: [], warnings: [],
    });
});

test('public tunnel startup and failure remain non-blocking local-room warnings', async () => {
    const { evaluateHostPreflight } = await import('../src/lib/hostPreflight.mjs');
    const starting = evaluateHostPreflight({
        ingestMode: 'browser', captureApiAvailable: true, secureContext: true, chromium: true,
        publicShareStatus: 'starting',
    });
    assert.deepEqual(starting.blockers, []);
    assert.deepEqual(starting.warnings.map(({ code }) => code), ['public-link-starting']);

    const failed = evaluateHostPreflight({
        ingestMode: 'browser', captureApiAvailable: true, secureContext: true, chromium: true,
        publicShareStatus: 'error', publicShareError: 'cloudflared missing',
    });
    assert.deepEqual(failed.blockers, []);
    assert.match(failed.warnings[0].message, /cloudflared missing/);
});
