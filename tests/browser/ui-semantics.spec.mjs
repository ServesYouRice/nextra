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
