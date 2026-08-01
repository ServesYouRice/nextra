import { test, expect } from '@playwright/test';

async function installDeterministicDisplayCapture(page) {
    await page.addInitScript(() => {
        window.localStorage.setItem('nextra.hostGuideSeen', '1');
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: {
                getDisplayMedia: async () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 640;
                    canvas.height = 360;
                    const context = canvas.getContext('2d');
                    let frame = 0;
                    const draw = () => {
                        frame += 1;
                        context.fillStyle = `hsl(${frame % 360} 80% 45%)`;
                        context.fillRect(0, 0, canvas.width, canvas.height);
                        context.fillStyle = 'white';
                        context.font = '48px sans-serif';
                        context.fillText(`Nextra ${frame}`, 40, 90);
                        window.setTimeout(draw, 33);
                    };
                    draw();
                    return canvas.captureStream(30);
                },
            },
        });
    });
}

test('packaged executable delivers decoded frames after media-worker replacement', async ({ browser, request }) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();

    await installDeterministicDisplayCapture(hostPage);
    await hostPage.goto('/#host');
    await hostPage.getByRole('button', { name: 'Start Sharing' }).click();
    await expect(hostPage.getByText(/Streaming \(/)).toBeVisible();
    const localLink = await hostPage.locator('.copy-field', { hasText: 'Local Link' })
        .locator('.copy-field-value').innerText();
    const code = localLink.trim().split('#watch/')[1];

    await viewerPage.goto(`/#watch/${code}`);
    await viewerPage.getByRole('button', { name: 'Join Room' }).click();
    await viewerPage.getByRole('button', { name: 'Watch Stream' }).click();
    await expect(viewerPage.getByText(/WebRTC mode active/)).toBeVisible();
    await expect.poll(() => viewerPage.locator('video').evaluate((video) => (
        video.videoWidth > 0
        && video.videoHeight > 0
        && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        && video.currentTime > 0
    ))).toBe(true);

    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await hostPage.getByRole('dialog').getByRole('button', { name: 'Stop Sharing' }).click();
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 0 } });

    await viewerContext.close();
    await hostContext.close();
});
