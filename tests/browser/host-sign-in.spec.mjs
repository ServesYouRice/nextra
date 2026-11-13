import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientBuildDir } from './clientBuild.mjs';

const require = createRequire(import.meta.url);
const { claimServerPorts } = require('../serverPorts.js');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOST_PASSWORD = 'host-sign-in-browser-password-0123456789abcdef';
// The browsers map this name to 127.0.0.1 (playwright.config.mjs). A page opened under it is addressed to the
// server's SHARE_BASE_URL, so the server sees it as a host on another computer, not as the local operator.
const REMOTE_HOST = 'nextra.cloudflare.test';

// The host sign-in needs a server with a host password (OPERATOR_TOKEN), which the shared Playwright web server
// does not have. So the spec starts its own on ports it claims: one over HTTPS, where a remote host can sign in,
// and one over plain HTTP, where the page must refuse to send the password. Both serve the same build as the
// shared web server unless NEXTRA_TEST_DIST_DIR names another (clientBuildDir refuses a dist older than the
// client source). The shared server, which has no host password, shows the "switched off" note.
let secureServer = null;
let plainServer = null;

// Where the environment routes HTTPS through a proxy (HTTPS_PROXY), Chromium would hand requests for REMOTE_HOST
// to it, and no proxy can reach a name that only this browser maps to 127.0.0.1. A context's own proxy settings
// replace the environment's, and their bypass list sends REMOTE_HOST and 127.0.0.1 direct. The pages request
// nothing else, so the proxy named here (the discard port) is never contacted.
test.use({ proxy: { server: 'http://127.0.0.1:9', bypass: `${REMOTE_HOST},127.0.0.1` } });

function request(url, method = 'GET') {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https:') ? https : http;
        const req = client.request(url, { method, rejectUnauthorized: false }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.once('error', reject);
        req.end();
    });
}

async function startServer({ secure }) {
    const distDir = clientBuildDir(projectRoot);
    const { port, rtcPort } = await claimServerPorts();
    const scheme = secure ? 'https' : 'http';
    let output = '';
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
            LOCAL_HTTPS: secure ? 'true' : 'false',
            OPEN_BROWSER: 'false',
            AUTO_DETECT_PUBLIC_IP: 'false',
            AUTO_PUBLIC_TUNNEL: 'false',
            CLOUDFLARED_TUNNEL_TOKEN: '',
            SHARE_BASE_URL: `${scheme}://${REMOTE_HOST}:${port}`,
            OPERATOR_TOKEN: HOST_PASSWORD,
            TRUSTED_LAN_CIDRS: '',
            TRUSTED_PROXY_CIDRS: '',
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
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });

    const localUrl = `${scheme}://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})\n${output}`);
        if (Date.now() > deadline) throw new Error(`server was not ready in time\n${output}`);
        try {
            if ((await request(`${localUrl}/readyz`)).status === 200) break;
        } catch { /* not listening yet */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { child, localUrl, remoteUrl: `${scheme}://${REMOTE_HOST}:${port}`, getOutput: () => output };
}

async function stopServer(server) {
    if (!server || server.child.exitCode !== null) return;
    const exited = new Promise((resolve) => server.child.once('exit', resolve));
    try {
        await request(`${server.localUrl}/api/test/shutdown`, 'POST');
    } catch {
        server.child.kill();
    }
    const timer = setTimeout(() => server.child.kill(), 7_000);
    await exited;
    clearTimeout(timer);
}

test.beforeAll(async () => {
    [secureServer, plainServer] = await Promise.all([startServer({ secure: true }), startServer({ secure: false })]);
});

test.afterAll(async () => {
    await Promise.all([stopServer(secureServer), stopServer(plainServer)]);
});

// A capture the page gets without a picker, so Start Sharing can go through.
async function installDisplayCapture(page) {
    await page.addInitScript(() => {
        const createCapture = () => {
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 360;
            const context = canvas.getContext('2d');
            let frame = 0;
            const draw = () => {
                frame += 1;
                context.fillStyle = `hsl(${frame % 360} 80% 45%)`;
                context.fillRect(0, 0, canvas.width, canvas.height);
                window.setTimeout(draw, 33);
            };
            draw();
            return canvas.captureStream(30);
        };
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getDisplayMedia: async () => createCapture() },
        });
    });
}

const passwordField = (page) => page.getByLabel('Host password');
const signInButton = (page) => page.getByRole('button', { name: 'Sign in', exact: true });
const startButton = (page) => page.getByRole('button', { name: 'Start Sharing' });
const signOutButton = (page) => page.getByRole('button', { name: 'Sign out' });

async function openRemoteHostPage(page, server = secureServer) {
    await page.goto(`${server.remoteUrl}/#host`);
    await expect(page.getByRole('heading', { name: 'Host sign-in' })).toBeVisible();
}

async function signIn(page) {
    await passwordField(page).fill(HOST_PASSWORD);
    await signInButton(page).click();
    await expect(startButton(page)).toBeVisible();
}

const readConfig = (page) => page.evaluate(async () => (await fetch('/api/config', { cache: 'no-store' })).json());

test('a host on the machine running Nextra sees the host page as before, with a host password set', async ({ page }) => {
    await page.goto(`${secureServer.localUrl}/#host`);
    await expect(startButton(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByText('You\'ll choose a screen, window or tab next.')).toBeVisible();
    const config = await readConfig(page);
    expect(config.operatorAuthorized).toBe(true);
    expect(config.operatorSignInAvailable).toBe(false);
    expect(config.operatorSession).toBe(false);
    // Nothing of the sign-in shows, now or once the config has been read.
    await expect(passwordField(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Host sign-in' })).toHaveCount(0);
    await expect(signOutButton(page)).toHaveCount(0);
    await expect(page.getByText('Signed in with the host password.')).toHaveCount(0);
});

test('a host on another computer gets the sign-in panel instead of the start controls', async ({ page }) => {
    await openRemoteHostPage(page);

    const field = passwordField(page);
    await expect(field).toBeVisible();
    await expect(field).toHaveAttribute('type', 'password');
    await expect(field).toHaveAttribute('autocomplete', 'current-password');
    await expect(page.locator('label[for="hostPassword"]')).toHaveText('Host password');
    await expect(signInButton(page)).toBeEnabled();
    // One visible field: the name a password manager files it under is not shown.
    await expect(page.locator('.host-sign-in input:visible')).toHaveCount(1);
    // The panel replaces the start controls and the room settings.
    await expect(startButton(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Resolution' })).toHaveCount(0);
    await expect(signOutButton(page)).toHaveCount(0);
    await expect(page.getByText('Sign in with the host password to start sharing from this computer.')).toBeVisible();
    // Loading the page does not move focus into the field.
    expect(await page.evaluate(() => document.activeElement?.id || '')).not.toBe('hostPassword');
    // The rest of the app is still there for a visitor.
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Watch' })).toBeVisible();
});

test('a wrong or missing password is refused with an announced message and focus stays in the field', async ({ page }) => {
    await openRemoteHostPage(page);
    const field = passwordField(page);

    await signInButton(page).click();
    const alert = page.locator('#hostSignInError');
    await expect(alert).toHaveText('Enter the host password.');
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveAttribute('aria-describedby', 'hostSignInError');

    // Typing clears the message; Enter submits.
    await field.fill('definitely-not-the-host-password');
    await expect(alert).toHaveCount(0);
    await expect(field).not.toHaveAttribute('aria-invalid', 'true');
    await field.press('Enter');
    await expect(alert).toHaveText('That is not the host password. Check it and try again.');
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    // The rejected text is selected, so typing replaces it.
    expect(await field.evaluate((input) => input.selectionEnd - input.selectionStart)).toBe('definitely-not-the-host-password'.length);
    await expect(signInButton(page)).toBeEnabled();
    await expect(startButton(page)).toHaveCount(0);
    expect((await page.context().cookies()).filter((cookie) => cookie.name === 'nextra_host')).toEqual([]);
});

test('too many attempts and an HTTPS refusal are explained, with the time to try again', async ({ page }) => {
    await openRemoteHostPage(page);
    // The server's answers are stood in for here, so this test does not use up the real failure budget that the
    // other tests' browser shares (the real limits are tested in tests/operatorSignIn.test.js).
    let answer = { status: 429, headers: { 'retry-after': '420' }, body: { error: 'too_many_attempts', retryAfterSeconds: 420 } };
    const sent = [];
    await page.route('**/api/operator/session', (route) => {
        sent.push(route.request().postDataJSON());
        return route.fulfill({ status: answer.status, headers: answer.headers, contentType: 'application/json', body: JSON.stringify(answer.body) });
    });
    const field = passwordField(page);
    const alert = page.locator('#hostSignInError');

    await field.fill('a-guess');
    await signInButton(page).click();
    await expect(alert).toHaveText('Too many sign-in attempts. Try again in about 7 minutes.');
    await expect(field).toBeFocused();

    answer = { status: 400, headers: {}, body: { error: 'https_required' } };
    await field.fill('another-guess');
    await signInButton(page).click();
    await expect(alert).toHaveText('Signing in needs HTTPS, so the host password is never sent unencrypted. Open this page with https:// and try again.');
    expect(sent).toEqual([{ password: 'a-guess' }, { password: 'another-guess' }]);
    await expect(startButton(page)).toHaveCount(0);
});

test('signing in shows the host page, keeps the password out of script-readable storage, and lets the host create a room', async ({ page, context }) => {
    await installDisplayCapture(page);
    await openRemoteHostPage(page);
    await passwordField(page).fill(HOST_PASSWORD);
    await passwordField(page).press('Enter');

    // The normal host page, with focus on the control that replaced the field.
    await expect(startButton(page)).toBeVisible();
    await expect(startButton(page)).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Host sign-in' })).toHaveCount(0);
    await expect(passwordField(page)).toHaveCount(0);
    await expect(signOutButton(page)).toBeVisible();
    await expect(page.getByText('Signed in with the host password.')).toBeVisible();

    const config = await readConfig(page);
    expect(config.operatorAuthorized).toBe(true);
    expect(config.operatorSession).toBe(true);

    // The session is an HttpOnly, Secure, SameSite=Strict cookie of about 12 hours.
    const cookies = (await context.cookies()).filter((cookie) => cookie.name === 'nextra_host');
    expect(cookies).toHaveLength(1);
    const [cookie] = cookies;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(cookie.path).toBe('/');
    expect(cookie.domain).toBe(REMOTE_HOST);
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const lifetimeSeconds = cookie.expires - Date.now() / 1000;
    expect(lifetimeSeconds).toBeGreaterThan(43_200 - 120);
    expect(lifetimeSeconds).toBeLessThanOrEqual(43_200 + 5);

    // Nothing page script can read holds the password or the session id.
    const readable = await page.evaluate(() => JSON.stringify({
        cookie: document.cookie,
        local: Object.entries(window.localStorage),
        session: Object.entries(window.sessionStorage),
        url: window.location.href,
    }));
    expect(readable).not.toContain(HOST_PASSWORD);
    expect(readable).not.toContain(cookie.value);
    expect(readable).not.toContain('nextra_host');

    // The reconnected socket carries the session: the server lets this host create a room.
    await startButton(page).click();
    await expect(page.getByText(/Streaming \(/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop Sharing' })).toBeVisible();
    await expect(page.locator('.copy-field', { hasText: 'Local Link' })).toBeVisible();
    // While a room is shared the sign-out control is out of the way.
    await expect(signOutButton(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Stop Sharing' }).click();
    await expect(startButton(page)).toBeVisible();
    await expect(signOutButton(page)).toBeVisible();

    // Neither secret reached the server's log.
    expect(secureServer.getOutput()).not.toContain(HOST_PASSWORD);
    expect(secureServer.getOutput()).not.toContain(cookie.value);
});

test('the session survives a reload, and Sign out returns to the panel', async ({ page, context }) => {
    await openRemoteHostPage(page);
    await signIn(page);

    await page.reload();
    await expect(startButton(page)).toBeVisible();
    await expect(signOutButton(page)).toBeVisible();
    await expect(passwordField(page)).toHaveCount(0);
    // A reload moves no focus.
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');

    await signOutButton(page).click();
    await expect(page.getByRole('heading', { name: 'Host sign-in' })).toBeVisible();
    await expect(passwordField(page)).toBeFocused();
    await expect(passwordField(page)).toHaveValue('');
    await expect(startButton(page)).toHaveCount(0);
    await expect(signOutButton(page)).toHaveCount(0);
    expect((await context.cookies()).filter((cookie) => cookie.name === 'nextra_host')).toEqual([]);
    const config = await readConfig(page);
    expect(config.operatorAuthorized).toBe(false);
    expect(config.operatorSession).toBe(false);

    // And the host can sign in again.
    await signIn(page);
    await expect(signOutButton(page)).toBeVisible();
});

test('a session that ended while the page was open brings the panel back when a start is refused', async ({ page }) => {
    await installDisplayCapture(page);
    await openRemoteHostPage(page);
    await signIn(page);

    // The session ends without this view hearing of it: a sign-out in another tab, or 12 hours passing.
    const ended = await page.evaluate(async () => (await fetch('/api/operator/session', { method: 'DELETE' })).status);
    expect(ended).toBe(204);
    await expect(startButton(page)).toBeVisible();

    await startButton(page).click();
    await expect(page.getByRole('heading', { name: 'Host sign-in' })).toBeVisible();
    await expect(passwordField(page)).toBeFocused();
    await expect(startButton(page)).toHaveCount(0);
    await expect(page.locator('.host-layout > [role="alert"]')).toContainText('Operator authorization is required');

    // Signing in again restores the host page and the start works.
    await signIn(page);
    await startButton(page).click();
    await expect(page.getByText(/Streaming \(/)).toBeVisible();
    await page.getByRole('button', { name: 'Stop Sharing' }).click();
    await expect(startButton(page)).toBeVisible();
});

test('on a plain-HTTP page the form is disabled and no password is sent', async ({ page }) => {
    const sessionRequests = [];
    page.on('request', (req) => {
        if (req.url().includes('/api/operator/session')) sessionRequests.push(req.method());
    });
    await openRemoteHostPage(page, plainServer);

    await expect(page.locator('#hostSignInHttps')).toHaveText('Signing in needs HTTPS, so the host password is never sent unencrypted. Open this page with https:// and try again.');
    await expect(passwordField(page)).toBeDisabled();
    await expect(passwordField(page)).toHaveAttribute('aria-describedby', 'hostSignInHttps');
    await expect(signInButton(page)).toBeDisabled();
    // A submit forced past the disabled button still sends nothing.
    await page.evaluate(() => {
        const form = document.querySelector('form.host-sign-in');
        form.querySelector('#hostPassword').disabled = false;
        form.querySelector('#hostPassword').value = 'typed-anyway';
        form.requestSubmit();
    });
    await expect(page.locator('#hostSignInError')).toHaveText('Signing in needs HTTPS, so the host password is never sent unencrypted. Open this page with https:// and try again.');
    expect(sessionRequests).toEqual([]);
    await expect(startButton(page)).toHaveCount(0);
});

test('without a host password the page says hosting from another computer is off and how to turn it on', async ({ page }, testInfo) => {
    // The shared web server has no OPERATOR_TOKEN.
    const sharedPort = new URL(testInfo.project.use.baseURL).port;
    await page.goto(`https://${REMOTE_HOST}:${sharedPort}/#host`);

    const panel = page.locator('.host-sign-in');
    await expect(panel.getByRole('heading', { name: 'Hosting is off for this computer' })).toBeVisible();
    await expect(panel).toContainText('Hosting from another computer is switched off on this server.');
    await expect(panel).toContainText('OPERATOR_TOKEN');
    await expect(passwordField(page)).toHaveCount(0);
    await expect(signInButton(page)).toHaveCount(0);
    await expect(startButton(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0);
    await expect(page.getByText('Rooms can only be started on the computer that runs Nextra.').first()).toBeVisible();

    // The note links to the How-to page, which explains the host password.
    await panel.getByRole('link', { name: 'How to Use' }).click();
    await expect(page.getByRole('heading', { name: 'How to use Nextra' })).toBeVisible();
    await expect(page.getByText('Hosting from another computer:')).toBeVisible();
});

test('the sign-in panel fits a phone and a desktop without horizontal overflow', async ({ page }) => {
    for (const width of [320, 375, 900, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await openRemoteHostPage(page);
        const overflow = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
        }));
        expect(overflow.scrollWidth, `page overflows at ${width}px`).toBeLessThanOrEqual(overflow.clientWidth);
        const panelBox = await page.locator('.host-sign-in').boundingBox();
        expect(panelBox.x, `panel starts off-screen at ${width}px`).toBeGreaterThanOrEqual(0);
        expect(panelBox.x + panelBox.width, `panel ends off-screen at ${width}px`).toBeLessThanOrEqual(width);
        const buttonBox = await signInButton(page).boundingBox();
        expect(buttonBox.height, `Sign in is too short to tap at ${width}px`).toBeGreaterThanOrEqual(32);
    }
});
