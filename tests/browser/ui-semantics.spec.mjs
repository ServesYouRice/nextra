import { test, expect } from '@playwright/test';

// Widths the README support table claims: small phone, common phone, tablet
// breakpoint, small laptop, and wide desktop.
const REFLOW_WIDTHS = [320, 375, 640, 900, 1440];
const REFLOW_ROUTES = ['/', '/#watch', '/#how-to'];

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
