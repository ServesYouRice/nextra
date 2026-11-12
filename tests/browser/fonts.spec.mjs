import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientBuildDir } from './clientBuild.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the app serves Inter and JetBrains Mono from its own origin', async ({ page, baseURL }) => {
    const origin = new URL(baseURL).origin;
    const fontRequests = [];
    const consoleMessages = [];
    page.on('request', (request) => {
        if (request.resourceType() === 'font') fontRequests.push(request.url());
    });
    page.on('console', (message) => consoleMessages.push(message.text()));

    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('16px "Inter Variable"'))).toBe(true);

    await page.goto('/#status');
    // The status figures are the first text set in the monospace face; the
    // browser loads a face only once something uses it.
    await expect(page.locator('.stat-value').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('16px "JetBrains Mono Variable"'))).toBe(true);

    expect(fontRequests.length).toBeGreaterThan(0);
    for (const url of fontRequests) {
        const parsed = new URL(url);
        expect(parsed.origin).toBe(origin);
        expect(parsed.pathname).toMatch(/\.woff2$/);
    }
    expect(consoleMessages.filter((text) => /Refused to load the font/.test(text))).toEqual([]);
});

test('no built stylesheet inlines a data: URL', () => {
    const assetsDir = path.join(clientBuildDir(projectRoot), 'assets');
    const cssFiles = fs.readdirSync(assetsDir).filter((name) => name.endsWith('.css'));
    expect(cssFiles.length).toBeGreaterThan(0);
    for (const name of cssFiles) {
        expect(fs.readFileSync(path.join(assetsDir, name), 'utf8'), name).not.toContain('url(data:');
    }
});
