import { test, expect } from '@playwright/test';

const MIN_TAP = 43.5;

// The routes and what proves each one's own content has rendered.
const ROUTES = [
    ['/', (page) => page.getByRole('heading', { name: 'Share your screen. They just open a link.' })],
    ['/#watch', (page) => page.locator('.join-card')],
    ['/#how-to', (page) => page.getByRole('heading', { name: 'How to use Nextra' })],
    ['/#host', (page) => page.locator('.host-side-panel')],
    ['/#status', (page) => page.getByRole('heading', { name: 'Server Status' })],
    ['/#privacy', (page) => page.getByRole('heading', { name: 'Privacy Policy' })],
    ['/#copyright', (page) => page.getByRole('heading', { name: 'Copyright, DMCA, and Contact' })],
    ['/#no-such-page', (page) => page.getByRole('heading', { name: 'Page not found' })],
];

async function phonePage(browser, testInfo) {
    const context = await browser.newContext({
        baseURL: testInfo.project.use.baseURL,
        ignoreHTTPSErrors: true,
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    return { context, page: await context.newPage() };
}

// Lists every visible control under 44px tall (or wide, when it has no text).
async function undersizedControls(page) {
    return page.evaluate((min) => {
        const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            const style = getComputedStyle(el);
            return style.visibility !== 'hidden' && style.display !== 'none';
        };
        const textLike = 'input:not([type]), input[type="text"], input[type="password"], input[type="search"], input[type="email"], input[type="url"], input[type="number"], input[type="tel"]';
        const targets = new Set();
        const scope = 'header, main, footer';
        for (const el of document.querySelectorAll(`:is(${scope}) :is(a[href], button, summary, select, [role="tab"], ${textLike})`)) {
            targets.add(el);
        }
        for (const label of document.querySelectorAll(`:is(${scope}) label`)) {
            if (label.querySelector('input[type="checkbox"], input[type="radio"]')) targets.add(label);
        }
        const inRunningText = (el) => {
            if (el.tagName !== 'A') return false;
            const host = el.closest('p, li, td, dd');
            if (!host) return false;
            return (host.textContent || '').trim() !== (el.textContent || '').trim();
        };
        const failures = [];
        for (const el of targets) {
            if (!isVisible(el)) continue;
            if (el.classList.contains('skip-link')) continue;
            if (inRunningText(el)) continue;
            const rect = el.getBoundingClientRect();
            const hasText = (el.textContent || '').trim() !== '' || ['INPUT', 'SELECT'].includes(el.tagName);
            if (rect.height < min || (!hasText && rect.width < min)) {
                const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('type') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
                failures.push(`${el.tagName.toLowerCase()}, "${text}", ${rect.width.toFixed(1)}x${rect.height.toFixed(1)}`);
            }
        }
        return failures;
    }, MIN_TAP);
}

// The open menu can cover the page, so it is open only while measuring.
async function setMenu(page, open) {
    const menu = page.getByRole('button', { name: 'Menu' });
    if ((await menu.getAttribute('aria-expanded')) === String(open)) return;
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', String(open));
}

async function expectTapTargets(page, label) {
    await setMenu(page, true);
    // Let fold-out and panel animations settle before measuring.
    await page.waitForTimeout(600);
    expect(await undersizedControls(page), `undersized controls ${label}`).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${label}: the page scrolls sideways`).toBeLessThanOrEqual(0);
    await setMenu(page, false);
}

for (const [route, ready] of ROUTES) {
    test(`every control on ${route} is at least 44px tall on a phone`, async ({ browser }, testInfo) => {
        const { context, page } = await phonePage(browser, testInfo);
        try {
            await page.goto(route);
            await expect(ready(page)).toBeVisible();
            await expectTapTargets(page, `on ${route}`);
            const footer = await page.locator('footer.site-footer').boundingBox();
            expect(footer.height, `the footer on ${route} stays compact`).toBeLessThanOrEqual(120);

            if (route === '/#how-to') {
                const tabs = page.getByRole('tablist', { name: 'Guide sections' }).getByRole('tab');
                const count = await tabs.count();
                for (let index = 0; index < count; index += 1) {
                    const tab = tabs.nth(index);
                    await tab.click();
                    await expect(tab).toHaveAttribute('aria-selected', 'true');
                    await expectTapTargets(page, `on ${route}, tab ${index + 1}`);
                }
            }

            if (route === '/#host') {
                await page.locator('#obsMode').check();
                await expect(page.locator('.obs-config-panel')).toBeVisible();
                await expectTapTargets(page, `on ${route} with OBS`);
                await page.getByText('More options', { exact: true }).click();
                await expectTapTargets(page, `on ${route} with More options`);
            }
        } finally {
            await context.close();
        }
    });
}
