import { test, expect } from '@playwright/test';

// A capture picker the test answers by hand, so the host view can be torn down
// while handleStartSharing is still waiting for getDisplayMedia.
async function installPendingDisplayCapture(page) {
    await page.addInitScript(() => {
        const capture = { requested: 0, stream: null, resolve: null };
        window.__pendingCapture = capture;
        const createCapture = () => {
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 360;
            const context = canvas.getContext('2d');
            let frame = 0;
            const draw = () => {
                frame += 1;
                context.fillStyle = `hsl(${frame % 360} 80% 45%)`;
                context.fillRect(0, 0, canvas.width, canvas.height);
                window.setTimeout(draw, 33);
            };
            draw();
            return canvas.captureStream(30);
        };
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: {
                getDisplayMedia: () => new Promise((resolve) => {
                    capture.requested += 1;
                    capture.resolve = () => {
                        capture.stream = createCapture();
                        resolve(capture.stream);
                    };
                }),
            },
        });
    });
}

async function readMetrics(request) {
    return (await request.get('/api/metrics')).json();
}

test('leaving the host page while the capture picker is open stops the late capture and creates no room', async ({ page, request }) => {
    const roomsCreatedBefore = (await readMetrics(request)).sockets.counters.roomsCreated;
    await installPendingDisplayCapture(page);
    await page.goto('/#host');
    await page.getByRole('button', { name: 'Start Sharing' }).click();
    await expect(page.getByRole('button', { name: 'Connecting...' })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => window.__pendingCapture.requested)).toBe(1);

    // Nothing is shared yet, so the route change is not guarded and the host
    // view unmounts while the picker is still open.
    await page.goto('/#privacy');
    await expect(page.getByRole('heading', { name: /Privacy/i })).toBeVisible();
    // The unmount teardown runs one task after the view is removed.
    await page.waitForTimeout(250);

    await page.evaluate(() => window.__pendingCapture.resolve());
    // Long enough for a continuation that went on to create and publish a room.
    await page.waitForTimeout(1_000);

    // The late capture belongs to a torn-down session: no room is created for
    // it, and its tracks are stopped instead of being published.
    const metrics = await readMetrics(request);
    expect.soft(metrics.sockets.counters.roomsCreated, 'rooms created after teardown').toBe(roomsCreatedBefore);
    expect.soft(metrics.rooms.active, 'active rooms').toBe(0);
    await expect.poll(() => page.evaluate(() => (
        window.__pendingCapture.stream.getTracks().map((track) => track.readyState)
    )), { message: 'late capture track states', timeout: 5_000 }).toEqual(['ended']);
});
