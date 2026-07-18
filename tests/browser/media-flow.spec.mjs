import { test, expect } from '@playwright/test';

async function installDeterministicDisplayCapture(page) {
    await page.addInitScript(() => {
        window.localStorage.setItem('nextra.hostGuideSeen', '1');
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
                context.fillStyle = 'white';
                context.font = '48px sans-serif';
                context.fillText(`Nextra ${frame}`, 40, 90);
                window.setTimeout(draw, 33);
            };
            draw();
            return canvas.captureStream(30);
        };
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: {
                getDisplayMedia: async () => createCapture(),
            },
        });
    });
}

async function startHost(hostPage) {
    await installDeterministicDisplayCapture(hostPage);
    await hostPage.goto('/#host');
    await hostPage.getByRole('button', { name: 'Start Sharing' }).click();
    await expect(hostPage.getByText(/Streaming \(/)).toBeVisible();
    const displayedCode = await hostPage.locator('.copy-field', { hasText: 'Room Code' })
        .locator('.copy-field-value').innerText();
    return displayedCode.replace(/-/g, '');
}

async function joinAndWatch(viewerPage, code) {
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
}

test('host and viewer receive decoded frames through direct WebRTC and can rejoin', async ({ browser, request }) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();

    const code = await startHost(hostPage);
    await joinAndWatch(viewerPage, code);

    await viewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await expect(viewerPage.getByRole('button', { name: 'Join Room' })).toBeVisible();
    await joinAndWatch(viewerPage, code);

    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await hostPage.getByRole('dialog').getByRole('button', { name: 'Stop Sharing' }).click();
    await expect(viewerPage.getByText('Host has ended the stream')).toBeVisible();
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 0 } });

    await viewerContext.close();
    await hostContext.close();
});

test('capture-track end and host route unmount reclaim the room', async ({ browser, request }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await startHost(page);

    await page.locator('video').evaluate((video) => {
        const track = video.srcObject.getVideoTracks()[0];
        track.stop();
        // MediaStreamTrack.stop() itself deliberately does not emit `ended`;
        // capture devices emit it when the source ends, which this synthetic
        // capture models explicitly.
        track.dispatchEvent(new Event('ended'));
    });
    await expect(page.getByRole('button', { name: 'Start Sharing' })).toBeVisible();
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 0 } });

    await startHost(page);
    await page.goto('/#privacy');
    await expect(page.getByRole('heading', { name: /Privacy/i })).toBeVisible();
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 0 } });
    await context.close();
});

test('reload recovery keeps the room code and concurrent stop/unmount is idempotent', async ({ browser, request }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installDeterministicDisplayCapture(page);
    await page.goto('/#host');
    await page.locator('details.advanced-settings summary').click();
    await page.getByLabel('Allow recovery after reload').check();
    await page.getByRole('button', { name: 'Start Sharing' }).click();
    await expect(page.getByText(/Streaming \(/)).toBeVisible();
    const originalCode = (await page.locator('.copy-field', { hasText: 'Room Code' })
        .locator('.copy-field-value').innerText()).replace(/-/g, '');
    await expect.poll(() => page.evaluate(() => (
        window.sessionStorage.getItem('nextra.hostRecovery.v1')
    ))).not.toBeNull();

    await page.reload();
    await expect.poll(() => page.evaluate(() => (
        window.sessionStorage.getItem('nextra.hostRecovery.v1')
    ))).not.toBeNull();
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 1 } });
    await page.getByRole('button', { name: 'Resume Sharing' }).click();
    await expect(page.getByText(/Streaming \(/)).toBeVisible();
    const resumedCode = (await page.locator('.copy-field', { hasText: 'Room Code' })
        .locator('.copy-field-value').innerText()).replace(/-/g, '');
    expect(resumedCode).toBe(originalCode);

    await page.evaluate(() => {
        const stop = [...document.querySelectorAll('button')]
            .find((button) => button.textContent.trim() === 'Stop Sharing');
        stop.click();
        window.location.hash = '#privacy';
    });
    await expect(page.getByRole('heading', { name: /Privacy/i })).toBeVisible();
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 0 } });
    await context.close();
});
