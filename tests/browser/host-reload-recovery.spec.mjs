import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientBuildDir } from './clientBuild.mjs';

const require = createRequire(import.meta.url);
const { claimServerPorts } = require('../serverPorts.js');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RECOVERY_KEY = 'nextra.hostRecovery.v1';

// A page that was reloaded reclaims the room kept in sessionStorage. These
// tests seed that record by hand and decide what the reclaim meets: the real
// server (which rejects a room it never had, with terminal: true), or a
// connection the test drops. The spec starts its own server on ports it claims
// and serves the same build as the shared web server unless
// NEXTRA_TEST_DIST_DIR names another (clientBuildDir refuses a dist older than
// the client source).
let server = null;
let serverOutput = '';

async function startServer() {
    const distDir = clientBuildDir(projectRoot);
    const { port, rtcPort } = await claimServerPorts();
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
            WHIP_ENABLED: 'false',
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
        try {
            if ((await fetch(`${baseUrl}/readyz`)).ok) break;
        } catch { /* not listening yet */ }
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

// The record a reloading page leaves behind, put into sessionStorage before
// the page's own scripts run.
async function seedRecoverySession(page, ingestMode) {
    const session = { code: 'ABCDEF', hostToken: 'a'.repeat(32), ingestMode };
    await page.addInitScript(([key, value]) => {
        window.sessionStorage.setItem(key, value);
    }, [RECOVERY_KEY, JSON.stringify(session)]);
    return session;
}

const readRecoveryRecord = (page) => page.evaluate((key) => window.sessionStorage.getItem(key), RECOVERY_KEY);

// Sits between the page's Socket.IO connection and the server. Every
// reclaim-host the page sends is counted, and `decide(n)` says what happens to
// the n-th: 'forward' (the server answers), 'drop' (the connection is cut right
// after the emit, as a timeout or a lost link would) or 'accept' (the test
// answers like a server that still holds the room).
async function routeSocket(page, decide) {
    const reclaims = [];
    await page.routeWebSocket(/\/socket\.io\//, (ws) => {
        const upstream = ws.connectToServer();
        ws.onMessage((raw) => {
            const text = typeof raw === 'string' ? raw : raw.toString();
            const match = /^42(\d*)\["reclaim-host",(.*)\]$/s.exec(text);
            if (!match) {
                upstream.send(raw);
                return;
            }
            const payload = JSON.parse(match[2]);
            reclaims.push(payload);
            const action = decide(reclaims.length);
            if (action === 'forward') {
                upstream.send(raw);
            } else if (action === 'accept') {
                ws.send(`43${match[1]}${JSON.stringify([{
                    success: true,
                    code: 'host-reconnected',
                    reason: 'Host reconnected.',
                    recoverable: true,
                    terminal: false,
                    ingestMode: 'browser',
                    hasRoomTurnServer: false,
                    reloadRecoveryEnabled: true,
                }])}`);
            } else {
                ws.close({ code: 3001, reason: 'test: connection dropped' });
                upstream.close({ code: 1000 });
            }
        });
    });
    return reclaims;
}

// A stand-in for OBS's obs-websocket server on its default port that records
// every request it is sent.
async function installObsStub(page) {
    const obs = { connections: [], requests: [] };
    await page.routeWebSocket(/:4455\/?$/, (ws) => {
        obs.connections.push(ws);
        ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '30.2.0', rpcVersion: 1 } }));
        ws.onMessage((raw) => {
            const message = JSON.parse(String(raw));
            if (message.op === 1) {
                ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
                return;
            }
            if (message.op !== 6) return;
            const { requestType, requestId } = message.d;
            obs.requests.push(requestType);
            ws.send(JSON.stringify({
                op: 7,
                d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData: {} },
            }));
        });
    });
    return obs;
}

test('a reclaim cut off twice by the connection is retried and the stored room is resumed', async ({ page }) => {
    await seedRecoverySession(page, 'browser');
    // The first two attempts lose the connection after the emit. The page's own
    // request retry spends one of them; the third reaches the server.
    const reclaims = await routeSocket(page, (n) => (n <= 2 ? 'drop' : 'accept'));

    await page.goto(`${server.baseUrl}/#host`);

    await expect(page.getByRole('button', { name: 'Resume Sharing' })).toBeVisible({ timeout: 20_000 });
    expect(reclaims.length, 'reclaim-host requests the page sent').toBe(3);
    expect(reclaims.every((payload) => payload.reloadRecovery === true && payload.code === 'ABCDEF')).toBe(true);
    // The record survived the failures: a further reload can still reclaim.
    expect(JSON.parse(await readRecoveryRecord(page))).toMatchObject({ code: 'ABCDEF', ingestMode: 'browser' });
    await expect(page.getByText(/room ended/i)).toHaveCount(0);
});

test('a reclaim the server rejects as terminal ends the session at once and clears the record', async ({ page }) => {
    await seedRecoverySession(page, 'browser');
    const obs = await installObsStub(page);
    const reclaims = await routeSocket(page, () => 'forward');

    await page.goto(`${server.baseUrl}/#host`);

    await expect(page.getByRole('button', { name: 'Create new room' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('alert')).toContainText('Room reclaim was rejected.');
    expect(reclaims.length, 'a terminal rejection is not retried').toBe(1);
    expect(await readRecoveryRecord(page)).toBeNull();
    // A browser-mode room has nothing in OBS to stop.
    await page.waitForTimeout(500);
    expect(obs.connections).toHaveLength(0);
});

test('a stored OBS room that cannot be reclaimed stops OBS even though the page starts in browser mode', async ({ page }) => {
    await seedRecoverySession(page, 'obs');
    const obs = await installObsStub(page);
    await routeSocket(page, () => 'forward');

    await page.goto(`${server.baseUrl}/#host`);

    await expect(page.getByRole('button', { name: 'Create new room' })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => obs.requests, { message: 'requests OBS received', timeout: 10_000 }).toContain('StopStream');
    expect(await readRecoveryRecord(page)).toBeNull();
});

test('leaving the host page during the pause between reclaim attempts sends no further attempt', async ({ page }) => {
    await seedRecoverySession(page, 'browser');
    const reclaims = await routeSocket(page, () => 'drop');

    await page.goto(`${server.baseUrl}/#host`);
    await expect.poll(() => reclaims.length, { message: 'reclaim attempts', timeout: 20_000 }).toBeGreaterThanOrEqual(2);

    await page.evaluate(() => { window.location.hash = '#privacy'; });
    await expect(page.getByRole('heading', { name: /Privacy/i })).toBeVisible();
    // The unmount teardown runs one task after the view is removed.
    await page.waitForTimeout(250);
    const sent = reclaims.length;
    // Longer than the pauses between attempts and a reconnect.
    await page.waitForTimeout(6_000);

    expect(reclaims.length, 'attempts sent after the host view was left').toBe(sent);
});
