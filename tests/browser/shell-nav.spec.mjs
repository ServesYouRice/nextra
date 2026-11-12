import { test, expect } from '@playwright/test';

const mainNav = (page) => page.getByRole('navigation', { name: 'Main' });

async function heightOf(locator) {
    return (await locator.boundingBox()).height;
}

test('the desktop bar has four links, marks the current page and keeps 44px targets', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#host');

    const links = mainNav(page).getByRole('link');
    await expect(links).toHaveText(['Host', 'Watch', 'How to Use', 'Status']);
    await expect(page.locator('.nav-logo')).toHaveAttribute('href', '#');
    await expect(page.locator('.main-nav [aria-current="page"]')).toHaveCount(1);
    await expect(mainNav(page).getByRole('link', { name: 'Host' })).toHaveAttribute('aria-current', 'page');
    const shadow = await mainNav(page).getByRole('link', { name: 'Host' })
        .evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow).not.toBe('none');

    for (const link of await links.all()) {
        expect(await heightOf(link)).toBeGreaterThanOrEqual(44);
    }
    expect(await heightOf(page.locator('.nav-logo'))).toBeGreaterThanOrEqual(44);
    expect(await heightOf(page.locator('.main-nav'))).toBeLessThanOrEqual(63);
    await expect(page.getByRole('button', { name: 'Menu' })).toBeHidden();
});

test('the bar is no taller than 49px on a short viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/#host');
    expect(await heightOf(page.locator('.main-nav'))).toBeLessThanOrEqual(49);
});

test('on a phone the links sit behind a menu button that opens and closes', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    const button = page.getByRole('button', { name: 'Menu' });
    const links = mainNav(page).getByRole('link');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(links.first()).toBeHidden();

    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(links).toHaveCount(4);
    for (const link of await links.all()) {
        await expect(link).toBeVisible();
        expect(await heightOf(link)).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth
        <= document.documentElement.clientWidth)).toBe(true);

    await page.keyboard.press('Escape');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).toBeFocused();

    await button.click();
    await mainNav(page).getByRole('link', { name: 'Watch' }).click();
    await expect(page).toHaveTitle('Watch · Nextra');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(links.first()).toBeHidden();
});
