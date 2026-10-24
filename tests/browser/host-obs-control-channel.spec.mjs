import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientBuildDir } from './clientBuild.mjs';

const require = createRequire(import.meta.url);
const { claimServerPorts } = require('../serverPorts.js');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// These tests need a server with WHIP on (the host view only configures OBS once
// the WHIP endpoint is ready), which the shared Playwright web server turns off.
// So the spec starts its own on ports it claims, and serves the same build as
// that web server unless NEXTRA_TEST_DIST_DIR names another (clientBuildDir
// refuses a dist older than the client source).
let server = null;
let serverOutput = '';

async function startServer() {
    const distDir = clientBuildDir(projectRoot);
    const { port, rtcPort } = await claimServerPorts();
    const { port: whipPort } = await claimServerPorts();
    const child = spawn(process.execPath, ['server.js'], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            NODE_ENV: 'test',
            APP_ENV: 'test',
            PORT: String(port),
            BIND_HOST: '127.0.0.1',
            LAN_IP: '127.0.0.1',
            LOCAL_HTTPS: 'false',
            OPEN_BROWSER: 'false',
            AUTO_DETECT_PUBLIC_IP: 'false',
            AUTO_PUBLIC_TUNNEL: 'false',
            CLOUDFLARED_TUNNEL_TOKEN: '',
            SHARE_BASE_URL: '',
            WHIP_ENABLED: 'true',
            WHIP_BIND_HOST: '127.0.0.1',
            WHIP_HTTP_PORT: String(whipPort),
            WHEP_ENABLED: 'false',
            RTC_LISTEN_IP: '127.0.0.1',
            RTC_MIN_PORT: String(rtcPort),
            RTC_MAX_PORT: String(rtcPort),
            NEXTRA_SMOKE_TEST: '1',
            NEXTRA_TEST_DIST_DIR: distDir,
            LOG_LEVEL: 'info',
        },
    });
    serverOutput = '';
    child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
    child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})\n${serverOutput}`);
        if (Date.now() > deadline) throw new Error(`server was not ready in time\n${serverOutput}`);
        // The WHIP line is printed once its listener is up.
        if (/WHIP:\s+\S+\/whip\/broadcast\//.test(serverOutput)) {
            try {
                if ((await fetch(`${baseUrl}/readyz`)).ok) break;
            } catch { /* not listening yet */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { child, baseUrl };
}

async function stopServer({ child, baseUrl }) {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
        await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' });
    } catch {
        child.kill();
    }
    const timer = setTimeout(() => child.kill(), 7_000);
    await exited;
    clearTimeout(timer);
}

test.beforeAll(async () => {
    server = await startServer();
});

test.afterAll(async () => {
    if (server) await stopServer(server);
});

// A stand-in for OBS's obs-websocket server on its default port. `mode` decides
// what the next connections meet: 'down' refuses them like a closed OBS, 'up'
// answers them, and 'hold' answers them but keeps the stream-service write
// pending until release() so a test can act while a configure is in flight.
async function installObsStub(page) {
    const obs = {
        mode: 'down',
        connections: [],
        streaming: false,
        held: [],
        get live() {
            return obs.connections.filter((connection) => !connection.closed);
        },
        release() {
            for (const reply of obs.held.splice(0)) reply();
        },
    };
    await page.routeWebSocket(/:4455\/?$/, (ws) => {
        const connection = { mode: obs.mode, messages: [], closed: false };
        obs.connections.push(connection);
        ws.onClose(() => { connection.closed = true; });
        if (obs.mode === 'down') {
            connection.closed = true;
            ws.close({ code: 1011, reason: 'OBS is not running' });
            return;
        }
        ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '30.2.0', rpcVersion: 1 } }));
        ws.onMessage((raw) => {
            const message = JSON.parse(String(raw));
            if (message.op === 1) {
                ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
                return;
            }
            if (message.op !== 6) return;
            const { requestType, requestId } = message.d;
            connection.messages.push(requestType);
            const reply = () => {
                if (connection.closed) return;
                if (requestType === 'StartStream') obs.streaming = true;
                if (requestType === 'StopStream') obs.streaming = false;
                ws.send(JSON.stringify({
                    op: 7,
                    d: {
                        requestType,
                        requestId,
                        requestStatus: { result: true, code: 100 },
                        responseData: requestType === 'GetStreamStatus'
                            ? { outputActive: obs.streaming, outputReconnecting: false }
                            : {},
                    },
                }));
            };
            if (connection.mode === 'hold' && requestType === 'SetStreamServiceSettings') {
                obs.held.push(reply);
            } else {
                reply();
            }
        });
    });
    return obs;
}

// Starts sharing in OBS mode against the stub. Applying OBS settings is off so
// that the configure is a short exchange. Resolves once the start's own
// control channel attempt has been reported, the failure the next steps build on.
async function startObsSharing(page, baseUrl) {
    await page.goto(`${baseUrl}/#host`);
    await page.locator('#obsMode').check();
    await page.locator('#obsApplySettings').uncheck();
    const channelFailed = page.waitForEvent('console', (message) => (
        message.text().includes('OBS control channel unavailable')
    ));
    await page.getByRole('button', { name: 'Start Sharing' }).click();
    await channelFailed;
    await expect(page.getByRole('alert').filter({ hasText: /OBS WebSocket/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry Auto-Configure OBS' })).toBeVisible();
}

test('Retry Auto-Configure OBS opens a control channel that pagehide stops OBS through', async ({ page }) => {
    const obs = await installObsStub(page);
    await startObsSharing(page, server.baseUrl);
    // OBS was unreachable for the start: its configure and its channel both failed.
    expect(obs.connections.length).toBe(2);
    expect(obs.live).toHaveLength(0);

    obs.mode = 'up';
    await page.getByRole('button', { name: 'Retry Auto-Configure OBS' }).click();
    await expect(page.locator('.obs-status-line.is-ok')).toContainText('OBS configured');

    // The retry's configure connection has ended; one connection stays open, and
    // that is what the unload handler can still write to.
    await expect.poll(() => obs.live.length, { message: 'open OBS connections after the retry' }).toBe(1);
    const [channel] = obs.live;
    const connectionsBefore = obs.connections.length;

    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

    await expect.poll(() => channel.messages.at(-1), { message: 'last request on the control channel' }).toBe('StopStream');
    expect(obs.connections.length, 'connections opened by the teardown').toBe(connectionsBefore);
});

test('a control channel that never opened does not stand in the way of the stopObsStream fallback', async ({ page }) => {
    const obs = await installObsStub(page);
    await startObsSharing(page, server.baseUrl);
    const connectionsBefore = obs.connections.length;

    await page.getByRole('button', { name: 'Stop Sharing' }).click();

    // With the dead channel still in the ref, Stop would hand the stop to it and
    // open nothing; the fallback is a fresh connection to OBS.
    await expect.poll(() => obs.connections.length, { message: 'connections opened by Stop' }).toBe(connectionsBefore + 1);
});

test('a Retry that ends after Stop Sharing opens no control channel', async ({ page }) => {
    const obs = await installObsStub(page);
    await startObsSharing(page, server.baseUrl);

    obs.mode = 'hold';
    await page.getByRole('button', { name: 'Retry Auto-Configure OBS' }).click();
    await expect.poll(() => obs.held.length, { message: 'retry reached the stream-service write' }).toBe(1);

    const connectionsBeforeStop = obs.connections.length;
    await page.getByRole('button', { name: 'Stop Sharing' }).click();
    // Stop reaches OBS through a fresh connection: the retry has not given it a channel.
    await expect.poll(() => obs.connections.length, { message: 'connections opened by Stop' }).toBe(connectionsBeforeStop + 1);
    obs.mode = 'up';
    const connectionsBeforeRelease = obs.connections.length;
    const retryConnection = obs.connections.find((connection) => connection.mode === 'hold');
    obs.release();
    // The retry runs to its end; nothing of it may outlive the session.
    await expect.poll(() => retryConnection.closed, { message: 'retry connection ended' }).toBe(true);
    await page.waitForTimeout(500);

    expect(obs.connections.length, 'connections opened after the retry ended').toBe(connectionsBeforeRelease);
    expect(obs.live).toHaveLength(0);
});
