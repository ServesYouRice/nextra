import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientBuildDir } from './clientBuild.mjs';

const require = createRequire(import.meta.url);
const { claimServerPorts } = require('../serverPorts.js');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The invite card a host sees while sharing: the room code, one row per link
// (public, local, player), each with its own copy button, the link to share
// marked, and the card as tall as the preview. The shared server has a public
// and a local link; two servers of this spec's own show three links (WHEP on)
// and one (no public link). Each server gets one room, which the test ends.
// Every server here listens on this computer only, so its local link is a
// localhost link: the card says so and never marks it as the one to share.

// A canvas capture stub in place of the screen picker, as in ui-semantics.
async function useFakeScreenShare(page) {
    await page.addInitScript(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext('2d');
        const draw = () => {
            context.fillStyle = `hsl(${Date.now() % 360} 80% 45%)`;
            context.fillRect(0, 0, canvas.width, canvas.height);
            window.setTimeout(draw, 33);
        };
        draw();
        const stream = canvas.captureStream(30);
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getDisplayMedia: async () => stream },
        });
    });
}

async function startSharing(page, url) {
    await useFakeScreenShare(page);
    await page.goto(url);
    await page.getByRole('button', { name: 'Start Sharing' }).click();
    await expect(page.getByText(/Streaming \(/)).toBeVisible();
    await expect(page.locator('.invite-card')).toBeVisible();
}

async function stopSharingAndWaitForNoRooms(page, metricsUrl) {
    await page.getByRole('button', { name: 'Stop Sharing' }).click();
    const confirmStopButton = page.getByRole('dialog').getByRole('button', { name: 'Stop Sharing' });
    if (await confirmStopButton.isVisible()) await confirmStopButton.click();
    await expect.poll(async () => (await (await page.request.get(metricsUrl)).json()).rooms.active).toBe(0);
}

function linkRow(page, label) {
    return page.locator('.invite-link', { has: page.locator('.copy-field-label', { hasText: label }) });
}

async function readClipboard(page) {
    return page.evaluate(() => navigator.clipboard.readText());
}

// The card's and the preview's top and bottom at the current viewport size.
async function expectCardEdgesMatchPreview(page, label) {
    // Let the layout settle after a viewport change.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const card = await page.locator('.invite-card').boundingBox();
    const stage = await page.locator('.video-container').boundingBox();
    console.log(`[host-live] ${label}: card top ${card.y.toFixed(1)} bottom ${(card.y + card.height).toFixed(1)}; `
        + `preview top ${stage.y.toFixed(1)} bottom ${(stage.y + stage.height).toFixed(1)}`);
    expect(Math.abs(card.y - stage.y), `${label}: top edges`).toBeLessThanOrEqual(1);
    expect(Math.abs((card.y + card.height) - (stage.y + stage.height)), `${label}: bottom edges`).toBeLessThanOrEqual(1);
    expect(card.x, `${label}: the card is beside the preview`).toBeGreaterThan(stage.x + stage.width);
}

async function expectLinksOnOneLine(page) {
    const values = page.locator('.invite-link .copy-field-value');
    const count = await values.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
        const { height, lineHeight } = await values.nth(index).evaluate((element) => ({
            height: element.getBoundingClientRect().height,
            lineHeight: parseFloat(getComputedStyle(element).lineHeight),
        }));
        expect(height, `link ${index + 1} takes one line`).toBeLessThan(lineHeight * 2);
    }
}

async function rowLabels(page) {
    return page.locator('.invite-link .copy-field-label').allInnerTexts();
}

test.describe('on the shared server: a public and a local link', () => {
    test('the invite card shows the code, marks the public link and copies every value', async ({ browser }, testInfo) => {
        const baseURL = testInfo.project.use.baseURL;
        const context = await browser.newContext({
            baseURL,
            ignoreHTTPSErrors: true,
            viewport: { width: 1440, height: 900 },
            permissions: ['clipboard-read', 'clipboard-write'],
        });
        const page = await context.newPage();
        try {
            await startSharing(page, '/#host');
            const card = page.locator('.invite-card');
            await expect(page.getByRole('heading', { name: 'Invite viewers' })).toBeVisible();

            const localRow = linkRow(page, 'Local link');
            const publicRow = linkRow(page, 'Public link');
            const localLink = await localRow.locator('.copy-field-value').innerText();
            const publicLink = await publicRow.locator('.copy-field-value').innerText();
            expect(localLink).not.toContain('\n');
            const code = localLink.split('#watch/')[1];
            expect(code).toMatch(/^[A-Z0-9]{6}$/);
            expect(localLink).toContain(`#watch/${code}`);
            expect(publicLink).toContain(`#watch/${code}`);

            const shownCode = await card.locator('.invite-code .copy-field-value').innerText();
            expect(shownCode).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
            expect(shownCode.replace('-', '')).toBe(code);

            expect(await rowLabels(page)).toEqual(['Public link', 'Local link · this computer only']);
            await expect(card.getByText('Share this', { exact: true })).toHaveCount(1);
            await expect(publicRow.getByText('Share this', { exact: true })).toBeVisible();

            // The existing specs read the code from this label and value.
            await expect(page.locator('.copy-field', { hasText: 'Local Link' })).toHaveCount(1);
            await expect(page.getByText('Local Link')).toBeVisible();

            // Each row copies with its own small button; the card has no large one.
            await expect(page.locator('.btn-main')).toHaveCount(0);
            await expect(card.getByRole('button', { name: 'Copy link', exact: true })).toHaveCount(0);
            await expect(card.locator('.copy-field-copy')).toHaveCount(3);
            await expect(card.locator('.invite-link-recommended')).toHaveCount(1);
            await expect(publicRow).toHaveClass(/invite-link-recommended/);
            await publicRow.getByRole('button', { name: 'Copy public link' }).click();
            await expect.poll(() => readClipboard(page)).toBe(publicLink);
            await expect(publicRow.locator('.copy-field-feedback')).toHaveText('Copied!');

            // A label sits clear of its value, and the rows clear of each other.
            const gaps = await card.evaluate((el) => {
                const top = (node) => node.getBoundingClientRect().top;
                const bottom = (node) => node.getBoundingClientRect().bottom;
                const row = el.querySelector('.invite-link');
                return {
                    codeLabelToValue: top(el.querySelector('.invite-code .copy-field-value'))
                        - bottom(el.querySelector('.invite-code .copy-field-top')),
                    linkLabelToValue: top(row.querySelector('.copy-field-value')) - bottom(row.querySelector('.copy-field-top')),
                    rowPadding: parseFloat(getComputedStyle(row).paddingTop),
                };
            });
            expect(gaps.codeLabelToValue).toBeGreaterThanOrEqual(6);
            expect(gaps.linkLabelToValue).toBeGreaterThanOrEqual(6);
            expect(gaps.rowPadding).toBeGreaterThanOrEqual(14);
            const copyBox = await card.locator('.copy-field-copy').first().boundingBox();
            expect(copyBox.height).toBeGreaterThanOrEqual(36);

            await page.getByRole('button', { name: 'Copy local link' }).click();
            await expect.poll(() => readClipboard(page)).toBe(localLink);
            await page.getByRole('button', { name: 'Copy room code' }).click();
            await expect.poll(() => readClipboard(page)).toBe(shownCode);
            await page.getByRole('button', { name: 'Copy public link' }).click();
            await expect.poll(() => readClipboard(page)).toBe(publicLink);

            await expectLinksOnOneLine(page);
            await expectCardEdgesMatchPreview(page, '1440x900');

            // The status line: Live, a running time and the viewer count.
            const liveStatus = page.locator('.live-status');
            await expect(liveStatus).toContainText('Live');
            const timer = liveStatus.locator('.live-timer');
            await expect(timer).toHaveText(/\d+:\d{2}/);
            const firstTime = await timer.innerText();
            await page.waitForTimeout(2000);
            await expect.poll(() => timer.innerText()).not.toBe(firstTime);
            await expect(page.locator('.viewer-count')).toHaveText('0 viewers');
            await expect(page.locator('.status-bar')).toHaveCount(0);
            await expect(page.locator('.visually-hidden[role="status"]', { hasText: 'Streaming (' })).toHaveCount(1);

            // Resolution and Frame rate are behind the quality button.
            const qualityButton = page.getByRole('button', { name: /^Quality/ });
            await expect(qualityButton).toBeVisible();
            await expect(page.getByRole('group', { name: 'Frame rate' })).toHaveCount(0);
            await qualityButton.click();
            await expect(page.getByRole('group', { name: 'Resolution' })).toBeVisible();
            await expect(page.getByRole('group', { name: 'Frame rate' })).toBeVisible();
            await page.getByRole('group', { name: 'Frame rate' }).getByRole('button', { name: '30 fps' }).click();
            await expect(qualityButton).toHaveText(/30 fps$/);
            await expect(page.locator('.visually-hidden[role="status"]', { hasText: 'Streaming (' })).toContainText('@ 30fps');
            await page.keyboard.press('Escape');
            await expect(page.getByRole('group', { name: 'Frame rate' })).toHaveCount(0);
            await expect(qualityButton).toBeFocused();

            // Stop is a quiet button under the card, as wide as the card.
            const stop = page.getByRole('button', { name: 'Stop Sharing' });
            await expect(stop).toHaveClass(/btn-danger-quiet/);
            const stopBox = await stop.boundingBox();
            const cardBox = await card.boundingBox();
            expect(stopBox.height).toBeGreaterThanOrEqual(44);
            expect(Math.abs(stopBox.x - cardBox.x), 'Stop and the card: left edges').toBeLessThanOrEqual(1);
            expect(Math.abs((stopBox.x + stopBox.width) - (cardBox.x + cardBox.width)), 'Stop and the card: right edges')
                .toBeLessThanOrEqual(1);
            expect(stopBox.y, 'Stop is under the card').toBeGreaterThanOrEqual(cardBox.y + cardBox.height);
            // Stop and the quality button are the two controls of one row: the
            // same height, starting and ending on the same lines.
            const qualityBox = await qualityButton.boundingBox();
            expect(Math.abs(qualityBox.y - stopBox.y), `quality top ${qualityBox.y} vs Stop top ${stopBox.y}`).toBeLessThanOrEqual(1);
            expect(Math.abs(qualityBox.height - stopBox.height), `quality ${qualityBox.height} vs Stop ${stopBox.height}`)
                .toBeLessThanOrEqual(1);
            const corners = await page.evaluate(() => ['.quality-button', '.host-stop']
                .map((selector) => getComputedStyle(document.querySelector(selector)).borderRadius));
            expect(corners[0]).toBe(corners[1]);

            await page.setViewportSize({ width: 1280, height: 720 });
            await expectLinksOnOneLine(page);
            await expectCardEdgesMatchPreview(page, '1280x720');

            await expect(page.getByText(/WebRTC consumers/)).toBeHidden();
            await expect(page.getByText(/Relay out/)).toBeHidden();
            await page.getByText('Troubleshooting diagnostics', { exact: true }).click();
            const diagnostics = page.locator('.host-diagnostics');
            await expect(diagnostics.getByText('WebRTC viewers connected', { exact: true })).toBeVisible();
            await expect(diagnostics.getByText('Relay sent', { exact: true })).toBeVisible();
            await page.getByText('Troubleshooting diagnostics', { exact: true }).click();

            await page.setViewportSize({ width: 390, height: 844 });
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const phoneCard = await card.boundingBox();
            const phoneStage = await page.locator('.video-container').boundingBox();
            expect(Math.abs(phoneCard.width - phoneStage.width), 'the card is as wide as the preview').toBeLessThanOrEqual(1);
            expect(Math.abs(phoneCard.x - phoneStage.x)).toBeLessThanOrEqual(1);
            expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
                .toBeLessThanOrEqual(0);
            await expectLinksOnOneLine(page);
            expect(await localRow.locator('.copy-field-value').innerText()).toBe(localLink);
            const copyButton = await page.getByRole('button', { name: 'Copy room code' }).boundingBox();
            expect(copyButton.width).toBeGreaterThanOrEqual(44);
            expect(copyButton.height).toBeGreaterThanOrEqual(44);

            // The status line, the quality button and Stop fit the phone.
            for (const [label, locator] of [
                ['the status line', liveStatus],
                ['the quality button', qualityButton],
                ['Stop', stop],
            ]) {
                const box = await locator.boundingBox();
                expect(box.x, `${label} starts inside the viewport`).toBeGreaterThanOrEqual(0);
                expect(box.x + box.width, `${label} ends inside the viewport`).toBeLessThanOrEqual(390);
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
                .toBeLessThanOrEqual(0);

            await stopSharingAndWaitForNoRooms(page, `${baseURL}/api/metrics`);
        } finally {
            await context.close();
        }
    });
});

// A server of this spec's own, as in host-reload-recovery: same build, its own
// ports, and the link settings under test.
async function startServer(linkEnv) {
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
            WHIP_ENABLED: 'false',
            RTC_LISTEN_IP: '127.0.0.1',
            RTC_MIN_PORT: String(rtcPort),
            RTC_MAX_PORT: String(rtcPort),
            NEXTRA_SMOKE_TEST: '1',
            NEXTRA_TEST_DIST_DIR: distDir,
            LOG_LEVEL: 'info',
            ...linkEnv,
        },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})\n${output}`);
        if (Date.now() > deadline) throw new Error(`server was not ready in time\n${output}`);
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

async function openHostContext(browser) {
    return browser.newContext({
        viewport: { width: 1440, height: 900 },
        permissions: ['clipboard-read', 'clipboard-write'],
    });
}

test.describe('on a server with WHEP on and a public address: three links', () => {
    let server = null;
    test.beforeAll(async () => {
        server = await startServer({
            WHEP_ENABLED: 'true',
            SHARE_BASE_URL: 'https://share.nextra.test',
            ALLOW_REMOTE_MEDIA_CONTROL: 'true',
        });
    });
    test.afterAll(async () => {
        if (server) await stopServer(server);
    });

    // This server allows remote pause/play, so the host gets the switch for it.
    test('the pause/play switch is a row of the panel where the server allows it', async ({ browser }) => {
        const context = await openHostContext(browser);
        const page = await context.newPage();
        try {
            await page.goto(`${server.baseUrl}/#host`);
            const media = page.getByLabel('Let viewers pause/play media');
            await expect(media).toBeVisible();
            await expect(media).toBeEnabled();
            await expect(media).not.toBeChecked();
            await expect(page.getByText('Disabled by the server operator')).toHaveCount(0);
            const body = await page.locator('.host-settings-body').evaluate((el) => ({
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
            }));
            expect(body.scrollHeight).toBeLessThanOrEqual(body.clientHeight + 1);
            await page.locator('#obsMode').check();
            await expect(media).toBeHidden();
            await page.locator('.host-more-options summary').click();
            await expect(media).toBeVisible();
        } finally {
            await context.close();
        }
    });

    test('the rows are public, local and player, and only the public row is marked', async ({ browser }) => {
        const context = await openHostContext(browser);
        const page = await context.newPage();
        try {
            await startSharing(page, `${server.baseUrl}/#host`);
            expect(await rowLabels(page)).toEqual([
                'Public link',
                'Local link · this computer only',
                'Player link · WHEP',
            ]);
            await expect(page.locator('.invite-card').getByText('Share this', { exact: true })).toHaveCount(1);
            await expect(linkRow(page, 'Public link').getByText('Share this', { exact: true })).toBeVisible();
            await expect(page.locator('.btn-main')).toHaveCount(0);
            await expect(page.locator('.invite-card .copy-field-copy')).toHaveCount(4);

            const playerRow = linkRow(page, 'Player link');
            const playerLink = await playerRow.locator('.copy-field-value').innerText();
            expect(playerLink).toMatch(/^https:\/\/share\.nextra\.test\/whep\/watch\/[A-Z0-9]{6}$/);
            await expect(playerRow.locator('.copy-field-label')).toHaveAttribute('title', /GStreamer and other WHEP-compatible players/);
            await expect(page.getByRole('button', { name: 'Copy player link' }))
                .toHaveAccessibleDescription(/GStreamer and other WHEP-compatible players/);
            await page.getByRole('button', { name: 'Copy player link' }).click();
            await expect.poll(() => readClipboard(page)).toBe(playerLink);

            await expectLinksOnOneLine(page);
            await expectCardEdgesMatchPreview(page, 'three links at 1440x900');
            await page.setViewportSize({ width: 1280, height: 720 });
            await expectCardEdgesMatchPreview(page, 'three links at 1280x720');

            await stopSharingAndWaitForNoRooms(page, `${server.baseUrl}/api/metrics`);
        } finally {
            await context.close();
        }
    });
});

test.describe('on a server with no public link and WHEP off: one link', () => {
    let server = null;
    test.beforeAll(async () => {
        server = await startServer({ WHEP_ENABLED: 'false', SHARE_BASE_URL: '' });
    });
    test.afterAll(async () => {
        if (server) await stopServer(server);
    });

    test('a localhost link is not marked as the one to share, and the card says nobody else can join', async ({ browser }) => {
        const context = await openHostContext(browser);
        const page = await context.newPage();
        try {
            await startSharing(page, `${server.baseUrl}/#host`);
            expect(await rowLabels(page)).toEqual(['Local link · this computer only']);
            const localRow = linkRow(page, 'Local link');
            await expect(localRow.locator('.copy-field-value')).toHaveText(/^http:\/\/localhost:\d+\/#watch\/[A-Z0-9]{6}$/);
            await expect(page.locator('.invite-card').getByText('Share this', { exact: true })).toHaveCount(0);
            await expect(page.locator('.invite-link-recommended')).toHaveCount(0);
            const copyLink = localRow.getByRole('button', { name: 'Copy local link' });
            await expect(page.locator('.btn-main')).toHaveCount(0);
            const note = page.locator('.invite-note');
            await expect(note).toHaveText(/^Nobody else can join yet: the local link only opens on this computer and there is no public link\./);
            await expect(page.getByText('Works for people on your network', { exact: false })).toHaveCount(0);

            const localLink = await localRow.locator('.copy-field-value').innerText();
            await copyLink.click();
            await expect.poll(() => readClipboard(page)).toBe(localLink);
            await expectCardEdgesMatchPreview(page, 'one link at 1440x900');

            await stopSharingAndWaitForNoRooms(page, `${server.baseUrl}/api/metrics`);
        } finally {
            await context.close();
        }
    });
});
