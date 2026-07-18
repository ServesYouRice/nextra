const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { TunnelSupervisor } = require('../lib/tunnelSupervisor');

function config(overrides = {}) {
    return {
        SHARE_BASE_URL: '',
        CLOUDFLARED_TUNNEL_TOKEN: '',
        AUTO_PUBLIC_TUNNEL: true,
        PUBLIC_TUNNEL_PROVIDER: 'cloudflared',
        PORT: 3000,
        CLOUDFLARED_PATH: 'cloudflared',
        PUBLIC_TUNNEL_TIMEOUT_MS: 100,
        PUBLIC_TUNNEL_NO_TLS_VERIFY: true,
        ...overrides,
    };
}

test('TunnelSupervisor owns the process and publishes active state', async () => {
    const process = new EventEmitter();
    let stopped = 0;
    const states = [];
    const supervisor = new TunnelSupervisor({
        config: config(),
        startTunnel: async () => ({
            baseUrl: 'https://example.trycloudflare.com/',
            process,
            stop: () => { stopped += 1; },
        }),
        normalizeBaseUrl: (value) => value.replace(/\/$/, ''),
        onChange: (state) => states.push(state),
        logger: { log() {}, warn() {} },
    });

    await supervisor.start();
    assert.deepEqual(supervisor.snapshot(), {
        baseUrl: 'https://example.trycloudflare.com', status: 'active', error: '',
    });
    assert.equal(states.at(-1).status, 'active');
    assert.equal(supervisor.close(), true);
    assert.equal(supervisor.close(), false);
    assert.equal(stopped, 1);
});

test('TunnelSupervisor ignores a late start after close', async () => {
    let resolveStart;
    let stopped = 0;
    const supervisor = new TunnelSupervisor({
        config: config(),
        startTunnel: () => new Promise((resolve) => { resolveStart = resolve; }),
        logger: { log() {}, warn() {} },
    });
    const starting = supervisor.start();
    supervisor.close();
    resolveStart({ baseUrl: 'https://late.example', process: new EventEmitter(), stop: () => { stopped += 1; } });
    await starting;
    assert.equal(stopped, 1);
    assert.equal(supervisor.snapshot().baseUrl, '');
});

test('TunnelSupervisor reports manual and unsupported-provider states without spawning', async () => {
    let starts = 0;
    const manual = new TunnelSupervisor({
        config: config({ SHARE_BASE_URL: 'https://share.example', AUTO_PUBLIC_TUNNEL: false }),
        startTunnel: async () => { starts += 1; },
        normalizeBaseUrl: (value) => value,
    });
    assert.equal((await manual.start()).status, 'manual');

    const unsupported = new TunnelSupervisor({
        config: config({ PUBLIC_TUNNEL_PROVIDER: 'unknown' }),
        startTunnel: async () => { starts += 1; },
        logger: { log() {}, warn() {} },
    });
    assert.equal((await unsupported.start()).status, 'error');
    assert.equal(starts, 0);
});
