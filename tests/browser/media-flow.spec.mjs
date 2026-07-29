import { test, expect, devices } from '@playwright/test';

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

async function startHost(hostPage, { passphrase = '' } = {}) {
    await installDeterministicDisplayCapture(hostPage);
    await hostPage.goto('/#host');
    if (passphrase) {
        await hostPage.getByText('Advanced settings', { exact: true }).click();
        await hostPage.getByLabel('Optional room passphrase').fill(passphrase);
    }
    await hostPage.getByRole('button', { name: 'Start Sharing' }).click();
    await expect(hostPage.getByText(/Streaming \(/)).toBeVisible();
    const displayedCode = await hostPage.locator('.copy-field', { hasText: 'Room Code' })
        .locator('.copy-field-value').innerText();
    return displayedCode.replace(/-/g, '');
}

async function installFullscreenStub(page) {
    await page.addInitScript(() => {
        let fullscreenElement = null;
        Object.defineProperty(document, 'fullscreenElement', {
            configurable: true,
            get: () => fullscreenElement,
        });
        HTMLElement.prototype.requestFullscreen = async function requestFullscreen() {
            fullscreenElement = this;
            document.dispatchEvent(new Event('fullscreenchange'));
        };
        document.exitFullscreen = async () => {
            fullscreenElement = null;
            document.dispatchEvent(new Event('fullscreenchange'));
        };
    });
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

async function joinAndWatchRelay(viewerPage, code) {
    await viewerPage.goto(`https://nextra.cloudflare.test:3210/#watch/${code}`);
    await viewerPage.getByRole('button', { name: 'Join Room' }).click();
    await viewerPage.getByRole('button', { name: 'Watch Stream' }).click();
    await expect(viewerPage.getByText(/relay mode active/i)).toBeVisible();
    await expect.poll(() => viewerPage.locator('video').evaluate((video) => (
        video.videoWidth > 0
        && video.videoHeight > 0
        && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        && video.currentTime > 0
    ))).toBe(true);
}

// Stop Sharing only asks for confirmation while viewers are still connected.
async function confirmStopIfPrompted(hostPage) {
    const confirmStopButton = hostPage.getByRole('dialog').getByRole('button', { name: 'Stop Sharing' });
    if (await confirmStopButton.isVisible()) {
        await confirmStopButton.click();
    }
}

async function getOnlyRoom(request) {
    const metrics = await (await request.get('/api/metrics')).json();
    return metrics.rooms.list.length === 1 ? metrics.rooms.list[0] : null;
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
    await expect(viewerPage.getByRole('alert')).toHaveText('Host stopped sharing');
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 0 } });

    await viewerContext.close();
    await hostContext.close();
});

test('a mobile Chrome viewer joins and receives decoded frames', async ({ browser, request }) => {
    const hostContext = await browser.newContext();
    // Backs the "Viewer, WebRTC / Mobile Chrome: Tested" row of the README
    // support table. Hosting stays desktop-only, as the same table records.
    const viewerContext = await browser.newContext({ ...devices['Pixel 5'] });
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();

    const code = await startHost(hostPage);
    await joinAndWatch(viewerPage, code);

    await viewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await expect(viewerPage.getByLabel('Room code')).toBeVisible();

    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(hostPage);
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 0 } });

    await viewerContext.close();
    await hostContext.close();
});

test('a protected room asks for its passphrase as a focused second step and keeps the code', async ({ browser, request }) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();
    const code = await startHost(hostPage, { passphrase: 'open sesame' });

    await viewerPage.goto(`/#watch/${code}`);
    const codeInput = viewerPage.getByLabel('Room code');
    await expect(codeInput).toHaveValue(code);
    await viewerPage.getByRole('button', { name: 'Join Room' }).click();

    const passphraseInput = viewerPage.getByLabel('Room passphrase');
    await expect(viewerPage.getByText(/requires a passphrase.*code has been kept/i)).toBeVisible();
    await expect(codeInput).toHaveValue(code);
    await expect(passphraseInput).toBeFocused();
    await passphraseInput.fill('open sesame');
    await passphraseInput.press('Enter');
    await expect(viewerPage.getByRole('button', { name: 'Watch Stream' })).toBeVisible();

    await viewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(hostPage);
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 0 } });
    await viewerContext.close();
    await hostContext.close();
});

test('fullscreen control exposes pressed state and exits fullscreen', async ({ browser, request }) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();
    await installFullscreenStub(viewerPage);
    const code = await startHost(hostPage);
    await joinAndWatch(viewerPage, code);

    const enterFullscreen = viewerPage.getByRole('button', { name: 'Fullscreen', exact: true });
    await expect(enterFullscreen).toHaveAttribute('aria-pressed', 'false');
    await enterFullscreen.click();
    const exitFullscreen = viewerPage.getByRole('button', { name: 'Exit Fullscreen' });
    await expect(exitFullscreen).toHaveAttribute('aria-pressed', 'true');
    await exitFullscreen.click();
    await expect(enterFullscreen).toHaveAttribute('aria-pressed', 'false');

    await viewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(hostPage);
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 0 } });
    await viewerContext.close();
    await hostContext.close();
});

test('the streaming frame-rate control is a labelled group with programmatic selection', async ({ browser, request }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await startHost(page);

    const frameRateGroup = page.getByRole('group', { name: 'Frame rate' });
    const sixty = frameRateGroup.getByRole('button', { name: '60 fps' });
    const thirty = frameRateGroup.getByRole('button', { name: '30 fps' });

    await expect(thirty).toHaveAttribute('aria-pressed', 'true');
    await expect(sixty).toHaveAttribute('aria-pressed', 'false');

    await sixty.click();
    await expect(sixty).toHaveAttribute('aria-pressed', 'true');
    await expect(thirty).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText(/Streaming \(.*@ 60fps\)/)).toBeVisible();

    await page.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(page);
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 0 } });
    await context.close();
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

test('delayed relay-first viewers select one fresh recorder generation and clean up after rejoin', async ({ browser, request }) => {
    const hostContext = await browser.newContext();
    const firstViewerContext = await browser.newContext();
    const secondViewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const firstViewerPage = await firstViewerContext.newPage();
    const secondViewerPage = await secondViewerContext.newPage();

    const code = await startHost(hostPage);
    await expect.poll(async () => (await getOnlyRoom(request))?.mediaGeneration || 0).toBeGreaterThan(0);
    const prewarmGeneration = (await getOnlyRoom(request)).mediaGeneration;
    await hostPage.waitForTimeout(2_000);

    await joinAndWatchRelay(firstViewerPage, code);
    await expect.poll(async () => (await getOnlyRoom(request))?.mediaGeneration || 0)
        .toBeGreaterThan(prewarmGeneration);
    const firstAudienceGeneration = (await getOnlyRoom(request)).mediaGeneration;

    await joinAndWatchRelay(secondViewerPage, code);
    await secondViewerPage.waitForTimeout(1_000);
    expect((await getOnlyRoom(request)).mediaGeneration).toBe(firstAudienceGeneration);

    await secondViewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await firstViewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await expect.poll(async () => {
        const room = await getOnlyRoom(request);
        return room ? room.mediaGeneration : 'room-missing';
    }).toBeNull();

    await joinAndWatchRelay(firstViewerPage, code);
    await expect.poll(async () => (await getOnlyRoom(request))?.mediaGeneration || 0)
        .toBeGreaterThan(firstAudienceGeneration);

    await firstViewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(hostPage);
    await expect.poll(async () => (await request.get('/api/metrics')).json()).toMatchObject({
        rooms: {
            active: 0,
            totalRelayViewers: 0,
            totalMediasoupConsumers: 0,
        },
    });

    await secondViewerContext.close();
    await firstViewerContext.close();
    await hostContext.close();
});
