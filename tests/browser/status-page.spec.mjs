import { test, expect } from '@playwright/test';

const NOW = Date.now();

const PAYLOAD = {
    rooms: {
        active: 2,
        totalViewers: 2,
        totalWhepViewers: 1,
        totalRelayViewers: 1,
        totalMediasoupConsumers: 3,
        list: [
            {
                code: 'ABC123',
                ingestMode: 'browser',
                hasProducer: true,
                whipConnected: false,
                viewerCount: 2,
                relayViewerCount: 1,
                whepViewerCount: 1,
                mediasoupConsumerCount: 3,
                createdAt: NOW - 5 * 60 * 1000 - 5000,
            },
            {
                code: 'XYZ789',
                ingestMode: 'obs',
                obsAv1Mode: true,
                hasProducer: false,
                whipConnected: false,
                viewerCount: 0,
                relayViewerCount: 0,
                whepViewerCount: 0,
                mediasoupConsumerCount: 0,
                createdAt: NOW - (2 * 3600 + 5 * 60) * 1000 - 5000,
            },
        ],
    },
    sockets: {
        uptimeSec: 540,
        counters: { activeProducers: 1, activeConsumers: 3, activeViewers: 2, activeRelayViewers: 1 },
        rooms: [],
    },
};

async function serveMetrics(page, { failAfterFirst = false } = {}) {
    let calls = 0;
    await page.route('**/api/metrics*', (route) => {
        calls += 1;
        if (failAfterFirst && calls > 1) return route.fulfill({ status: 500, body: 'boom' });
        return route.fulfill({ json: PAYLOAD });
    });
}

test('the status page shows a health line, three numbers and one line per room', async ({ page }) => {
    await serveMetrics(page);
    await page.goto('/#status');

    await expect(page.getByRole('heading', { name: 'Server Status' })).toBeVisible();
    const health = page.locator('.status-health');
    await expect(health).toContainText('All good');
    await expect(health).toContainText('up 9 min');

    const cards = page.locator('.stat-card:visible');
    await expect(cards).toHaveCount(3);
    const expected = [['Rooms open', '2'], ['People watching', '3'], ['On the backup connection', '1']];
    for (const [i, [label, value]] of expected.entries()) {
        await expect(cards.nth(i)).toContainText(label);
        await expect(cards.nth(i).locator('.stat-value')).toHaveText(value);
    }

    const rooms = page.locator('.status-rooms li');
    await expect(rooms).toHaveCount(2);
    for (const text of ['ABC-123', 'Live', 'From this browser', '3 watching', '5 min']) {
        await expect(rooms.nth(0)).toContainText(text);
    }
    for (const text of ['XYZ-789', 'Host paused', 'From OBS · AV1', '0 watching', '2 h 5 min']) {
        await expect(rooms.nth(1)).toContainText(text);
    }
    await expect(page.getByText('idle')).toHaveCount(0);
});

test('engineer numbers sit in a closed section until it is opened', async ({ page }) => {
    await serveMetrics(page);
    await page.goto('/#status');
    await expect(page.locator('.status-rooms li')).toHaveCount(2);

    await expect(page.getByText('WebRTC viewers')).toBeHidden();
    await expect(page.getByText('Relay subscribers')).toBeHidden();

    await page.getByText('More numbers for troubleshooting').click();
    await expect(page.getByText('WebRTC viewers')).toBeVisible();
    await expect(page.getByText('Relay subscribers')).toBeVisible();
    await expect(page.locator('.status-more .data-table th')).toHaveCount(9);
});

test('a failed refresh turns the health line to Not updating', async ({ page }) => {
    await serveMetrics(page, { failAfterFirst: true });
    await page.clock.install();
    await page.goto('/#status');
    await expect(page.locator('.status-health')).toContainText('All good');

    await page.clock.fastForward(6000);
    await expect(page.locator('.status-health')).toContainText('Not updating');
    await expect(page.getByRole('alert').filter({ hasText: /^Refresh failed/ })).toBeVisible();
});

test('on a phone each room fits and the page does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await serveMetrics(page);
    await page.goto('/#status');
    await expect(page.locator('.status-rooms li')).toHaveCount(2);

    for (const li of await page.locator('.status-rooms li').all()) {
        const box = await li.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(390);
        const overflow = await li.evaluate((el) => el.scrollWidth > el.clientWidth);
        expect(overflow).toBe(false);
    }
    const summary = await page.locator('.status-more > summary').boundingBox();
    expect(summary.height).toBeGreaterThanOrEqual(44);
    const scrollsSideways = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(scrollsSideways).toBe(false);
});
