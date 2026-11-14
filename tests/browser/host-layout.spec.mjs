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

test('browser mode shows every option as a row and has no More options', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHost(page);
    await expect(page.getByText('More options', { exact: true })).toBeHidden();
    await expect(page.locator('#hostMoreOptions')).toBeHidden();
    await expect(page.getByLabel('Optional room passphrase')).toBeVisible();
    await expect(page.getByLabel('Allow recovery after reload')).toBeVisible();
    // This server does not allow remote pause/play, so there is no dead switch for it.
    await expect(page.locator('#allowMediaControl')).toHaveCount(0);
    await expect(page.getByText('Disabled by the server operator')).toHaveCount(0);
    const body = await page.locator('.host-settings-body').evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
    }));
    expect(body.scrollHeight).toBeLessThanOrEqual(body.clientHeight + 1);
});

test('the hint beside the tabs ends at the right edge of the settings panel', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHost(page);
    for (const obsMode of [false, true]) {
        if (obsMode) await page.locator('#obsMode').check();
        const hint = page.locator('.source-tabs-hint');
        await expect(hint).toHaveText(obsMode ? 'Needs OBS Studio 28 or newer on this computer' : 'Viewers just open a link');
        const edges = await page.evaluate(() => ({
            hint: document.querySelector('.source-tabs-hint').getBoundingClientRect().right,
            panel: document.querySelector('.host-settings-panel').getBoundingClientRect().right,
            tabs: document.querySelector('.source-tabs').getBoundingClientRect().right,
            hintLeft: document.querySelector('.source-tabs-hint').getBoundingClientRect().left,
        }));
        expect(Math.abs(edges.hint - edges.panel), `OBS ${obsMode}: hint ${edges.hint} vs panel ${edges.panel}`).toBeLessThanOrEqual(1);
        expect(edges.hintLeft).toBeGreaterThan(edges.tabs);
    }
});

test('opening More options does not change the panel height and brings its rows into view', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 660 });
    await openHost(page);
    await page.locator('#obsMode').check();
    await expect(page.locator('.obs-config-panel')).toBeVisible();
    const panel = page.locator('.host-settings-panel');
    const before = await panel.boundingBox();
    const autoStart = page.locator('#obsAutoStart');
    await expect(autoStart).toBeHidden();
    await page.locator('.host-more-options summary').click();
    await expect(autoStart).toBeVisible();
    const after = await panel.boundingBox();
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
    // The panel is only as tall as the preview, so it scrolls the opened rows up into it.
    await expect.poll(() => page.evaluate(() => {
        const box = document.querySelector('.host-settings-panel').getBoundingClientRect();
        const row = document.querySelector('#obsAutoStart').getBoundingClientRect();
        return row.top >= box.top && row.bottom <= box.bottom;
    })).toBe(true);
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

// OBS mode: four plain rows and "More options".

async function visibleRowLabels(page) {
    return page.evaluate(() => [...document.querySelectorAll('.host-settings-panel .setting-row-label, .host-settings-panel summary')]
        .filter((el) => el.getClientRects().length > 0)
        // Content of a closed disclosure is not on screen, whatever its boxes say.
        .filter((el) => el.tagName === 'SUMMARY' || !el.closest('details:not([open])'))
        .map((el) => el.textContent.trim()));
}

async function rowHeights(page) {
    return page.evaluate(() => {
        const heights = {};
        for (const name of ['Resolution', 'Frame rate']) {
            const group = document.querySelector(`.host-settings-panel [role="group"][aria-label="${name}"]`);
            heights[name] = group.closest('.setting-row').getBoundingClientRect().height;
        }
        return heights;
    });
}

test.describe('host settings panel in OBS mode at 1440x900', () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await openHost(page);
    });

    test('the visible rows are Resolution, Frame rate, Picture preset, OBS password and More options', async ({ page }) => {
        await page.locator('#obsMode').check();
        await expect(page.locator('.obs-config-panel')).toBeVisible();
        expect(await visibleRowLabels(page)).toEqual(['Resolution', 'Frame rate', 'Picture preset', 'OBS password', 'More options']);
        // No switch on the panel itself: they are all in "More options".
        await expect(page.locator('.host-settings-panel input[type="checkbox"]:visible')).toHaveCount(0);
        const password = page.locator('#obsPassword');
        await expect(password).toHaveAttribute('type', 'password');
        await expect(password).toHaveAttribute('placeholder', 'Leave blank if none');
        await expect(page.locator('.obs-config-panel').locator('#obsPassword')).toBeVisible();
    });

    test('the Resolution and Frame rate rows are as tall as in browser mode', async ({ page }) => {
        const browserHeights = await rowHeights(page);
        await page.locator('#obsMode').check();
        await expect(page.locator('.obs-config-panel')).toBeVisible();
        const obsHeights = await rowHeights(page);
        for (const name of ['Resolution', 'Frame rate']) {
            expect(Math.abs(obsHeights[name] - browserHeights[name]), `${name}: ${obsHeights[name]} vs ${browserHeights[name]}`).toBeLessThanOrEqual(1);
        }
    });

    test('the OBS switches and the room rows live in More options with plain names', async ({ page }) => {
        await page.locator('#obsMode').check();
        const more = page.locator('#hostMoreOptions');
        for (const id of ['obsApplySettings', 'obsAutoStart', 'obsTryAv1']) {
            await expect(page.locator(`#${id}`)).toBeHidden();
            await expect(more.locator(`#${id}`)).toHaveCount(1);
        }
        await more.locator('summary').click();
        await expect(page.getByLabel('Set OBS up for me')).toBeVisible();
        await expect(page.getByLabel('Start stream for me')).toBeVisible();
        await expect(page.getByLabel('AV1 with my own TURN server')).toBeVisible();
        await expect(page.locator('#obsApplySettings')).toBeVisible();
        await expect(page.locator('#obsAutoStart')).toBeVisible();
        await expect(page.locator('#obsTryAv1')).toBeVisible();
        const order = await more.evaluate((el) => [...el.querySelectorAll('input[type="checkbox"], #roomPassphrase')]
            .map((input) => input.id));
        expect(order).toEqual(['obsApplySettings', 'obsAutoStart', 'obsTryAv1', 'roomPassphrase', 'reloadRecoveryEnabled']);
    });

    test('turning Set OBS up for me off disables the three picture groups and says why', async ({ page }) => {
        await page.locator('#obsMode').check();
        const groups = ['Resolution', 'Frame rate', 'Picture preset'].map((name) => page.getByRole('group', { name }));
        const buttons = groups.map((group) => group.getByRole('button'));
        const note = page.getByText('OBS keeps its own picture settings.');
        await expect(note).toHaveCount(0);
        for (const group of buttons) {
            for (const button of await group.all()) await expect(button).toBeEnabled();
        }

        await page.locator('.host-more-options summary').click();
        await page.locator('#obsApplySettings').uncheck();
        await expect(note).toBeVisible();
        // The line sits with the picture rows it explains, where it shows while
        // "More options" is closed, and the rows still fit the panel.
        expect(await note.evaluate((el) => el.parentElement.classList.contains('capture-settings'))).toBe(true);
        await page.locator('.host-more-options summary').click();
        await expect(note).toBeVisible();
        const body = await page.locator('.host-settings-body').evaluate((el) => ({
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
        }));
        expect(body.scrollHeight).toBeLessThanOrEqual(body.clientHeight + 1);
        await page.locator('.host-more-options summary').click();
        for (const group of groups) await expect(group).toHaveAttribute('aria-disabled', 'true');
        for (const group of buttons) {
            for (const button of await group.all()) await expect(button).toBeDisabled();
        }
        const opacity = await page.getByRole('group', { name: 'Picture preset' })
            .evaluate((el) => getComputedStyle(el.closest('.setting-row')).opacity);
        expect(Number(opacity)).toBeCloseTo(0.45, 2);

        await page.locator('#obsApplySettings').check();
        await expect(note).toHaveCount(0);
        for (const group of groups) await expect(group).not.toHaveAttribute('aria-disabled', 'true');
        for (const group of buttons) {
            for (const button of await group.all()) await expect(button).toBeEnabled();
        }
    });

    test('the old OBS names are gone from the panel', async ({ page }) => {
        await page.locator('#obsMode').check();
        await page.locator('.host-more-options summary').click();
        const panel = page.locator('.host-settings-panel');
        for (const text of ['WS password', 'BYOK', 'WHIP ingest', 'Apply recommended output settings']) {
            await expect(panel.getByText(text), text).toHaveCount(0);
        }
    });
});

// The two capture modes look alike: the same preview (title, line, button) and
// controls of the same height in the panel, at every window size.
async function modeLook(page) {
    return page.evaluate(() => {
        const size = (el) => {
            if (!el || el.getClientRects().length === 0) return null;
            const rect = el.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
        };
        const stage = document.querySelector('.host-stage-empty');
        const button = stage.querySelector('.btn-main');
        return {
            // Icons in the preview outside its button: none, in either mode.
            looseIcons: [...stage.querySelectorAll('svg')].filter((svg) => !svg.closest('button, .obs-steps')).length,
            title: size(stage.querySelector('.host-stage-empty-title')),
            titleFont: getComputedStyle(stage.querySelector('.host-stage-empty-title')).fontSize,
            lineFont: getComputedStyle(stage.querySelector('.host-stage-empty-sub, .obs-step-label')).fontSize,
            lineColor: getComputedStyle(stage.querySelector('.host-stage-empty-sub, .obs-step-label')).color,
            button: size(button),
            buttonIcons: button.querySelectorAll('svg').length,
            buttonText: button.textContent.trim(),
            controls: [...document.querySelectorAll('.host-settings-panel .mode-toggle-small, .host-settings-panel .select-input')]
                .filter((el) => el.getClientRects().length > 0)
                // Content of a closed disclosure is not on screen, whatever its boxes say.
                .filter((el) => !el.closest('details:not([open])'))
                .map((el) => el.getBoundingClientRect().height),
            firstControlTop: document.querySelector('.host-settings-panel .mode-toggle-small').getBoundingClientRect().top,
            overflow: (() => {
                const box = stage.getBoundingClientRect();
                return [...stage.children].filter((el) => el.getClientRects().length > 0).every((el) => {
                    const rect = el.getBoundingClientRect();
                    return rect.top >= box.top && rect.bottom <= box.bottom;
                });
            })(),
        };
    });
}

for (const { width, height } of [{ width: 1440, height: 900 }, { width: 1280, height: 660 }, { width: 1366, height: 620 }]) {
    test(`at ${width}x${height} the two capture modes have the same preview and the same control height`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'chromium', 'desktop layout tiers');
        await page.setViewportSize({ width, height });
        await openHost(page);
        const browserLook = await modeLook(page);
        await page.locator('#obsMode').check();
        await expect(page.locator('.obs-config-panel')).toBeVisible();
        const obsLook = await modeLook(page);

        // The preview: the same title and line size, and the same Start button, icon included.
        expect(obsLook.title).toEqual(browserLook.title);
        expect(obsLook.titleFont).toBe(browserLook.titleFont);
        expect(obsLook.lineFont).toBe(browserLook.lineFont);
        expect(obsLook.lineColor).toBe(browserLook.lineColor);
        expect(obsLook.buttonText).toBe('Start Sharing');
        expect(browserLook.buttonText).toBe('Start Sharing');
        expect(obsLook.buttonIcons).toBe(1);
        expect(browserLook.buttonIcons).toBe(1);
        expect(Math.abs(obsLook.button.width - browserLook.button.width)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(obsLook.button.height - browserLook.button.height)).toBeLessThanOrEqual(0.5);
        // The source's icon is in the button only; the preview has no icon of its own.
        expect(browserLook.looseIcons).toBe(0);
        expect(obsLook.looseIcons).toBe(0);
        expect(browserLook.overflow, 'browser preview content stays inside the preview').toBe(true);
        expect(obsLook.overflow, 'OBS preview content stays inside the preview').toBe(true);

        // The panel: every segmented control and input is one height, in both modes.
        expect(browserLook.controls.length).toBe(3);
        expect(obsLook.controls.length).toBe(4);
        const reference = browserLook.controls[0];
        expect(reference).toBeGreaterThanOrEqual(32);
        for (const controlHeight of [...browserLook.controls, ...obsLook.controls]) {
            expect(Math.abs(controlHeight - reference), `${controlHeight} vs ${reference}`).toBeLessThanOrEqual(0.5);
        }
    });
}

// 1280x660 and 1366x620 are what a 1080p screen at 150% zoom and a 768p laptop leave a browser window.
for (const { width, height } of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1280, height: 660 }, { width: 1366, height: 620 }]) {
    test(`in OBS mode at ${width}x${height} the panel keeps the preview's top and bottom and the rows do not scroll`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'chromium', 'desktop layout tiers');
        await page.setViewportSize({ width, height });
        await openHost(page);
        await page.locator('#obsMode').check();
        await expect(page.locator('.obs-config-panel')).toBeVisible();
        const m = await panelAndStage(page);
        const label = `${width}x${height}`;
        expect(Math.abs(m.panel.top - m.stage.top), `${label}: top ${m.panel.top} vs ${m.stage.top}`).toBeLessThanOrEqual(1);
        expect(Math.abs(m.panel.bottom - m.stage.bottom), `${label}: bottom ${m.panel.bottom} vs ${m.stage.bottom}`).toBeLessThanOrEqual(1);
        const body = await page.locator('.host-settings-body').evaluate((el) => ({
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            open: el.querySelector('.host-more-options').open,
        }));
        expect(body.open).toBe(false);
        expect(body.scrollHeight, `${label}: rows scroll ${body.scrollHeight} > ${body.clientHeight}`).toBeLessThanOrEqual(body.clientHeight + 1);
    });
}
