import { test, expect } from '@playwright/test';

test.describe('home page', () => {
    test('has one h1 and one main button that leads to the Host page', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/');
        await expect(page.locator('h1')).toHaveCount(1);
        const main = page.locator('.btn-main');
        await expect(main).toHaveCount(1);
        await expect(main).toHaveAccessibleName('Share my screen');
        const box = await main.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(54);
        await main.click();
        await expect(page).toHaveTitle('Host · Nextra');
    });

    test('keeps its document title on /', async ({ page }) => {
        await page.goto('/');
        await expect(page).toHaveTitle('Nextra — Self-hosted screen sharing');
    });

    test('formats a typed code and opens the Watch page with it on Enter', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/');
        const input = page.getByLabel('Got a room code?');
        await input.fill('abc123');
        await expect(input).toHaveValue('ABC-123');
        await input.press('Enter');
        await expect(page).toHaveURL(/#watch\/ABC123$/);
        const watchInput = page.getByLabel('Room code');
        await expect(watchInput).toBeVisible();
        await expect.poll(async () => (await watchInput.inputValue()).replace(/-/g, '')).toBe('ABC123');
    });

    test('pulls the code out of a pasted watch link', async ({ page }) => {
        await page.goto('/');
        const input = page.getByLabel('Got a room code?');
        await input.fill('https://example.test/#watch/qwe789');
        await expect(input).toHaveValue('QWE-789');
    });

    test('an incomplete code stays on the home page and shows an alert', async ({ page }) => {
        await page.goto('/');
        const input = page.getByLabel('Got a room code?');
        await input.fill('AB');
        await page.getByRole('button', { name: 'Join' }).click();
        await expect(page).not.toHaveURL(/#watch/);
        await expect(input).toHaveAttribute('aria-invalid', 'true');
        await expect(page.getByRole('alert').filter({ hasText: 'Enter the full 6-character room code.' })).toBeVisible();
        await input.fill('ABC');
        await expect(input).not.toHaveAttribute('aria-invalid', 'true');
    });

    test('shows the three plain facts', async ({ page }) => {
        await page.goto('/');
        for (const fact of ['Up to 4K at 60 fps', 'Runs on your own machine', 'Nextra records nothing']) {
            await expect(page.getByText(fact, { exact: true })).toBeVisible();
        }
    });

    test('fits a phone without sideways scroll and keeps tap targets large', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        expect((await page.locator('.btn-main').boundingBox()).height).toBeGreaterThanOrEqual(54);
        expect((await page.getByLabel('Got a room code?').boundingBox()).height).toBeGreaterThanOrEqual(44);
        expect((await page.getByRole('button', { name: 'Join' }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    });
});
