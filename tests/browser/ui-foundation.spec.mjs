import { test, expect } from '@playwright/test';

// No room is created: every check reads computed style on a page that needs no
// server state.

async function focusByKeyboard(page, locator) {
    for (let presses = 0; presses < 30; presses += 1) {
        const focused = await locator.evaluate((element) => element === document.activeElement);
        if (focused) return;
        await page.keyboard.press('Tab');
    }
    await expect(locator).toBeFocused();
}

test('dim grey text is readable on the watch page', async ({ page }) => {
    await page.goto('/#watch');
    await expect(page.locator('#joinHint')).toBeVisible();
    await expect(page.locator('#joinHint')).toHaveCSS('color', 'rgb(148, 148, 168)');
});

test('the primary button keeps its gradient through the token', async ({ page }) => {
    await page.goto('/#does-not-exist');
    const goHome = page.getByRole('link', { name: 'Go Home' });
    await expect(goHome).toBeVisible();
    const image = await goHome.evaluate((element) => getComputedStyle(element).backgroundImage);
    expect(image).toContain('radial-gradient');
    expect(image).toContain('linear-gradient');
});

test('keyboard focus draws a two pixel solid ring', async ({ page }) => {
    await page.goto('/#does-not-exist');
    const goHome = page.getByRole('link', { name: 'Go Home' });
    await expect(goHome).toBeVisible();
    await focusByKeyboard(page, goHome);
    await expect(goHome).toHaveCSS('outline-style', 'solid');
    await expect(goHome).toHaveCSS('outline-width', '2px');
});

test('reduced motion shortens transitions to the floor', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/#does-not-exist');
    const goHome = page.getByRole('link', { name: 'Go Home' });
    await expect(goHome).toBeVisible();
    const seconds = await goHome.evaluate((element) => {
        const first = getComputedStyle(element).transitionDuration.split(',')[0].trim();
        return first.endsWith('ms') ? parseFloat(first) / 1000 : parseFloat(first);
    });
    expect(seconds).toBeLessThanOrEqual(0.001);
});

test('text in the room passphrase field is left-aligned', async ({ page }) => {
    await page.goto('/#host');
    const field = page.locator('#roomPassphrase');
    await expect(field).toBeVisible();
    const align = await field.evaluate((element) => getComputedStyle(element).textAlign);
    expect(['left', 'start']).toContain(align);
});
