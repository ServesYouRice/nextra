import { test, expect } from '@playwright/test';

const ERR_RGB = 'rgb(229, 91, 91)';

test('the join card is centred and shows the code in six boxes', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#watch');

    await expect(page.getByRole('heading', { name: 'Join a stream' })).toBeVisible();
    const card = page.locator('.join-card');
    const cardBox = await card.boundingBox();
    expect(Math.abs(cardBox.x + cardBox.width / 2 - 1440 / 2)).toBeLessThanOrEqual(2);
    expect(cardBox.width).toBeLessThanOrEqual(416);

    const boxes = page.locator('.code-box');
    await expect(boxes).toHaveCount(6);
    await expect(boxes).toHaveText(['', '', '', '', '', '']);

    const codeInput = page.getByLabel('Room code');
    await codeInput.focus();
    await page.keyboard.type('ab1');
    await expect(codeInput).toHaveValue('AB1');
    await expect(boxes).toHaveText(['A', 'B', '1', '', '', '']);
    await expect(page.locator('#joinHint')).toHaveText('3/6 characters');

    await page.keyboard.type('2c3');
    await expect(codeInput).toHaveValue('AB1-2C3');
    await expect(boxes).toHaveText(['A', 'B', '1', '2', 'C', '3']);

    const button = page.getByRole('button', { name: 'Join Room' });
    await expect(button).toHaveClass(/btn-main/);
    const buttonBox = await button.boundingBox();
    const innerWidth = await card.evaluate((el) => {
        const style = getComputedStyle(el);
        return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    });
    expect(Math.abs(buttonBox.width - innerWidth)).toBeLessThanOrEqual(2);
});

test('a pasted watch link fills the boxes', async ({ page }) => {
    await page.goto('/#watch');
    const codeInput = page.getByLabel('Room code');
    await codeInput.fill('https://example.test/#watch/QWE789');
    await expect(codeInput).toHaveValue('QWE-789');
    await expect(page.locator('.code-box')).toHaveText(['Q', 'W', 'E', '7', '8', '9']);
});

test('a code that arrives in the link is shown with its hyphen', async ({ page }) => {
    await page.goto('/#watch/QWE789');
    await expect(page.getByLabel('Room code')).toHaveValue('QWE-789');
});

test('errors sit under the boxes and turn them red', async ({ page }) => {
    await page.goto('/#watch');
    await page.getByRole('button', { name: 'Join Room' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toHaveText('Please enter a room code.');
    const entryBox = await page.locator('.code-entry').boundingBox();
    const alertBox = await alert.boundingBox();
    const buttonBox = await page.getByRole('button', { name: 'Join Room' }).boundingBox();
    expect(alertBox.y).toBeGreaterThanOrEqual(entryBox.y + entryBox.height - 1);
    expect(alertBox.y + alertBox.height).toBeLessThanOrEqual(buttonBox.y + 1);
    await expect(page.locator('.join-card').getByRole('alert')).toHaveCount(1);

    const boxes = page.locator('.code-box');
    for (let index = 0; index < 6; index += 1) {
        await expect(boxes.nth(index)).toHaveCSS('border-top-color', ERR_RGB);
    }
});

test('an unknown room says what to do next', async ({ page }) => {
    await page.goto('/#watch');
    const codeInput = page.getByLabel('Room code');
    await codeInput.fill('ZZZ999');
    await page.getByRole('button', { name: 'Join Room' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toContainText(/^No room has this code\./);
    await expect(codeInput).toHaveAttribute('aria-invalid', 'true');

    await page.getByRole('button', { name: 'Try another code' }).click();
    await expect(codeInput).toHaveValue('');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(codeInput).toBeFocused();
});

test('the join card fits a phone', async ({ page }) => {
    for (const { width, height } of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
        await page.setViewportSize({ width, height });
        await page.goto('/#watch');
        await expect(page.locator('.join-card')).toBeVisible();

        const cardBox = await page.locator('.join-card').boundingBox();
        expect(cardBox.x, `card left at ${width}px`).toBeGreaterThanOrEqual(16);
        expect(width - (cardBox.x + cardBox.width), `card right at ${width}px`).toBeGreaterThanOrEqual(16);

        const boxes = await page.locator('.code-box').evaluateAll((els) => els.map((el) => {
            const rect = el.getBoundingClientRect();
            return { top: Math.round(rect.top), right: rect.right };
        }));
        expect(new Set(boxes.map((box) => box.top)).size, `one row at ${width}px`).toBe(1);
        expect(Math.max(...boxes.map((box) => box.right))).toBeLessThanOrEqual(width);

        const buttonBox = await page.getByRole('button', { name: 'Join Room' }).boundingBox();
        expect(buttonBox.height, `button height at ${width}px`).toBeGreaterThanOrEqual(44);

        const metrics = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
        }));
        expect(metrics.scrollWidth, `sideways scroll at ${width}px`).toBeLessThanOrEqual(metrics.clientWidth + 1);
    }
});
