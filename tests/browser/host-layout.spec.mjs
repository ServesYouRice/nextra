import { test, expect } from '@playwright/test';

// The host page opens with the capture source as two tabs above the preview, and
// the empty preview holds the page's one main button. No room is created here.

async function openHost(page) {
    await page.goto('/#watch');
    await expect(page.locator('.join-form')).toBeVisible();
    await page.goto('/#host');
    await expect(page.locator('.host-side-panel')).toBeVisible();
}

test.describe('host source tabs and start button at 1440x900', () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await openHost(page);
    });

    test('the capture source is a radiogroup of two tabs, each at least 44px tall', async ({ page }) => {
        const group = page.getByRole('radiogroup', { name: 'Capture source' });
        await expect(group).toBeVisible();
        const browserTab = group.getByRole('radio', { name: 'This browser', exact: true });
        const obsTab = group.getByRole('radio', { name: 'OBS', exact: true });
        await expect(browserTab).toBeChecked();
        await expect(obsTab).not.toBeChecked();
        await expect(page.locator('#obsMode')).toHaveJSProperty('type', 'radio');

        for (const tab of [group.locator('label.source-tab').nth(0), group.locator('label.source-tab').nth(1)]) {
            const box = await tab.boundingBox();
            expect(box.height).toBeGreaterThanOrEqual(44);
        }
    });

    test('the Start button is the only main button and sits inside the preview', async ({ page }) => {
        const start = page.getByRole('button', { name: 'Start Sharing' });
        await expect(start).toBeVisible();
        await expect(page.locator('.video-container').getByRole('button', { name: 'Start Sharing' })).toHaveCount(1);
        await expect(start).toHaveClass(/btn-main/);
        const box = await start.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(54);
        await expect(page.locator('.btn-main')).toHaveCount(1);
    });

    test('the preview says nothing is shared yet and the old OBS tick box is gone', async ({ page }) => {
        await expect(page.getByText('Nothing is being shared yet')).toBeVisible();
        await expect(page.getByText('Use OBS (WHIP ingest)')).toHaveCount(0);
    });

    test('choosing OBS opens the OBS card and adds the Picture preset row after Frame rate', async ({ page }) => {
        const presetGroup = page.getByRole('group', { name: 'Picture preset' });
        await expect(presetGroup).toHaveCount(0);

        await page.locator('#obsMode').check();
        await expect(page.locator('.settings-wrapper')).toHaveClass(/settings-expanded/);
        await expect(page.locator('.obs-config-panel')).toBeVisible();
        await expect(presetGroup).toBeVisible();

        const order = await page.evaluate(() => [...document.querySelectorAll('.capture-settings .mode-toggle')]
            .map((el) => el.getAttribute('aria-label')));
        expect(order).toEqual(['Resolution', 'Frame rate', 'Picture preset']);

        await page.getByRole('radio', { name: 'This browser', exact: true }).check();
        await expect(page.locator('.obs-config-panel')).toBeHidden();
        await expect(presetGroup).toHaveCount(0);
    });

    test('the arrow keys move between the two tabs', async ({ page }) => {
        const browserTab = page.getByRole('radio', { name: 'This browser', exact: true });
        const obsTab = page.getByRole('radio', { name: 'OBS', exact: true });
        await browserTab.focus();
        await expect(browserTab).toBeChecked();
        await page.keyboard.press('ArrowRight');
        await expect(obsTab).toBeChecked();
        await expect(browserTab).not.toBeChecked();
        await page.keyboard.press('ArrowLeft');
        await expect(browserTab).toBeChecked();
    });
});

test('on a phone the host page does not scroll sideways and Start stays inside the preview', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHost(page);

    const start = page.getByRole('button', { name: 'Start Sharing' });
    await expect(start).toBeVisible();
    const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);

    const stage = await page.locator('.video-container').boundingBox();
    const button = await start.boundingBox();
    expect(button.x).toBeGreaterThanOrEqual(stage.x);
    expect(button.y).toBeGreaterThanOrEqual(stage.y);
    expect(button.x + button.width).toBeLessThanOrEqual(stage.x + stage.width);
    expect(button.y + button.height).toBeLessThanOrEqual(stage.y + stage.height);
});
