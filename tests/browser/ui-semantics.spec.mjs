import { test, expect } from '@playwright/test';

// Widths the README support table claims: small phone, common phone, tablet
// breakpoint, small laptop, laptop/desktop tiers, and wide desktop.
const REFLOW_WIDTHS = [320, 375, 640, 900, 1024, 1280, 1440, 1600, 2560];
const REFLOW_ROUTES = ['/', '/#watch', '/#how-to', '/#host', '/#status', '/#privacy', '/#copyright'];

// The host page is the densest layout: a video stage beside settings cards that
// grow again when OBS ingest is selected. These are the widths where the side
// panel used to squeeze the stage down to a thumbnail.
const HOST_OBS_WIDTHS = [1024, 1280, 1440, 1600];
const MIN_STAGE_WIDTH = 560;

// Going to '/#host' while already on '/#host' is a same-document navigation, so
// React never remounts and the previous ingest mode leaks into the next
// assertion. Routing via another view unmounts HostView and gives a clean one,
// without the socket churn a full document reload costs.
async function remountHost(page) {
    await page.goto('/#watch');
    await expect(page.locator('.join-form')).toBeVisible();
    await page.goto('/#host');
    await expect(page.locator('.host-side-panel')).toBeVisible();
}

// Selecting OBS ingest animates the panels over --transition-panel (420ms).
// Measuring before that settles reads a half-open layout, which is wider than
// the final one and hides exactly the regression these tests exist to catch.
async function settledBox(page, selector) {
    const locator = page.locator(selector);
    let previous = await locator.boundingBox();
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await page.waitForTimeout(100);
        const current = await locator.boundingBox();
        if (previous && current && Math.abs(current.width - previous.width) < 0.5) return current;
        previous = current;
    }
    return previous;
}

async function horizontalOverflow(page) {
    return page.evaluate(() => ({
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        innerWidth: window.innerWidth,
    }));
}

test('the room code field has a visible label, hint, invalid state, and busy state', async ({ page }) => {
    await page.goto('/#watch');

    const codeInput = page.getByLabel('Room code');
    await expect(codeInput).toBeVisible();
    await expect(page.locator('label[for="roomCode"]')).toHaveText('Room code');
    await expect(codeInput).toHaveAttribute('aria-describedby', 'joinHint');
    await expect(page.locator('#joinHint')).toHaveText(/6-character room code/);
    await expect(codeInput).not.toHaveAttribute('aria-invalid', 'true');

    await page.getByRole('button', { name: 'Join Room' }).click();
    await expect(codeInput).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert')).toHaveText('Please enter a room code.');
    // The error is linked to the field, not just floating above it.
    await expect(codeInput).toHaveAttribute('aria-describedby', 'joinHint watchError');
    await expect(page.locator('#watchError')).toBeVisible();

    await codeInput.fill('ABC');
    await expect(codeInput).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#joinHint')).toHaveText('3/6 characters');

    await page.getByRole('button', { name: 'Join Room' }).click();
    await expect(page.getByRole('alert')).toHaveText('Enter the full 6-character room code.');
    await expect(codeInput).toHaveAttribute('aria-invalid', 'true');
});

test('joining an unknown room reports the failure and leaves the field usable', async ({ page }) => {
    await page.goto('/#watch');

    const codeInput = page.getByLabel('Room code');
    await codeInput.fill('ZZZZZZ');
    await codeInput.press('Enter');

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(codeInput).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Join Room' })).toBeEnabled();
});

test('each route sets its own title and user navigation moves focus without stealing it on load', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Nextra — Self-hosted screen sharing');
    // Initial load must leave focus where the browser put it.
    expect(await page.evaluate(() => document.activeElement?.id || '')).not.toBe('main');
    await expect(page.getByTestId('route-announcer')).toHaveText('');

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'How to Use' }).click();
    await expect(page).toHaveTitle('How to Use · Nextra');
    await expect(page.getByTestId('route-announcer')).toHaveText('How to Use');
    await expect.poll(() => page.evaluate(() => document.activeElement?.id || '')).toBe('main');

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Watch' }).click();
    await expect(page).toHaveTitle('Watch · Nextra');
    await expect(page.getByTestId('route-announcer')).toHaveText('Watch');

    await page.goto('/#watch/ABC123');
    await expect(page).toHaveTitle('Watch · Nextra');

    await page.goto('/#does-not-exist');
    await expect(page).toHaveTitle('Page not found · Nextra');
});

test('the status route renders live metrics instead of the error boundary', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Status' }).click();

    await expect(page.getByRole('heading', { name: 'Server Status' })).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await expect(page.getByText('Active rooms').first()).toBeVisible();
    expect(pageErrors).toEqual([]);
});

test('Host downloads an allowlisted diagnostics JSON file', async ({ page }) => {
    await page.goto('/#host');
    await page.getByText('Troubleshooting diagnostics', { exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download redacted diagnostics' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^nextra-diagnostics-.*\.json$/);
    await expect(page.locator('.host-diagnostics [role="status"]')).toContainText('Downloaded nextra-diagnostics-');
});

// VAL-086: the skip link moves focus to <main>; it must not be treated as a
// hash route, which would render NotFound and unmount the current view.
for (const { route, marker } of [
    { route: '/#watch', marker: '.join-form' },
    { route: '/#host', marker: '.host-side-panel' },
]) {
    test(`skip to content on ${route} focuses main and keeps the view mounted`, async ({ page }) => {
        await page.goto(route);
        await expect(page.locator(marker)).toBeVisible();

        // Focus the link directly: the watch view autofocuses its room code
        // field, which would take a Tab from body. Tab order is covered by the
        // keyboard test below.
        const skipLink = page.getByRole('link', { name: 'Skip to content' });
        await skipLink.focus();
        await expect(skipLink).toBeFocused();
        await page.keyboard.press('Enter');

        await expect.poll(() => page.evaluate(() => document.activeElement?.id || '')).toBe('main');
        await expect(page.getByRole('heading', { name: 'Page not found' })).toHaveCount(0);
        await expect(page.locator(marker)).toBeVisible();
        expect(new URL(page.url()).hash).toBe(route.slice(route.indexOf('#')));
        await expect(page.getByTestId('route-announcer')).toHaveText('');
    });
}

test('keyboard users can reach the main content and the join controls', async ({ page }) => {
    await page.goto('/#watch');

    await page.evaluate(() => document.body.focus());
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();

    await page.getByLabel('Room code').focus();
    await page.keyboard.type('ABC123');
    await expect(page.getByLabel('Room code')).toHaveValue('ABC-123');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Join Room' })).toBeFocused();
});

for (const width of REFLOW_WIDTHS) {
    test(`content reflows without horizontal scrolling at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });

        for (const route of REFLOW_ROUTES) {
            await page.goto(route);
            await expect(page.locator('main#main')).toBeVisible();
            const metrics = await horizontalOverflow(page);
            expect(metrics.documentScrollWidth, `${route} at ${width}px`)
                .toBeLessThanOrEqual(metrics.innerWidth + 1);
            expect(metrics.bodyScrollWidth, `${route} at ${width}px`)
                .toBeLessThanOrEqual(metrics.innerWidth + 1);
        }
    });
}

// A laptop-height viewport has to show the host controls without the page
// scrolling: the settings cards are the tallest thing on the page and used to
// keep their full height no matter how short the viewport was.
// Desktop-only: the mobile project emulates a phone, where these viewport sizes
// describe nothing real.
for (const { width, height } of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }]) {
    test(`the host page fits a ${width}x${height} viewport without page scroll`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'chromium', 'desktop layout tiers');
        await page.setViewportSize({ width, height });

        for (const obsMode of [false, true]) {
            await remountHost(page);
            if (obsMode) {
                await page.locator('#obsMode').check();
                await expect(page.locator('.settings-wrapper')).toHaveClass(/settings-expanded/);
            }

            // Warning banners are content, not layout: this server runs with
            // WHIP disabled, so selecting OBS raises a preflight notice that a
            // WHIP-capable deployment would never show. Measure the layout by
            // allowing for whatever alerts are actually on screen.
            const metrics = await page.evaluate(() => {
                const alerts = [...document.querySelectorAll('.alert')]
                    .reduce((total, el) => total + el.getBoundingClientRect().height, 0);
                return {
                    scrollHeight: document.documentElement.scrollHeight,
                    innerHeight: window.innerHeight,
                    alerts: Math.ceil(alerts),
                };
            });
            expect(metrics.scrollHeight, `${width}x${height} with OBS ${obsMode ? 'on' : 'off'}`)
                .toBeLessThanOrEqual(metrics.innerHeight + metrics.alerts + 1);
        }
    });
}

for (const width of HOST_OBS_WIDTHS) {
    test(`the host video stage stays usable at ${width}px with OBS ingest selected`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'chromium', 'desktop layout tiers');
        await page.setViewportSize({ width, height: 900 });
        await remountHost(page);

        await page.locator('#obsMode').check();
        await expect(page.locator('.settings-wrapper')).toHaveClass(/settings-expanded/);
        await expect(page.locator('.obs-config-panel')).toBeVisible();

        const stage = await settledBox(page, '.video-container');
        expect(stage.width, `video stage at ${width}px with OBS on`)
            .toBeGreaterThanOrEqual(MIN_STAGE_WIDTH);

        const metrics = await horizontalOverflow(page);
        expect(metrics.documentScrollWidth, `host OBS layout at ${width}px`)
            .toBeLessThanOrEqual(metrics.innerWidth + 1);
    });
}

// A viewer joining bumps the host's viewer count, which re-renders HostView
// while the leave-host dialog is open. The dialog's own handlers must not move
// focus on that re-render, and closing it must return focus to the nav link.
test('a viewer joining while the leave-host dialog is open keeps focus on the button in use', async ({ browser, page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop media flow');
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

    await page.goto('/#host');
    await page.getByRole('button', { name: 'Start Sharing' }).click();
    await expect(page.getByText(/Streaming \(/)).toBeVisible();
    const localLink = await page.locator('.copy-field', { hasText: 'Local Link' })
        .locator('.copy-field-value').innerText();
    const code = localLink.trim().split('#watch/')[1];
    expect(code).toMatch(/^[A-Z0-9]{6}$/);

    await page.getByRole('link', { name: 'Watch' }).click();
    const dialog = page.getByRole('dialog', { name: 'Leave the host page?' });
    await expect(dialog).toBeVisible();
    const stay = dialog.getByRole('button', { name: 'Stay Here' });
    const leave = dialog.getByRole('button', { name: 'Leave and Stop' });
    await leave.focus();
    await expect(leave).toBeFocused();

    const viewerContext = await browser.newContext({
        baseURL: 'https://127.0.0.1:3210',
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 800 },
    });
    try {
        const viewer = await viewerContext.newPage();
        await viewer.goto(`/#watch/${code}`);
        await viewer.getByRole('button', { name: 'Join Room' }).click();
        await viewer.getByRole('button', { name: 'Watch Stream' }).click();
        await expect(dialog.getByText(/1 viewer is currently watching/)).toBeVisible();
        await expect(leave).toBeFocused();
        await expect(stay).not.toBeFocused();
    } finally {
        await viewerContext.close();
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Watch' })).toBeFocused();
});

// The 16:9 video stage is also bounded by the height left over after the page
// chrome. On a landscape phone that term is zero or a sliver (a 390px-tall
// viewport is shorter than the host page's chrome budget), so the stage needs
// its own floor: --stage-min-width, 18rem, still capped by the container.
const STAGE_MIN_WIDTH_PX = 18 * 16;
const SHORT_VIEWPORTS = [{ width: 844, height: 390 }, { width: 667, height: 375 }];

// The stage's width, the width of the box that holds it, and the viewport
// height, read after the layout stops moving.
async function stageWidths(page) {
    const stage = await settledBox(page, '.video-container');
    const metrics = await page.evaluate(() => {
        const parent = document.querySelector('.video-container').parentElement;
        const style = getComputedStyle(parent);
        return {
            containerWidth: parent.clientWidth
                - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            innerHeight: window.innerHeight,
        };
    });
    return { stage, ...metrics };
}

function expectFlooredStage({ stage, containerWidth }, label) {
    expect(stage.width, `${label}: the stage must have a width`).toBeGreaterThan(0);
    expect(stage.width, `${label}: the stage keeps its minimum width`)
        .toBeGreaterThanOrEqual(Math.min(STAGE_MIN_WIDTH_PX, containerWidth) - 0.5);
    expect(stage.width, `${label}: the stage never outgrows its container`)
        .toBeLessThanOrEqual(containerWidth + 0.5);
    expect(stage.width / stage.height, `${label}: the stage stays 16:9`)
        .toBeCloseTo(16 / 9, 1);
}

// Publishes a canvas as the screen to share, so a host can start without a picker.
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

// Starts sharing in a desktop context and returns the room code for viewers.
async function startSharingRoom(browser, baseURL) {
    const hostContext = await browser.newContext({
        baseURL,
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 800 },
    });
    const host = await hostContext.newPage();
    await useFakeScreenShare(host);
    await host.goto('/#host');
    await host.getByRole('button', { name: 'Start Sharing' }).click();
    await expect(host.getByText(/Streaming \(/)).toBeVisible();
    const localLink = await host.locator('.copy-field', { hasText: 'Local Link' })
        .locator('.copy-field-value').innerText();
    const code = localLink.trim().split('#watch/')[1];
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    return { hostContext, code };
}

for (const { width, height } of SHORT_VIEWPORTS) {
    test(`the host video stage keeps its minimum width on a ${width}x${height} landscape phone`, async ({ browser }, testInfo) => {
        test.skip(testInfo.project.name !== 'chromium', 'makes its own landscape-phone context');
        const context = await browser.newContext({
            baseURL: testInfo.project.use.baseURL,
            ignoreHTTPSErrors: true,
            viewport: { width, height },
            isMobile: true,
            hasTouch: true,
        });
        try {
            const page = await context.newPage();
            await page.goto('/#host');
            await expect(page.locator('.host-side-panel')).toBeVisible();
            expectFlooredStage(await stageWidths(page), `host at ${width}x${height}`);
        } finally {
            await context.close();
        }
    });

    test(`the watch video stage keeps its minimum width on a ${width}x${height} landscape phone`, async ({ browser }, testInfo) => {
        test.skip(testInfo.project.name !== 'chromium', 'makes its own landscape-phone context');
        const { hostContext, code } = await startSharingRoom(browser, testInfo.project.use.baseURL);
        const viewerContext = await browser.newContext({
            baseURL: testInfo.project.use.baseURL,
            ignoreHTTPSErrors: true,
            viewport: { width, height },
            isMobile: true,
            hasTouch: true,
        });
        try {
            const viewer = await viewerContext.newPage();
            await viewer.goto(`/#watch/${code}`);
            await viewer.getByRole('button', { name: 'Join Room' }).click();
            await expect(viewer.locator('.watch-video')).toBeVisible();
            expectFlooredStage(await stageWidths(viewer), `watch at ${width}x${height}`);
        } finally {
            await viewerContext.close();
            await hostContext.close();
        }
    });
}

// Where the height term is nowhere near the floor, the floor must change
// nothing: these are the stage widths the CSS produced before it existed.
// 1366x768 is a laptop where the height term is what sizes the host stage.
function stageWidthWithoutFloor({ containerWidth, innerHeight }, { chromeRem, maxWidthShare = 1 }) {
    const heightTerm = (innerHeight - chromeRem * 16) * 16 / 9;
    return Math.min(containerWidth, 1680, heightTerm, containerWidth * maxWidthShare);
}

for (const { width, height } of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
    test(`the host and watch video stages are unchanged at ${width}x${height}`, async ({ browser }, testInfo) => {
        test.skip(testInfo.project.name !== 'chromium', 'desktop layout tiers');
        const baseURL = testInfo.project.use.baseURL;
        const { hostContext, code } = await startSharingRoom(browser, baseURL);
        const desktopContext = await browser.newContext({
            baseURL,
            ignoreHTTPSErrors: true,
            viewport: { width, height },
        });
        try {
            const page = await desktopContext.newPage();
            await page.goto('/#host');
            await expect(page.locator('.host-side-panel')).toBeVisible();
            const host = await stageWidths(page);
            // 26rem of chrome from 820px down, 24rem above it.
            const hostChromeRem = height <= 820 ? 26 : 24;
            expect(host.stage.width, `host at ${width}x${height}`)
                .toBeCloseTo(stageWidthWithoutFloor(host, { chromeRem: hostChromeRem }), 0);
            expect(host.stage.width).toBeGreaterThan(STAGE_MIN_WIDTH_PX);

            await page.goto(`/#watch/${code}`);
            await page.getByRole('button', { name: 'Join Room' }).click();
            await expect(page.locator('.watch-video')).toBeVisible();
            const watch = await stageWidths(page);
            // .watch-video brings its own 19rem of chrome and a 60% cap above 900px.
            expect(watch.stage.width, `watch at ${width}x${height}`)
                .toBeCloseTo(stageWidthWithoutFloor(watch, { chromeRem: 19, maxWidthShare: 0.6 }), 0);
            expect(watch.stage.width).toBeGreaterThan(STAGE_MIN_WIDTH_PX);
        } finally {
            await desktopContext.close();
            await hostContext.close();
        }
    });
}
