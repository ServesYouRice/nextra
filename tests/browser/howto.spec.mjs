import { test, expect } from '@playwright/test';

// The How to Use guide: five tabs, three illustrated steps, a Copy button on
// the Mac command and fold-out answers. No room is created.

const TAB_NAMES = ['Share your screen', 'Use OBS', 'Watch a stream', 'Fix a problem', 'Privacy'];
const MAC_COMMAND = [
    'chmod +x ./Nextra-macos-arm64',
    'xattr -dr com.apple.quarantine ./Nextra-macos-arm64',
    './Nextra-macos-arm64',
].join('\n');

function tab(page, name) {
    return page.getByRole('tablist', { name: 'Guide sections' }).getByRole('tab', { name });
}

async function openGuide(page, size = { width: 1440, height: 900 }) {
    await page.setViewportSize(size);
    await page.goto('/#how-to');
    await expect(page.getByRole('heading', { name: 'How to use Nextra' })).toBeVisible();
}

test('the guide opens on five tabs with Share your screen selected and one panel showing', async ({ page }) => {
    await openGuide(page);

    await expect(page.getByRole('tablist', { name: 'Guide sections' }).getByRole('tab')).toHaveText(TAB_NAMES);
    await expect(tab(page, 'Share your screen')).toHaveAttribute('aria-selected', 'true');
    for (const name of TAB_NAMES.slice(1)) {
        await expect(tab(page, name)).toHaveAttribute('aria-selected', 'false');
    }

    // All five panels stay in the document; only the selected one shows.
    await expect(page.locator('[role="tabpanel"]')).toHaveCount(5);
    await expect(page.getByRole('tabpanel')).toHaveCount(1);

    // Three step cards share one row.
    for (const title of ['1. Start Nextra', '2. Press Start Sharing', '3. Send the link']) {
        await expect(page.getByText(title, { exact: true })).toBeVisible();
    }
    const cards = page.locator('.howto-steps > .article-step');
    await expect(cards).toHaveCount(3);
    const tops = [];
    for (let index = 0; index < 3; index += 1) tops.push((await cards.nth(index).boundingBox()).y);
    expect(tops[1]).toBeCloseTo(tops[0], 0);
    expect(tops[2]).toBeCloseTo(tops[0], 0);

    // The old names are gone from the whole page, hidden panels included.
    await expect(page.getByText('BYOK')).toHaveCount(0);
    await expect(page.getByText('Use OBS (WHIP ingest)')).toHaveCount(0);
});

test('ArrowRight moves to the next tab and Home and End jump to the ends', async ({ page }) => {
    await openGuide(page);

    await tab(page, 'Share your screen').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'Use OBS')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Use OBS')).toBeFocused();
    const panel = page.getByRole('tabpanel');
    await expect(panel).toHaveCount(1);
    await expect(panel).toContainText('Set OBS up for me');
    await expect(panel).toContainText('Picture preset');
    await expect(panel).toContainText('OBS password');

    await page.keyboard.press('End');
    await expect(tab(page, 'Privacy')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'Share your screen')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(tab(page, 'Privacy')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(tab(page, 'Share your screen')).toHaveAttribute('aria-selected', 'true');
});

test('Fix a problem folds nine questions away until they are opened', async ({ page }) => {
    await openGuide(page);
    await tab(page, 'Fix a problem').click();

    const questions = page.locator('.howto-question');
    await expect(questions).toHaveCount(9);
    await expect(page.locator('.howto-question[open]')).toHaveCount(0);

    const first = questions.first();
    const answer = first.locator('p').first();
    await expect(answer).toBeHidden();
    await first.locator('summary').click();
    await expect(first).toHaveAttribute('open', '');
    await expect(answer).toBeVisible();
    expect((await first.locator('summary').boundingBox()).height).toBeGreaterThanOrEqual(44);
});

test('Privacy shows the security section', async ({ page }) => {
    await openGuide(page);
    await tab(page, 'Privacy').click();

    const panel = page.getByRole('tabpanel');
    await expect(panel.getByRole('heading', { name: 'Security and privacy' })).toBeVisible();
    await expect(panel.getByText('Media is not stored by Nextra.', { exact: false })).toBeVisible();
});

test('Copy command puts the three Mac lines on the clipboard', async ({ browser }, testInfo) => {
    const context = await browser.newContext({
        baseURL: testInfo.project.use.baseURL,
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 900 },
        permissions: ['clipboard-read', 'clipboard-write'],
    });
    try {
        const page = await context.newPage();
        await page.goto('/#how-to');
        await expect(page.getByRole('heading', { name: 'How to use Nextra' })).toBeVisible();

        const copy = page.getByRole('button', { name: 'Copy command' });
        await expect(copy).toBeVisible();
        await copy.click();

        // The Windows clipboard gives text back with \r\n line ends; the page copies \n.
        const text = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
        expect(text.startsWith('chmod +x ./Nextra-macos-arm64')).toBe(true);
        expect(text).toBe(MAC_COMMAND);
        await expect(copy).toHaveText('Copied');
        await expect(page.getByText('Command copied.')).toBeVisible();
        // The label goes back after two seconds.
        await expect(copy).toHaveText('Copy', { timeout: 5000 });
    } finally {
        await context.close();
    }
});

test('the Share my screen link shows under every tab and leads to the host page', async ({ page }) => {
    await openGuide(page);
    const link = page.locator('main').getByRole('link', { name: 'Share my screen' });

    for (const name of TAB_NAMES) {
        await tab(page, name).click();
        await expect(link).toBeVisible();
    }

    await link.click();
    await expect(page).toHaveTitle('Host · Nextra');
});

test('on a phone the tabs are tall enough, the row scrolls inside itself and the steps stack', async ({ page }) => {
    await openGuide(page, { width: 390, height: 844 });

    for (const name of TAB_NAMES) {
        expect((await tab(page, name).boundingBox()).height, `${name} tab`).toBeGreaterThanOrEqual(44);
    }

    const row = await page.getByRole('tablist', { name: 'Guide sections' }).evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowX: getComputedStyle(el).overflowX,
    }));
    expect(['auto', 'scroll']).toContain(row.overflowX);
    expect(row.scrollWidth).toBeGreaterThanOrEqual(row.clientWidth);

    const page_ = await page.evaluate(() => ({
        documentScrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    }));
    expect(page_.documentScrollWidth).toBeLessThanOrEqual(page_.clientWidth + 1);

    const cards = page.locator('.howto-steps > .article-step');
    const boxes = [];
    for (let index = 0; index < 3; index += 1) boxes.push(await cards.nth(index).boundingBox());
    expect(boxes[1].x).toBeCloseTo(boxes[0].x, 0);
    expect(boxes[2].x).toBeCloseTo(boxes[0].x, 0);
    expect(boxes[1].y).toBeGreaterThan(boxes[0].y + boxes[0].height - 1);
    expect(boxes[2].y).toBeGreaterThan(boxes[1].y + boxes[1].height - 1);

    // The Copy button is a full tap target at this width.
    expect((await page.getByRole('button', { name: 'Copy command' }).boundingBox()).height).toBeGreaterThanOrEqual(44);
});
