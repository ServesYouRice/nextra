const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// vite.config.mjs calls loadEnv(mode, process.cwd(), ''), and with an empty prefix
// process.env keys are included. So each case sets the three variables the config
// reads explicitly (an empty string beats a value from a developer's .env file),
// runs in an empty working directory, and uses a mode that has no .env.<mode> file.
const MODE = 'vite-config-test';
const QUICK_TUNNEL_HOST = '.trycloudflare.com';
const ENV_KEYS = ['VITE_ALLOW_QUICK_TUNNEL', 'SHARE_BASE_URL', 'EXTRA_ALLOWED_ORIGINS', 'LOCAL_HTTPS'];

async function loadViteConfig(env = {}) {
    const { default: configFn } = await import('../vite.config.mjs');
    const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    const savedCwd = process.cwd();
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-vite-config-'));
    try {
        for (const key of ENV_KEYS) process.env[key] = '';
        Object.assign(process.env, env);
        process.chdir(emptyDir);
        return configFn({ mode: MODE, command: 'serve' });
    } finally {
        process.chdir(savedCwd);
        for (const [key, value] of savedEnv) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(emptyDir, { recursive: true, force: true });
    }
}

test('the dev and preview servers do not allow quick-tunnel hosts by default', async () => {
    const config = await loadViteConfig();

    assert.deepEqual(config.server.allowedHosts, []);
    assert.deepEqual(config.preview.allowedHosts, []);
    assert.ok(!config.server.allowedHosts.includes(QUICK_TUNNEL_HOST));
    assert.ok(!config.preview.allowedHosts.includes(QUICK_TUNNEL_HOST));
});

test('VITE_ALLOW_QUICK_TUNNEL=true adds the quick-tunnel host to the dev and preview servers', async () => {
    for (const flag of ['true', 'TRUE']) {
        const config = await loadViteConfig({ VITE_ALLOW_QUICK_TUNNEL: flag });

        assert.deepEqual(config.server.allowedHosts, [QUICK_TUNNEL_HOST], `server, flag ${JSON.stringify(flag)}`);
        assert.deepEqual(config.preview.allowedHosts, [QUICK_TUNNEL_HOST], `preview, flag ${JSON.stringify(flag)}`);
    }
});

test('only the value true opts in to the quick-tunnel host', async () => {
    for (const flag of ['false', '1', 'yes', 'on', '0']) {
        const config = await loadViteConfig({ VITE_ALLOW_QUICK_TUNNEL: flag });

        assert.ok(!config.server.allowedHosts.includes(QUICK_TUNNEL_HOST), `server, flag ${JSON.stringify(flag)}`);
        assert.ok(!config.preview.allowedHosts.includes(QUICK_TUNNEL_HOST), `preview, flag ${JSON.stringify(flag)}`);
    }
});

test('SHARE_BASE_URL and EXTRA_ALLOWED_ORIGINS hosts are still allowed without the opt-in', async () => {
    const config = await loadViteConfig({
        SHARE_BASE_URL: 'https://share.example.test',
        EXTRA_ALLOWED_ORIGINS: 'https://one.example.test, two.example.test:8443',
    });
    const expected = ['share.example.test', 'one.example.test', 'two.example.test'];

    assert.deepEqual(config.server.allowedHosts, expected);
    assert.deepEqual(config.preview.allowedHosts, expected);
    assert.ok(!config.server.allowedHosts.includes(QUICK_TUNNEL_HOST));
    assert.ok(!config.preview.allowedHosts.includes(QUICK_TUNNEL_HOST));
});

test('the opt-in adds the quick-tunnel host next to the configured hosts', async () => {
    const config = await loadViteConfig({
        VITE_ALLOW_QUICK_TUNNEL: 'true',
        SHARE_BASE_URL: 'https://share.example.test',
    });

    assert.deepEqual(config.server.allowedHosts, [QUICK_TUNNEL_HOST, 'share.example.test']);
    assert.deepEqual(config.preview.allowedHosts, [QUICK_TUNNEL_HOST, 'share.example.test']);
});

test('both proxy entries of the dev and preview servers forward the client address with xfwd', async () => {
    for (const env of [{}, { LOCAL_HTTPS: 'true' }]) {
        const config = await loadViteConfig(env);
        const target = `${env.LOCAL_HTTPS === 'true' ? 'https' : 'http'}://localhost:3000`;

        for (const [serverName, proxy] of [['server', config.server.proxy], ['preview', config.preview.proxy]]) {
            assert.deepEqual(Object.keys(proxy).sort(), ['/api', '/socket.io'], `${serverName} proxy paths`);
            for (const route of ['/api', '/socket.io']) {
                assert.equal(proxy[route].xfwd, true, `${serverName} ${route} sets xfwd`);
                assert.equal(proxy[route].target, target, `${serverName} ${route} target`);
                assert.equal(proxy[route].changeOrigin, true, `${serverName} ${route} changeOrigin`);
                assert.equal(proxy[route].secure, false, `${serverName} ${route} secure`);
            }
            assert.equal(proxy['/socket.io'].ws, true, `${serverName} /socket.io proxies websockets`);
        }
    }
});
