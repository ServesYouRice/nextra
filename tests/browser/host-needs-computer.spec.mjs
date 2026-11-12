import { test, expect } from '@playwright/test';

const NO_CAPTURE = () => {
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true,
        value: undefined,
    });
};

async function phoneContext(browser, testInfo) {
    return browser.newContext({
        baseURL: testInfo.project.use.baseURL,
        ignoreHTTPSErrors: true,
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
}

test('a touch device without screen capture is told sharing needs a computer', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'makes its own phone context');
    const context = await phoneContext(browser, testInfo);
    try {
        const page = await context.newPage();
        await page.addInitScript(NO_CAPTURE);
        await page.goto('/#host');
        await expect(page.getByRole('heading', { name: 'Sharing needs a computer' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Start Sharing' })).toHaveCount(0);
        await expect(page.locator('.host-side-panel')).toHaveCount(0);

        const watch = page.getByRole('link', { name: 'Watch a stream instead' });
        await expect(watch).toHaveClass(/btn-main/);
        expect((await watch.boundingBox()).height).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

        await watch.click();
        await expect(page.locator('.join-form')).toBeVisible();

        await page.goto('/#host');
        await page.getByRole('link', { name: 'How to Use' }).last().click();
        await expect(page).toHaveTitle('How to Use · Nextra');
    } finally {
        await context.close();
    }
});

test('a desktop browser without screen capture keeps the host page and its inline error', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop only');
    await page.addInitScript(NO_CAPTURE);
    await page.goto('/#host');
    await expect(page.getByRole('button', { name: 'Start Sharing' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sharing needs a computer' })).toHaveCount(0);
});

test('a touch device that can capture keeps the host page', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'makes its own phone context');
    const context = await phoneContext(browser, testInfo);
    try {
        const page = await context.newPage();
        await page.goto('/#host');
        await expect(page.locator('.host-side-panel')).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Sharing needs a computer' })).toHaveCount(0);
    } finally {
        await context.close();
    }
});
