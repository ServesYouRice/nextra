const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { TunnelSupervisor } = require('../lib/tunnelSupervisor');
const { __testing } = require('../lib/tunnel');

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

function namedConfig(overrides = {}) {
    return config({
        CLOUDFLARED_TUNNEL_TOKEN: 'token',
        SHARE_BASE_URL: 'https://share.example.com',
        AUTO_PUBLIC_TUNNEL: false,
        PUBLIC_TUNNEL_TIMEOUT_MS: 5000,
        ...overrides,
    });
}

// Lets the supervisor's awaits and the test's promise reactions run; node's mock timers leave setImmediate alone.
function nextTurn() {
    return new Promise((resolve) => setImmediate(resolve));
}

test('a named tunnel stays starting until startTunnel resolves, then is active', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let registered;
    const states = [];
    let starts = 0;
    const supervisor = new TunnelSupervisor({
        config: namedConfig(),
        startTunnel: () => {
            starts += 1;
            return new Promise((resolve) => { registered = resolve; });
        },
        onChange: (state) => states.push(state),
        logger: { log() {}, warn() {} },
    });

    const starting = supervisor.start();
    await nextTurn();
    t.mock.timers.tick(60_000);
    await nextTurn();
    assert.equal(supervisor.snapshot().status, 'starting');
    assert.equal(supervisor.snapshot().baseUrl, '');
    assert.ok(states.every((state) => state.status === 'starting'));

    registered({ baseUrl: 'https://share.example.com', process: new EventEmitter(), stop() {} });
    await starting;
    assert.deepEqual(supervisor.snapshot(), { baseUrl: 'https://share.example.com', status: 'active', error: '' });
    assert.equal(starts, 1);
    supervisor.close();
});

test('a tunnel start that rejects after a delay publishes error and schedules a restart', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const rejections = [];
    const states = [];
    let starts = 0;
    const supervisor = new TunnelSupervisor({
        config: namedConfig(),
        startTunnel: () => {
            starts += 1;
            return new Promise((resolve, reject) => { rejections.push(reject); });
        },
        onChange: (state) => states.push({ ...state }),
        logger: { log() {}, warn() {} },
    });

    const starting = supervisor.start();
    await nextTurn();
    assert.equal(supervisor.snapshot().status, 'starting', 'no result yet, so the tunnel cannot be reported active');
    assert.equal(starts, 1);

    rejections[0](new Error('cloudflared did not register a tunnel connection within 5000ms'));
    await starting;
    assert.deepEqual(supervisor.snapshot(), {
        baseUrl: '',
        status: 'error',
        error: 'cloudflared did not register a tunnel connection within 5000ms',
    });
    assert.deepEqual(states.map((state) => state.status), ['starting', 'error']);

    assert.equal(starts, 1, 'the restart waits for its backoff delay');
    t.mock.timers.tick(999);
    await nextTurn();
    assert.equal(starts, 1);
    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(starts, 2, 'a restart was scheduled');
    assert.equal(supervisor.snapshot().status, 'starting');

    supervisor.close();
    t.mock.timers.tick(120_000);
    await nextTurn();
    assert.equal(starts, 2, 'close cancels any further restart');
});

test('a named tunnel whose cloudflared stays alive without registering ends in error and a restart', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const children = [];
    const supervisor = new TunnelSupervisor({
        config: namedConfig({ PUBLIC_TUNNEL_TIMEOUT_MS: 5000 }),
        startTunnel: ({ timeoutMs, baseUrl }) => {
            const child = new EventEmitter();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.exitCode = null;
            child.signalCode = null;
            child.signals = [];
            child.kill = (signal) => { child.signals.push(signal); child.signalCode = signal; return true; };
            children.push(child);
            return __testing.launchCloudflaredCandidate('cloudflared', ['tunnel', 'run'], timeoutMs, {
                knownBaseUrl: baseUrl,
                spawn: () => child,
            });
        },
        logger: { log() {}, warn() {} },
    });

    const starting = supervisor.start();
    await nextTurn();
    children[0].stderr.write('ERR Failed to dial a quic connection error="timeout: no recent network activity"\n');
    await nextTurn();
    t.mock.timers.tick(4999);
    await nextTurn();
    assert.equal(supervisor.snapshot().status, 'starting', 'an unregistered process is not reported active');

    t.mock.timers.tick(1);
    await starting;
    assert.deepEqual(supervisor.snapshot(), {
        baseUrl: '',
        status: 'error',
        error: 'cloudflared did not register a tunnel connection within 5000ms',
    });
    assert.deepEqual(children[0].signals, ['SIGTERM']);

    t.mock.timers.tick(1000);
    await nextTurn();
    assert.equal(children.length, 2, 'a restart launched cloudflared again');
    children[1].stderr.write('INF Registered tunnel connection connIndex=0\n');
    await nextTurn();
    await nextTurn();
    assert.deepEqual(supervisor.snapshot(), { baseUrl: 'https://share.example.com', status: 'active', error: '' });
    supervisor.close();
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
