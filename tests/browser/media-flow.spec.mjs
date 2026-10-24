import { test, expect, devices } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function installDeterministicDisplayCapture(page) {
    await page.addInitScript(() => {
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

// The host panel shows only share links, so the room code is read back out of
// the local watch link rather than a dedicated field.
async function readRoomCode(hostPage) {
    const localLink = await hostPage.locator('.copy-field', { hasText: 'Local Link' })
        .locator('.copy-field-value').innerText();
    const code = localLink.trim().split('#watch/')[1];
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    return code;
}

async function startHost(hostPage, { passphrase = '' } = {}) {
    await installDeterministicDisplayCapture(hostPage);
    await hostPage.goto('/#host');
    if (passphrase) {
        await hostPage.getByLabel('Optional room passphrase').fill(passphrase);
    }
    await hostPage.getByRole('button', { name: 'Start Sharing' }).click();
    await expect(hostPage.getByText(/Streaming \(/)).toBeVisible();
    return readRoomCode(hostPage);
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

// Lets a test hold back the media-init events a viewer receives and drop the
// viewer's Socket.IO WebSocket, which socket.io-client then re-establishes
// under a new socket.id (the viewer's reconnect path). Engine.IO reads the
// WebSocket constructor when its bundle loads, so this runs before the page.
async function installViewerSocketControl(page) {
    await page.addInitScript(() => {
        const NativeWebSocket = window.WebSocket;
        const control = { withholdMediaInit: false, withheldMediaInit: 0, sockets: [] };
        window.__nextraSocketControl = control;
        class ControlledWebSocket extends NativeWebSocket {
            constructor(...args) {
                super(...args);
                control.sockets.push(this);
            }

            get onmessage() {
                return super.onmessage;
            }

            set onmessage(handler) {
                super.onmessage = typeof handler === 'function'
                    ? (event) => {
                        if (control.withholdMediaInit
                            && typeof event.data === 'string'
                            && event.data.startsWith('42["media-init"')) {
                            control.withheldMediaInit += 1;
                            return;
                        }
                        handler.call(this, event);
                    }
                    : handler;
            }
        }
        window.WebSocket = ControlledWebSocket;
    });
}

// Lets a test make a viewer's WebRTC start stall the way an unreachable
// connection does, from the moment it switches the flags on: ICE finds no usable
// candidate (the peer connection may only use relay candidates, and the test
// server offers no TURN server) and video.play() on a MediaStream never settles
// (it stays pending until media arrives). The relay path attaches no
// srcObject, so its play() calls are untouched.
async function installWebRtcStall(page) {
    await page.addInitScript(() => {
        const stall = { blockIce: false, hangPlay: false, hungPlays: 0 };
        window.__nextraStall = stall;
        const NativePeerConnection = window.RTCPeerConnection;
        window.RTCPeerConnection = class StalledPeerConnection extends NativePeerConnection {
            constructor(configuration = {}, ...rest) {
                super(stall.blockIce ? { ...configuration, iceTransportPolicy: 'relay' } : configuration, ...rest);
            }
        };
        const nativePlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function play(...args) {
            if (stall.hangPlay && this.srcObject) {
                stall.hungPlays += 1;
                return new Promise(() => { });
            }
            return nativePlay.apply(this, args);
        };
    });
}

// The server's port, read from the baseURL playwright.config.mjs sets from
// NEXTRA_E2E_PORT, so a run on another port needs no change here.
function serverPort(testInfo) {
    const url = new URL(testInfo.project.use.baseURL);
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
}

async function joinAndWatchRelay(viewerPage, code, testInfo) {
    await viewerPage.goto(`https://nextra.cloudflare.test:${serverPort(testInfo)}/#watch/${code}`);
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

// Keeps every MediaRecorder the host page makes, so a test can read the relay
// format and stand in for a recorder failure. Without MP4 the host records VP8,
// as a browser without MP4 recording does.
async function trackHostRecorders(page, { recordMp4 = true } = {}) {
    await page.addInitScript((allowMp4) => {
        const NativeMediaRecorder = window.MediaRecorder;
        window.__nextraRecorders = [];
        window.MediaRecorder = class TrackedMediaRecorder extends NativeMediaRecorder {
            static isTypeSupported(type) {
                if (!allowMp4 && String(type).startsWith('video/mp4')) return false;
                return NativeMediaRecorder.isTypeSupported(type);
            }

            constructor(...args) {
                super(...args);
                window.__nextraRecorders.push(this);
            }
        };
    }, recordMp4);
}

// Holds what the viewer's WebSocket receives and hands it over in one task, as
// a connection that stalls and then catches up does.
async function installHeldWebSocket(page) {
    await page.addInitScript(() => {
        const NativeWebSocket = window.WebSocket;
        const held = [];
        let holding = false;
        window.__nextraHoldSocket = () => { holding = true; };
        window.__nextraReleaseSocket = () => {
            holding = false;
            const batch = held.splice(0);
            for (const deliver of batch) deliver();
            return batch.length;
        };
        window.WebSocket = class HeldWebSocket extends NativeWebSocket {
            get onmessage() {
                return super.onmessage;
            }

            set onmessage(handler) {
                super.onmessage = handler && ((event) => {
                    if (holding) {
                        held.push(() => handler.call(this, event));
                        return;
                    }
                    handler.call(this, event);
                });
            }
        };
    });
}

async function getRoomByCode(request, code) {
    const metrics = await (await request.get('/api/metrics')).json();
    return metrics.rooms.list.find((room) => room.code === code) || null;
}

async function videoTime(page) {
    return page.locator('video').evaluate((video) => video.currentTime);
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

async function measureLiveWebRtcTopology(testInfo) {
    const { stdout } = await execFileAsync(process.execPath, [
        'scripts/benchmark-runtime.js',
        `--url=${testInfo.project.use.baseURL}`,
        '--scenario=webrtc',
        '--label=e2e-360p30-one-viewer',
        '--allow-insecure-tls',
        '--duration-ms=1500',
        '--sample-ms=250',
        '--clients=2',
        '--ack-interval-ms=100',
        '--max-ack-p95-ms=1000',
        '--max-event-loop-p95-ms=1000',
        '--max-event-loop-max-ms=2000',
        '--max-worker-cpu-percent=1000',
        '--max-process-cpu-percent=1000',
        '--max-memory-growth-percent=1000',
    ], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
        timeout: 15_000,
    });
    return JSON.parse(stdout);
}

test('Host preflight blocks an unavailable Browser capture path before room allocation', async ({ page, request }) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
            configurable: true,
            value: undefined,
        });
    });
    await page.goto('/#host');
    await page.getByRole('button', { name: 'Start Sharing' }).click();

    await expect(page.getByRole('alert')).toContainText('Screen capture is unavailable');
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 0 } });
});

test('host and viewer receive decoded frames through direct WebRTC and can rejoin', async ({ browser, request }, testInfo) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();

    const code = await startHost(hostPage);
    await joinAndWatch(viewerPage, code);

    await viewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await expect(viewerPage.getByRole('button', { name: 'Join Room' })).toBeVisible();
    await joinAndWatch(viewerPage, code);

    const measurement = await measureLiveWebRtcTopology(testInfo);
    expect(measurement.pass).toBe(true);
    expect(measurement.measurement.scenario).toBe('webrtc');
    expect(measurement.topology.producers).toBeGreaterThanOrEqual(1);
    expect(measurement.topology.consumers).toBeGreaterThanOrEqual(1);
    expect(measurement.headroomPercent).toEqual(expect.objectContaining({
        ackP95: expect.any(Number),
        eventLoopP95: expect.any(Number),
        processCpu: expect.any(Number),
    }));

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
    const viewerContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
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

    await expect(hostPage.getByText('Local Link')).toBeVisible();

    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(hostPage);
    await expect(viewerPage.getByText(/This room has ended/)).toBeVisible();
    await viewerPage.getByRole('button', { name: 'Leave Room' }).click();
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

    await expect(sixty).toHaveAttribute('aria-pressed', 'true');
    await expect(thirty).toHaveAttribute('aria-pressed', 'false');

    await thirty.click();
    await expect(thirty).toHaveAttribute('aria-pressed', 'true');
    await expect(sixty).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText(/Streaming \(.*@ 30fps\)/)).toBeVisible();

    await page.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(page);
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 0 } });

    // Resolution and frame rate persist per browser, so a later host session in
    // the same profile reopens with the last-used pair instead of the defaults.
    const returningPage = await context.newPage();
    await installDeterministicDisplayCapture(returningPage);
    await returningPage.goto('/#host');
    const returningFrameRate = returningPage.getByRole('group', { name: 'Frame rate' });
    await expect(returningFrameRate.getByRole('button', { name: '30 fps' })).toHaveAttribute('aria-pressed', 'true');
    await expect(returningFrameRate.getByRole('button', { name: '60 fps' })).toHaveAttribute('aria-pressed', 'false');
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
    // Leaving mid-stream now asks first; the room is reclaimed on confirm.
    await expect(page.getByRole('heading', { name: 'Leave the host page?' })).toBeVisible();
    await page.getByRole('button', { name: 'Leave and Stop' }).click();
    await expect(page.getByRole('heading', { name: /Privacy/i })).toBeVisible();
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 0 } });
    await context.close();
});

test('leaving the host route while sharing is warned and can be cancelled', async ({ browser, request }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const code = await startHost(page);

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Status' }).click();
    await expect(page.getByRole('heading', { name: 'Leave the host page?' })).toBeVisible();

    await page.getByRole('button', { name: 'Stay Here' }).click();
    // Declining keeps the stream up, the route on #host, and the address bar in
    // step with it so a following click is not a same-hash no-op.
    await expect(page.getByText(/Streaming \(/)).toBeVisible();
    expect(await page.evaluate(() => window.location.hash)).toBe('#host');
    expect(await readRoomCode(page)).toBe(code);
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 1 } });

    // Stopping first releases the guard, so the next navigation goes straight through.
    await page.getByRole('button', { name: 'Stop Sharing' }).click();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Status' }).click();
    await expect(page.getByRole('heading', { name: 'Server Status' })).toBeVisible();
    await context.close();
});

test('reload recovery keeps the room code and concurrent stop/unmount is idempotent', async ({ browser, request }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installDeterministicDisplayCapture(page);
    await page.goto('/#host');
    await page.getByLabel('Allow recovery after reload').check();
    await page.getByRole('button', { name: 'Start Sharing' }).click();
    await expect(page.getByText(/Streaming \(/)).toBeVisible();
    const originalCode = await readRoomCode(page);
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
    const resumedCode = await readRoomCode(page);
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

test('delayed relay-first viewers select one fresh recorder generation and clean up after rejoin', async ({ browser, request }, testInfo) => {
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

    await joinAndWatchRelay(firstViewerPage, code, testInfo);
    await expect.poll(async () => (await getOnlyRoom(request))?.mediaGeneration || 0)
        .toBeGreaterThan(prewarmGeneration);
    const firstAudienceGeneration = (await getOnlyRoom(request)).mediaGeneration;

    await joinAndWatchRelay(secondViewerPage, code, testInfo);
    await secondViewerPage.waitForTimeout(1_000);
    expect((await getOnlyRoom(request)).mediaGeneration).toBe(firstAudienceGeneration);

    await secondViewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await firstViewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await expect.poll(async () => {
        const room = await getOnlyRoom(request);
        return room ? room.mediaGeneration : 'room-missing';
    }).toBeNull();

    await joinAndWatchRelay(firstViewerPage, code, testInfo);
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

// A new recorder generation reaches relay viewers that are already playing.
// The host falls back from MP4 to VP8 when the server cannot frame its MP4
// (relay-mp4-failed) or the MP4 recorder fails; the viewer's SourceBuffer was
// made for MP4.
test('a playing relay viewer follows the host recorder from MP4 to VP8', async ({ browser, request }, testInfo) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();
    await trackHostRecorders(hostPage);

    const code = await startHost(hostPage);
    await joinAndWatchRelay(viewerPage, code, testInfo);
    const relayMimeType = () => hostPage.evaluate(() => window.__nextraRecorders.at(-1)?.mimeType || '');
    test.skip(!(await relayMimeType()).startsWith('video/mp4'), 'the host browser does not record MP4');
    await expect.poll(async () => videoTime(viewerPage)).toBeGreaterThan(1);
    const mp4Generation = (await getRoomByCode(request, code)).mediaGeneration;

    // HostView's recorder.onerror for MP4: setRelayMp4Failed(true), and the
    // recorder restarts on VP8.
    await hostPage.evaluate(() => window.__nextraRecorders.at(-1).dispatchEvent(new Event('error')));
    await expect.poll(async () => (await getRoomByCode(request, code))?.mediaGeneration || 0).toBeGreaterThan(mp4Generation);
    expect(await relayMimeType()).toMatch(/^video\/webm/);

    const atSwitch = await videoTime(viewerPage);
    await expect.poll(async () => videoTime(viewerPage)).toBeGreaterThan(atSwitch + 3);
    expect(await viewerPage.locator('video').evaluate((video) => video.error?.code ?? null)).toBeNull();

    await viewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(hostPage);
    await expect.poll(async () => getRoomByCode(request, code)).toBeNull();
    await viewerContext.close();
    await hostContext.close();
});

// MediaRecorder timeslices end inside a WebM element, so the chunk after one
// finishes it. A viewer that is behind still holds old-generation chunks when
// the new generation's init arrives, and drops them.
test('a relay viewer that is behind keeps playing across a VP8 recorder restart', async ({ browser, request }, testInfo) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();
    await trackHostRecorders(hostPage, { recordMp4: false });
    await installHeldWebSocket(viewerPage);

    const code = await startHost(hostPage);
    await joinAndWatchRelay(viewerPage, code, testInfo);
    expect(await hostPage.evaluate(() => window.__nextraRecorders.at(-1)?.mimeType || '')).toMatch(/^video\/webm/);
    await expect.poll(async () => videoTime(viewerPage)).toBeGreaterThan(1);
    const firstGeneration = (await getRoomByCode(request, code)).mediaGeneration;

    await viewerPage.evaluate(() => window.__nextraHoldSocket());
    await hostPage.waitForTimeout(1_200);
    // A frame-rate change restarts the recorder: a new generation.
    const frameRate = hostPage.getByRole('group', { name: 'Frame rate' });
    await frameRate.locator('button[aria-pressed="false"]').first().click();
    await expect.poll(async () => (await getRoomByCode(request, code))?.mediaGeneration || 0).toBeGreaterThan(firstGeneration);
    await hostPage.waitForTimeout(1_000);
    expect(await viewerPage.evaluate(() => window.__nextraReleaseSocket())).toBeGreaterThan(4);

    const atRelease = await videoTime(viewerPage);
    await expect.poll(async () => videoTime(viewerPage)).toBeGreaterThan(atRelease + 3);
    expect(await viewerPage.locator('video').evaluate((video) => video.error?.code ?? null)).toBeNull();

    await viewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(hostPage);
    await expect.poll(async () => getRoomByCode(request, code)).toBeNull();
    await viewerContext.close();
    await hostContext.close();
});

test('a relay start superseded by a socket reconnect leaves no stale playback, error or subscription', async ({ browser, request }, testInfo) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();
    await installViewerSocketControl(viewerPage);

    const code = await startHost(hostPage);
    await viewerPage.goto(`https://nextra.cloudflare.test:${serverPort(testInfo)}/#watch/${code}`);
    await viewerPage.getByRole('button', { name: 'Join Room' }).click();
    const watchButton = viewerPage.getByRole('button', { name: 'Watch Stream' });
    await expect(watchButton).toBeEnabled();

    // A tunnel viewer's relay-first attempt waits up to 7 s for the live
    // media-init of the recorder generation its start triggers; hold it back
    // so the attempt is still waiting when the connection drops.
    await viewerPage.evaluate(() => { window.__nextraSocketControl.withholdMediaInit = true; });
    await watchButton.click();
    await expect.poll(() => viewerPage.evaluate(() => window.__nextraSocketControl.withheldMediaInit))
        .toBeGreaterThan(0);
    const liveInitWaitStartedAt = Date.now();

    await viewerPage.evaluate(() => window.__nextraSocketControl.sockets.at(-1).close());
    await expect.poll(() => viewerPage.evaluate(() => {
        const { sockets } = window.__nextraSocketControl;
        return sockets.length > 1 && sockets.at(-1).readyState === WebSocket.OPEN;
    })).toBe(true);
    // The reconnect rejoined the room on the new socket.id.
    await expect.poll(async () => (await getOnlyRoom(request))?.viewerCount).toBe(1);

    // Past the moment the superseded attempt's media-init wait gives up: it
    // must not report an error, start another playback mode, or leave a
    // relay subscription or consumer behind.
    await viewerPage.waitForTimeout(Math.max(0, liveInitWaitStartedAt + 9_500 - Date.now()));
    await expect(viewerPage.getByRole('alert')).toHaveCount(0);
    await expect(viewerPage.getByText(/WebRTC mode active|relay mode active/i)).toHaveCount(0);
    expect(await getOnlyRoom(request)).toMatchObject({
        viewerCount: 1,
        relayViewerCount: 0,
        mediasoupConsumerCount: 0,
    });
    expect(await viewerPage.locator('video').evaluate((video) => ({
        src: video.getAttribute('src') || '',
        hasStream: Boolean(video.srcObject),
    }))).toEqual({ src: '', hasStream: false });
    await expect(watchButton).toBeEnabled();

    // A new Watch on the reconnected socket plays through the relay.
    await viewerPage.evaluate(() => { window.__nextraSocketControl.withholdMediaInit = false; });
    await watchButton.click();
    await expect(viewerPage.getByText(/relay mode active/i)).toBeVisible();
    await expect.poll(() => viewerPage.locator('video').evaluate((video) => (
        video.videoWidth > 0
        && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        && video.currentTime > 0
    ))).toBe(true);
    expect((await getOnlyRoom(request)).relayViewerCount).toBe(1);

    await viewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(hostPage);
    await expect.poll(async () => (await request.get('/api/metrics')).json()).toMatchObject({
        rooms: {
            active: 0,
            totalRelayViewers: 0,
            totalMediasoupConsumers: 0,
        },
    });

    await viewerContext.close();
    await hostContext.close();
});

// With ICE blocked, the 8 s ICE wait ends the WebRTC start and the viewer falls
// back to the relay. The start used to await video.play() first; that promise
// never settles without media, so the ICE wait was never reached and only
// handleWatch's 40 s safety timer ended the attempt, with no fallback.
test('a WebRTC start whose video.play() never settles still times out in its ICE window and falls back to the relay', async ({ browser, request }) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();
    await installWebRtcStall(viewerPage);

    const code = await startHost(hostPage);
    await viewerPage.goto(`/#watch/${code}`);
    await viewerPage.getByRole('button', { name: 'Join Room' }).click();
    const watchButton = viewerPage.getByRole('button', { name: 'Watch Stream' });
    await expect(watchButton).toBeEnabled();
    await viewerPage.evaluate(() => Object.assign(window.__nextraStall, { blockIce: true, hangPlay: true }));

    const clickedAt = Date.now();
    await watchButton.click();
    await expect(viewerPage.getByText(/relay mode active/i)).toBeVisible({ timeout: 25_000 });
    expect(Date.now() - clickedAt, 'the ICE window, not the 40 s safety timer, ended the WebRTC start')
        .toBeLessThan(25_000);
    expect(await viewerPage.evaluate(() => window.__nextraStall.hungPlays),
        'the WebRTC start reached video.play()').toBeGreaterThan(0);
    await expect(viewerPage.getByRole('alert')).toHaveCount(0);
    expect(await getOnlyRoom(request)).toMatchObject({ viewerCount: 1, relayViewerCount: 1, mediasoupConsumerCount: 0 });

    await viewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(hostPage);
    await expect.poll(async () => (await request.get('/api/metrics')).json()).toMatchObject({
        rooms: { active: 0, totalRelayViewers: 0, totalMediasoupConsumers: 0 },
    });

    await viewerContext.close();
    await hostContext.close();
});

// The automatic recovery after a reconnect has no safety timer of its own: a
// WebRTC restart that stalls in video.play() used to leave the viewer on
// "Connecting..." for good.
test('a viewer whose WebRTC recovery after a reconnect stalls in video.play() falls back to the relay', async ({ browser, request }) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();
    await installViewerSocketControl(viewerPage);
    await installWebRtcStall(viewerPage);

    const code = await startHost(hostPage);
    await joinAndWatch(viewerPage, code);

    await viewerPage.evaluate(() => Object.assign(window.__nextraStall, { blockIce: true, hangPlay: true }));
    const droppedAt = Date.now();
    await viewerPage.evaluate(() => window.__nextraSocketControl.sockets.at(-1).close());
    await expect(viewerPage.getByText(/relay mode active/i)).toBeVisible({ timeout: 30_000 });
    expect(Date.now() - droppedAt, "the ICE window ended the recovery's WebRTC start").toBeLessThan(30_000);
    expect(await viewerPage.evaluate(() => window.__nextraStall.hungPlays),
        'the recovery reached video.play()').toBeGreaterThan(0);
    await expect(viewerPage.getByRole('alert')).toHaveCount(0);
    expect(await getOnlyRoom(request)).toMatchObject({ viewerCount: 1, relayViewerCount: 1, mediasoupConsumerCount: 0 });

    await viewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(hostPage);
    await expect.poll(async () => (await request.get('/api/metrics')).json()).toMatchObject({
        rooms: { active: 0, totalRelayViewers: 0, totalMediasoupConsumers: 0 },
    });

    await viewerContext.close();
    await hostContext.close();
});

test('capture denial shows alert copy, re-enables Start Sharing, and leaves zero active rooms', async ({ browser, request }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: {
                getDisplayMedia: async () => {
                    throw new DOMException('Permission denied', 'NotAllowedError');
                },
            },
        });
    });
    await page.goto('/#host');
    const startButton = page.getByRole('button', { name: 'Start Sharing' });
    await startButton.click();

    await expect(page.getByRole('alert')).toContainText('Screen sharing was cancelled.');
    await expect(startButton).toBeEnabled();
    await expect.poll(async () => (await request.get('/api/metrics')).json())
        .toMatchObject({ rooms: { active: 0 } });

    await context.close();
});

test('autoplay denial falls back to muted playback and unmuting control succeeds', async ({ browser, request }) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();

    await viewerPage.addInitScript(() => {
        const originalPlay = HTMLMediaElement.prototype.play;
        let rejectedOnce = false;
        HTMLMediaElement.prototype.play = async function play(...args) {
            if (!rejectedOnce && this.srcObject) {
                rejectedOnce = true;
                throw new DOMException('Autoplay blocked', 'NotAllowedError');
            }
            return originalPlay.apply(this, args);
        };
    });

    const code = await startHost(hostPage);

    await joinAndWatch(viewerPage, code);

    const videoLocator = viewerPage.locator('video');
    await expect(videoLocator).toHaveJSProperty('muted', true);

    const unmuteButton = viewerPage.getByRole('button', { name: 'Unmute Audio' });
    await expect(unmuteButton).toBeVisible();
    await unmuteButton.click();

    await expect(videoLocator).toHaveJSProperty('muted', false);

    await viewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(hostPage);
    await expect.poll(async () => (await request.get('/api/metrics')).json()).toMatchObject({
        rooms: { active: 0 },
    });

    await viewerContext.close();
    await hostContext.close();
});

let loopbackProxySequence = 0;
let loopbackProxyState = null;
// The running test's place in the lock queue, kept from the first line of
// beforeEach. When the test timeout fires inside beforeEach, Playwright stops
// waiting for the hook without throwing into it, so the hook's own catch never
// runs: afterEach then removes the ticket and marks it abandoned, which ends
// the abandoned wait instead of leaving a ticket queued ahead of every later
// test.
let mediaFlowTicket = null;

test.beforeEach(async ({ browser }, testInfo) => {
    const ticket = { abandoned: false, remove: async () => {} };
    mediaFlowTicket = ticket;
    const [fs, http, net, path] = await Promise.all([
        import('node:fs/promises'),
        import('node:http'),
        import('node:net'),
        import('node:path'),
    ]);
    loopbackProxySequence += 1;
    // Under the project's outputDir, which Playwright clears when a run starts,
    // so a ticket left by a killed run does not block the next run.
    const lockDirectory = path.join(testInfo.project.outputDir, '.media-flow-lock');
    const ticketName = `${[
        String(Date.now()).padStart(13, '0'),
        String(testInfo.workerIndex).padStart(4, '0'),
        String(process.pid).padStart(8, '0'),
        String(loopbackProxySequence).padStart(4, '0'),
    ].join('-')}.ticket`;
    const ticketPath = path.join(lockDirectory, ticketName);
    ticket.remove = () => fs.rm(ticketPath, { force: true });
    await fs.mkdir(lockDirectory, { recursive: true });
    await fs.writeFile(ticketPath, '', { flag: 'wx' });

    try {
        for (;;) {
            if (ticket.abandoned) throw new Error('beforeEach timed out waiting for the media-flow lock');
            const tickets = (await fs.readdir(lockDirectory))
                .filter((entry) => entry.endsWith('.ticket'))
                .sort();
            if (tickets[0] === ticketName) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        const port = serverPort(testInfo);
        const workerOctet = (testInfo.workerIndex % 250) + 1;
        const testOctet = (loopbackProxySequence % 250) + 2;
        const sourceAddress = `127.0.${workerOctet}.${testOctet}`;
        const sockets = new Set();

        const proxy = http.createServer((_, response) => {
            response.writeHead(405);
            response.end();
        });
        proxy.on('connect', (request, downstream, head) => {
            if (![`localhost:${port}`, `nextra.cloudflare.test:${port}`].includes(request.url)) {
                downstream.end('HTTP/1.1 403 Forbidden\r\n\r\n');
                return;
            }

            const upstream = net.connect({
                host: '127.0.0.1',
                port,
                localAddress: sourceAddress,
            }, () => {
                downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length > 0) upstream.write(head);
                downstream.pipe(upstream).pipe(downstream);
            });
            sockets.add(downstream);
            sockets.add(upstream);

            const forget = (socket) => {
                sockets.delete(socket);
            };
            downstream.once('close', () => forget(downstream));
            upstream.once('close', () => forget(upstream));
            downstream.once('error', () => upstream.destroy());
            upstream.once('error', () => downstream.destroy());
        });

        await new Promise((resolve, reject) => {
            proxy.once('error', reject);
            proxy.listen(0, '127.0.0.1', resolve);
        });
        if (ticket.abandoned) {
            proxy.close();
            throw new Error('beforeEach timed out while starting the loopback proxy');
        }
        const proxyPort = proxy.address().port;

        const originalNewContext = browser.newContext;
        browser.newContext = function newContext(options = {}) {
            return Reflect.apply(originalNewContext, browser, [{
                ...options,
                baseURL: `https://localhost:${port}`,
                proxy: { server: `http://127.0.0.1:${proxyPort}` },
            }]);
        };
        loopbackProxyState = {
            browser,
            originalNewContext,
            proxy,
            sockets,
        };
    } catch (error) {
        await ticket.remove();
        throw error;
    }
});

test.afterEach(async () => {
    const ticket = mediaFlowTicket;
    mediaFlowTicket = null;
    if (ticket) ticket.abandoned = true;

    if (loopbackProxyState) {
        const {
            browser,
            originalNewContext,
            proxy,
            sockets,
        } = loopbackProxyState;
        loopbackProxyState = null;
        browser.newContext = originalNewContext;
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => proxy.close(resolve));
    }
    if (ticket) await ticket.remove();
});
