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

// The settings panel: one quiet panel beside the preview, as tall as the preview.

async function panelAndStage(page) {
    return page.evaluate(() => {
        const box = (selector) => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
        };
        const alerts = [...document.querySelectorAll('.alert')]
            .reduce((total, el) => total + el.getBoundingClientRect().height, 0);
        return {
            panel: box('.host-settings-panel'),
            stage: box('.video-container'),
            scrollHeight: document.documentElement.scrollHeight,
            innerHeight: window.innerHeight,
            alerts: Math.ceil(alerts),
        };
    });
}

for (const { width, height } of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 1280, height: 720 }]) {
    test(`the settings panel matches the preview's top and bottom at ${width}x${height}, in both capture modes`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'chromium', 'desktop layout tiers');
        await page.setViewportSize({ width, height });
        await openHost(page);

        for (const obsMode of [false, true]) {
            if (obsMode) {
                await page.locator('#obsMode').check();
                await expect(page.locator('.obs-config-panel')).toBeVisible();
            }
            const label = `${width}x${height} with OBS ${obsMode ? 'on' : 'off'}`;
            const m = await panelAndStage(page);
            expect(Math.abs(m.panel.top - m.stage.top), `${label}: top ${m.panel.top} vs ${m.stage.top}`).toBeLessThanOrEqual(1);
            expect(Math.abs(m.panel.bottom - m.stage.bottom), `${label}: bottom ${m.panel.bottom} vs ${m.stage.bottom}`).toBeLessThanOrEqual(1);
            expect(Math.abs(m.panel.width - 260), `${label}: panel width ${m.panel.width}`).toBeLessThanOrEqual(1);
            expect(m.scrollHeight, `${label}: page height`).toBeLessThanOrEqual(m.innerHeight + m.alerts + 1);
        }
    });
}

test('at 1440x900 the preview is at least 780px wide', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop layout tiers');
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHost(page);
    const stage = await page.locator('.video-container').boundingBox();
    expect(stage.width).toBeGreaterThanOrEqual(780);
});

test('every segmented control lives inside the settings panel', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHost(page);
    const panel = page.locator('.host-settings-panel');
    await expect(panel.getByRole('group', { name: 'Resolution' })).toBeVisible();
    await expect(panel.getByRole('group', { name: 'Frame rate' })).toBeVisible();
    await expect(panel.getByRole('group', { name: 'Resolution' }).getByRole('button')).toHaveText(['1080p', '1440p', '4K']);
    await expect(panel.getByRole('group', { name: 'Frame rate' }).getByRole('button')).toHaveText(['30 fps', '60 fps']);
    await page.locator('#obsMode').check();
    await expect(panel.getByRole('group', { name: 'Picture preset' })).toBeVisible();
    const outside = await page.evaluate(() => [...document.querySelectorAll('.mode-toggle')]
        .filter((el) => !el.closest('.host-settings-panel')).length);
    expect(outside).toBe(0);
});

test('opening More options does not change the panel height', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHost(page);
    const panel = page.locator('.host-settings-panel');
    const before = await panel.boundingBox();
    const media = page.locator('#allowMediaControl');
    await expect(media).toBeHidden();
    await page.locator('.host-more-options summary').click();
    await expect(media).toBeVisible();
    const after = await panel.boundingBox();
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
});

test('the switches stay real checkboxes that the labels check', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHost(page);
    await expect(page.locator('#reloadRecoveryEnabled')).toHaveJSProperty('type', 'checkbox');
    const recovery = page.getByLabel('Allow recovery after reload');
    const initial = await recovery.isChecked();
    await recovery.setChecked(!initial);
    await expect(recovery).toBeChecked({ checked: !initial });
    await page.getByLabel('Optional room passphrase').fill('hunter2');
    await expect(page.locator('#roomPassphrase')).toHaveValue('hunter2');
    await expect(page.locator('#roomPassphrase')).toHaveAttribute('placeholder', 'None');
});

for (const { width, height } of [{ width: 390, height: 844 }, { width: 820, height: 1180 }]) {
    test(`at ${width}x${height} the preview and the panel fill the column`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await openHost(page);
        const widths = await page.evaluate(() => ({
            layout: document.querySelector('.host-layout').getBoundingClientRect().width,
            panel: document.querySelector('.host-settings-panel').getBoundingClientRect().width,
            stage: document.querySelector('.video-container').getBoundingClientRect().width,
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
        }));
        expect(Math.abs(widths.panel - widths.layout)).toBeLessThanOrEqual(1);
        expect(Math.abs(widths.stage - widths.layout)).toBeLessThanOrEqual(1);
        expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth + 1);
    });
}

test('on a phone every control in the settings panel is at least 44px tall', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHost(page);
    const small = await page.evaluate(() => {
        const panel = document.querySelector('.host-settings-panel');
        const found = [];
        for (const el of panel.querySelectorAll('button, input, summary')) {
            const target = el.type === 'checkbox' ? el.closest('label') || el : el;
            const rect = target.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (rect.height < 44) {
                found.push(`${el.tagName.toLowerCase()}#${el.id || ''} "${(el.textContent || '').trim()}" is ${rect.height}px`);
            }
        }
        return { found, count: panel.querySelectorAll('button, input, summary').length };
    });
    expect(small.count).toBeGreaterThan(0);
    expect(small.found).toEqual([]);
});

test('the diagnostics row is at least 44px tall and sits under the preview', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHost(page);
    const summary = page.getByText('Troubleshooting diagnostics', { exact: true });
    const box = await summary.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    const stage = await page.locator('.video-container').boundingBox();
    expect(Math.abs(box.x - stage.x)).toBeLessThanOrEqual(1);
    expect(box.y).toBeGreaterThanOrEqual(stage.y + stage.height);
});
