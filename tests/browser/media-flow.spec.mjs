import { test, expect, devices } from '@playwright/test';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLockSession } from './support/exclusiveFileLock.mjs';

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

// Hands each relay recording slice of the host page to HostView as `parts`
// chunks, as a recorder with a far shorter timeslice would, so a generation
// passes hundreds of chunks in seconds; the bytes and their order are
// unchanged. MP4 is off: a later viewer of a VP8 generation replays all of it.
// __nextraHoldRelayChunks() keeps the chunks back until
// __nextraReleaseRelayChunks() hands them over, in order.
async function splitHostRelayChunks(page, parts) {
    await page.addInitScript((count) => {
        const NativeMediaRecorder = window.MediaRecorder;
        window.__nextraRecorders = [];
        const held = [];
        let holding = false;
        window.__nextraHoldRelayChunks = () => { holding = true; };
        window.__nextraReleaseRelayChunks = () => {
            holding = false;
            for (const handOver of held.splice(0)) handOver();
        };
        window.MediaRecorder = class SplittingMediaRecorder extends NativeMediaRecorder {
            static isTypeSupported(type) {
                if (String(type).startsWith('video/mp4')) return false;
                return NativeMediaRecorder.isTypeSupported(type);
            }

            constructor(...args) {
                super(...args);
                this.chunksMade = 0;
                window.__nextraRecorders.push(this);
            }

            get ondataavailable() {
                return super.ondataavailable;
            }

            set ondataavailable(handler) {
                super.ondataavailable = typeof handler === 'function'
                    ? (event) => {
                        const blob = event.data;
                        const size = Math.max(1, Math.ceil(blob.size / count));
                        for (let offset = 0; offset < blob.size; offset += size) {
                            this.chunksMade += 1;
                            const data = blob.slice(offset, offset + size);
                            if (holding) held.push(() => handler.call(this, { data }));
                            else handler.call(this, { data });
                        }
                    }
                    : handler;
            }
        };
    }, parts);
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

// Stands in for SourceBuffer failures on a viewer. The next append can reach
// the SourceBuffer as bytes it cannot parse (a real append error: 'error' on
// the SourceBuffer, then the MediaSource ends), or throw a DOMException of a
// given name before it starts; appends can also be made never to finish. It
// records the SourceBuffer removals and counts an append of a chunk that was
// refused before.
async function installRelayAppendFaults(page) {
    await page.addInitScript(() => {
        const faults = {
            corruptNext: false,
            corrupted: 0,
            throwNext: '',
            thrown: 0,
            swallow: false,
            swallowed: 0,
            retried: 0,
            removes: [],
        };
        let refused = null;
        window.__nextraAppendFaults = faults;
        const nativeAppend = SourceBuffer.prototype.appendBuffer;
        const nativeRemove = SourceBuffer.prototype.remove;
        SourceBuffer.prototype.appendBuffer = function appendBuffer(data) {
            if (faults.throwNext) {
                const name = faults.throwNext;
                faults.throwNext = '';
                faults.thrown += 1;
                refused = data;
                throw new DOMException(`Injected ${name}`, name);
            }
            if (faults.swallow) {
                faults.swallowed += 1;
                return undefined;
            }
            if (refused && data === refused) {
                faults.retried += 1;
                refused = null;
            }
            if (faults.corruptNext) {
                faults.corruptNext = false;
                faults.corrupted += 1;
                return nativeAppend.call(this, new Uint8Array(data.byteLength));
            }
            return nativeAppend.call(this, data);
        };
        SourceBuffer.prototype.remove = function remove(start, end) {
            faults.removes.push([start, end]);
            return nativeRemove.call(this, start, end);
        };
    });
}

// Delivers every relay media chunk the viewer receives `copies` times, so its
// queue fills many times faster than the recorder produces. A Socket.IO binary
// event is a text frame (451-["media-chunk",{...placeholder}]) followed by its
// binary attachment; the pair is handed to Socket.IO again.
async function installMediaChunkFlood(page) {
    await page.addInitScript(() => {
        const NativeWebSocket = window.WebSocket;
        const flood = { copies: 1, flooded: 0 };
        window.__nextraChunkFlood = flood;
        window.WebSocket = class FloodedWebSocket extends NativeWebSocket {
            get onmessage() {
                return super.onmessage;
            }

            set onmessage(handler) {
                let chunkHeader = null;
                super.onmessage = typeof handler === 'function'
                    ? (event) => {
                        if (typeof event.data === 'string') {
                            chunkHeader = event.data.startsWith('451-["media-chunk"') ? event : null;
                            handler.call(this, event);
                            return;
                        }
                        handler.call(this, event);
                        if (chunkHeader && flood.copies > 1) {
                            for (let copy = 1; copy < flood.copies; copy += 1) {
                                handler.call(this, chunkHeader);
                                handler.call(this, event);
                            }
                            flood.flooded += 1;
                        }
                        chunkHeader = null;
                    }
                    : handler;
            }
        };
    });
}

// A relay viewer whose playback failed: the reason is shown, nothing reports
// relay mode, Watch Stream is offered again, the MediaSource is gone from the
// video element, and the server no longer sends the viewer relay media.
async function expectRelayStoppedVisibly(viewerPage, request, code, reason) {
    await expect(viewerPage.getByRole('alert')).toContainText(reason, { timeout: 10_000 });
    await expect(viewerPage.getByText(/relay mode active/i)).toHaveCount(0);
    await expect(viewerPage.getByRole('button', { name: 'Watch Stream' })).toBeEnabled();
    expect(await viewerPage.locator('video').evaluate((video) => ({
        src: video.getAttribute('src') || '',
        hasStream: Boolean(video.srcObject),
    }))).toEqual({ src: '', hasStream: false });
    await expect.poll(async () => (await getRoomByCode(request, code))?.relayViewerCount).toBe(0);
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

// A later relay viewer of a VP8 generation starts from the server's bootstrap,
// every chunk since the generation began. The bootstrap arrives as one buffer,
// so the browser's relay queue (240 chunks, 72 s of 300 ms slices) takes it
// however many chunks the generation has passed. The host holds its chunks
// while the late viewer starts and hands them over once it plays, so what
// reaches the viewer during its start is the bootstrap alone.
test('a relay viewer who joins after the generation passed 240 recorder chunks plays from its bootstrap', async ({ browser, request }, testInfo) => {
    const hostContext = await browser.newContext();
    const firstViewerContext = await browser.newContext();
    const lateViewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const firstViewerPage = await firstViewerContext.newPage();
    const lateViewerPage = await lateViewerContext.newPage();
    await splitHostRelayChunks(hostPage, 25);

    const code = await startHost(hostPage);
    await joinAndWatchRelay(firstViewerPage, code, testInfo);
    const generation = (await getRoomByCode(request, code)).mediaGeneration;
    expect(await hostPage.evaluate(() => window.__nextraRecorders.at(-1).mimeType)).toMatch(/^video\/webm/);
    await expect.poll(() => hostPage.evaluate(() => window.__nextraRecorders.at(-1).chunksMade), {
        timeout: 30_000,
    }).toBeGreaterThan(300);

    await hostPage.evaluate(() => window.__nextraHoldRelayChunks());
    await joinAndWatchRelay(lateViewerPage, code, testInfo);
    await hostPage.evaluate(() => window.__nextraReleaseRelayChunks());
    // It joined the running generation from its bootstrap; nothing restarted for it.
    expect((await getRoomByCode(request, code)).mediaGeneration).toBe(generation);
    const startedAt = await videoTime(lateViewerPage);
    await expect.poll(() => videoTime(lateViewerPage)).toBeGreaterThan(startedAt + 2);
    expect(await lateViewerPage.locator('video').evaluate((video) => video.error?.code ?? null)).toBeNull();
    await expect(lateViewerPage.getByText(/relay mode active/i)).toBeVisible();
    await expect(lateViewerPage.getByRole('alert')).toHaveCount(0);

    await lateViewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await firstViewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(hostPage);
    await expect.poll(async () => getRoomByCode(request, code)).toBeNull();
    await lateViewerContext.close();
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

// A relay recorder that errors, or stops by itself, while the host already
// records VP8 changes no state the host view depends on, so it used to stay
// down with its safety-flush interval and silent-audio context still running.
// The host restarts the current recorder, at most three times a minute, and
// ignores events from recorders it has already replaced.
test('the host restarts a VP8 relay recorder that errors or stops on its own, within a budget', async ({ browser, request }, testInfo) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();
    await trackHostRecorders(hostPage, { recordMp4: false });
    await hostPage.addInitScript(() => {
        const NativeAudioContext = window.AudioContext;
        window.__nextraAudioContexts = [];
        window.AudioContext = class TrackedAudioContext extends NativeAudioContext {
            constructor(...args) {
                super(...args);
                window.__nextraAudioContexts.push(this);
            }
        };
    });
    const budgetWarnings = [];
    hostPage.on('console', (message) => {
        if (/restart budget/i.test(message.text())) budgetWarnings.push(message.text());
    });

    const code = await startHost(hostPage);
    await joinAndWatchRelay(viewerPage, code, testInfo);
    expect(await hostPage.evaluate(() => window.__nextraRecorders.at(-1)?.mimeType || '')).toMatch(/^video\/webm/);
    await expect.poll(async () => videoTime(viewerPage)).toBeGreaterThan(1);

    const recorderCount = () => hostPage.evaluate(() => window.__nextraRecorders.length);
    const openAudioContexts = () => hostPage.evaluate(() => (
        window.__nextraAudioContexts.filter((context) => context.state !== 'closed').length
    ));
    const failCurrentRecorder = (how) => hostPage.evaluate((kind) => {
        const recorder = window.__nextraRecorders.at(-1);
        if (kind === 'error') recorder.dispatchEvent(new Event('error'));
        else recorder.stop();
    }, how);
    const started = await recorderCount();
    expect(await openAudioContexts()).toBe(1);

    // A recorder error that no state change follows: restarted, one recorder
    // and one silent-audio context left, and the viewer keeps playing.
    const generationBefore = (await getRoomByCode(request, code)).mediaGeneration;
    await failCurrentRecorder('error');
    await expect.poll(recorderCount).toBe(started + 1);
    await expect.poll(async () => (await getRoomByCode(request, code))?.mediaGeneration || 0).toBeGreaterThan(generationBefore);
    await expect.poll(openAudioContexts).toBe(1);
    expect(await hostPage.evaluate(() => window.__nextraRecorders.at(-1).state)).toBe('recording');
    const atRestart = await videoTime(viewerPage);
    await expect.poll(async () => videoTime(viewerPage)).toBeGreaterThan(atRestart + 2);

    // The recorder stopping without the host asking for it.
    await failCurrentRecorder('stop');
    await expect.poll(recorderCount).toBe(started + 2);
    await expect.poll(openAudioContexts).toBe(1);

    // An error event from a recorder the host replaced long ago is ignored.
    await hostPage.evaluate(() => window.__nextraRecorders[0].dispatchEvent(new Event('error')));
    await hostPage.waitForTimeout(1_000);
    expect(await recorderCount()).toBe(started + 2);

    // The third restart of the minute is still allowed; the fourth is not, and
    // the host says so once.
    await failCurrentRecorder('error');
    await expect.poll(recorderCount).toBe(started + 3);
    await failCurrentRecorder('error');
    await expect.poll(() => budgetWarnings.length).toBe(1);
    await hostPage.waitForTimeout(1_000);
    expect(await recorderCount()).toBe(started + 3);
    expect(await openAudioContexts()).toBe(0);
    expect(budgetWarnings).toHaveLength(1);

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

// Bytes the SourceBuffer cannot parse fire 'error' on it and end the
// MediaSource. The player used to clear its append lock and nothing else, so
// the picture froze under "relay mode active" until 240 chunks had piled up.
test('a relay viewer whose stream turns unreadable is told why, gets Watch Stream back and can watch again', async ({ browser, request }, testInfo) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();
    await installRelayAppendFaults(viewerPage);

    const code = await startHost(hostPage);
    await joinAndWatchRelay(viewerPage, code, testInfo);
    await expect.poll(async () => videoTime(viewerPage)).toBeGreaterThan(1);

    await viewerPage.evaluate(() => { window.__nextraAppendFaults.corruptNext = true; });
    await expect.poll(() => viewerPage.evaluate(() => window.__nextraAppendFaults.corrupted)).toBe(1);
    await expectRelayStoppedVisibly(viewerPage, request, code, 'The browser could not read the relay stream');

    // Watch Stream starts the relay again.
    await viewerPage.getByRole('button', { name: 'Watch Stream' }).click();
    await expect(viewerPage.getByText(/relay mode active/i)).toBeVisible();
    await expect.poll(async () => videoTime(viewerPage)).toBeGreaterThan(1);
    await expect(viewerPage.getByRole('alert')).toHaveCount(0);
    await expect.poll(async () => (await getRoomByCode(request, code))?.relayViewerCount).toBe(1);

    // The MediaSource closing under the player, which nothing in Nextra asked
    // for, ends playback the same way.
    await viewerPage.locator('video').evaluate((video) => {
        video.removeAttribute('src');
        video.load();
    });
    await expectRelayStoppedVisibly(viewerPage, request, code, 'The browser closed the relay stream');

    await viewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(hostPage);
    await expect.poll(async () => getRoomByCode(request, code)).toBeNull();
    await viewerContext.close();
    await hostContext.close();
});

// The player used to take a chunk off its queue before appendBuffer() and only
// log a synchronous failure, so the chunk was lost and playback went on
// without it, whatever the error.
test('a relay viewer whose SourceBuffer is full evicts and appends the same chunk again; any other refused append ends playback visibly', async ({ browser, request }, testInfo) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();
    await installRelayAppendFaults(viewerPage);

    const code = await startHost(hostPage);
    await joinAndWatchRelay(viewerPage, code, testInfo);
    // An eviction keeps the 10 s before the playhead, so there must be more than that.
    await expect.poll(async () => videoTime(viewerPage), { timeout: 25_000 }).toBeGreaterThan(11);

    await viewerPage.evaluate(() => { window.__nextraAppendFaults.throwNext = 'QuotaExceededError'; });
    await expect.poll(() => viewerPage.evaluate(() => window.__nextraAppendFaults.thrown)).toBe(1);
    await expect.poll(() => viewerPage.evaluate(() => window.__nextraAppendFaults.retried),
        'the refused chunk is appended again').toBe(1);
    const { removes, currentTime } = await viewerPage.evaluate(() => ({
        removes: window.__nextraAppendFaults.removes,
        currentTime: document.querySelector('video').currentTime,
    }));
    expect(removes).toHaveLength(1);
    expect(removes[0][0]).toBe(0);
    expect(removes[0][1]).toBeGreaterThan(0);
    expect(removes[0][1]).toBeLessThanOrEqual(currentTime - 10);
    const atRetry = await videoTime(viewerPage);
    await expect.poll(async () => videoTime(viewerPage)).toBeGreaterThan(atRetry + 2);
    await expect(viewerPage.getByRole('alert')).toHaveCount(0);
    await expect(viewerPage.getByText(/relay mode active/i)).toBeVisible();

    await viewerPage.evaluate(() => { window.__nextraAppendFaults.throwNext = 'InvalidStateError'; });
    await expectRelayStoppedVisibly(viewerPage, request, code, 'The browser refused relay media (InvalidStateError)');

    await viewerPage.getByRole('button', { name: 'Leave Room' }).click();
    await hostPage.getByRole('button', { name: 'Stop Sharing' }).click();
    await confirmStopIfPrompted(hostPage);
    await expect.poll(async () => getRoomByCode(request, code)).toBeNull();
    await viewerContext.close();
    await hostContext.close();
});

// A direct viewer whose WebRTC cannot connect falls back to the relay; that
// relay start overflows its queue before anything buffers (appends never
// finish, and every chunk arrives 30 times). The overflow used to be reported
// as "cleaned up before media buffered": the attempt's cleanup settled the
// start with its own generic error before the overflow could.
test('a relay start that falls behind before it plays reports that, not a generic cleanup error', async ({ browser, request }) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();
    await installWebRtcStall(viewerPage);
    await installRelayAppendFaults(viewerPage);
    await installMediaChunkFlood(viewerPage);

    const code = await startHost(hostPage);
    await viewerPage.goto(`/#watch/${code}`);
    await viewerPage.getByRole('button', { name: 'Join Room' }).click();
    const watchButton = viewerPage.getByRole('button', { name: 'Watch Stream' });
    await expect(watchButton).toBeEnabled();
    await viewerPage.evaluate(() => {
        window.__nextraStall.blockIce = true;
        window.__nextraAppendFaults.swallow = true;
        window.__nextraChunkFlood.copies = 30;
    });

    await watchButton.click();
    await expect(viewerPage.getByRole('alert'))
        .toContainText('Relay playback fell behind and must be restarted.', { timeout: 30_000 });
    expect(await viewerPage.evaluate(() => window.__nextraChunkFlood.flooded)).toBeGreaterThan(0);
    await expect(viewerPage.getByText(/relay mode active|WebRTC mode active/i)).toHaveCount(0);
    await expect(watchButton).toBeEnabled();
    await expect.poll(async () => getRoomByCode(request, code)).toMatchObject({
        relayViewerCount: 0,
        mediasoupConsumerCount: 0,
    });

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
// The running test's claim on the lock, kept from the first line of beforeEach.
// When the test timeout fires inside beforeEach, Playwright stops waiting for the
// hook without throwing into it, so the hook's own catch never runs: afterEach
// then cancels a wait that is still going on and gives back a lock that was
// taken, instead of leaving it to block every later test.
let mediaFlowLockSession = null;

test.beforeEach(async ({ browser }, testInfo) => {
    // One media-flow test at a time may use the shared server and room, across
    // workers (see support/exclusiveFileLock.mjs). The folder is under the project's
    // outputDir, which Playwright clears when a run starts, so a lock left by a
    // killed run does not block the next run.
    const lockSession = createLockSession({
        directory: path.join(testInfo.project.outputDir, '.media-flow-lock'),
        workerIndex: testInfo.workerIndex,
    });
    mediaFlowLockSession = lockSession;
    const [http, net] = await Promise.all([
        import('node:http'),
        import('node:net'),
    ]);
    loopbackProxySequence += 1;
    await lockSession.acquire();

    try {
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
        if (lockSession.cancelled) {
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
        // afterEach releases it again and reports a failure to do so.
        await lockSession.release().catch(() => {});
        throw error;
    }
});

test.afterEach(async () => {
    const lockSession = mediaFlowLockSession;
    mediaFlowLockSession = null;
    // First, so an abandoned beforeEach cannot take the lock while this hook runs.
    lockSession?.cancel();

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
    // After the proxy is closed, so the next test starts on a quiet server. A lock that
    // someone else took meanwhile fails this test here.
    await lockSession?.release();
});
