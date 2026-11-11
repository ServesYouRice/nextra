import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as connectSocket } from 'socket.io-client';
import { clientBuildDir } from './clientBuild.mjs';

const require = createRequire(import.meta.url);
const { claimServerPorts } = require('../serverPorts.js');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RECOVERY_KEY = 'nextra.hostRecovery.v1';

// A page that was reloaded reclaims the room kept in sessionStorage. These
// tests seed that record by hand and decide what the reclaim meets: the real
// server (which rejects a room it never had, with terminal: true), or a
// connection the test drops. The spec starts its own server on ports it claims
// and serves the same build as the shared web server unless
// NEXTRA_TEST_DIST_DIR names another (clientBuildDir refuses a dist older than
// the client source).
let server = null;
let serverOutput = '';

async function startServer() {
    const distDir = clientBuildDir(projectRoot);
    const { port, rtcPort } = await claimServerPorts();
    const child = spawn(process.execPath, ['server.js'], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            NODE_ENV: 'test',
            APP_ENV: 'test',
            PORT: String(port),
            BIND_HOST: '127.0.0.1',
            LAN_IP: '127.0.0.1',
            LOCAL_HTTPS: 'false',
            OPEN_BROWSER: 'false',
            AUTO_DETECT_PUBLIC_IP: 'false',
            AUTO_PUBLIC_TUNNEL: 'false',
            CLOUDFLARED_TUNNEL_TOKEN: '',
            SHARE_BASE_URL: '',
            WHIP_ENABLED: 'false',
            WHEP_ENABLED: 'false',
            RTC_LISTEN_IP: '127.0.0.1',
            RTC_MIN_PORT: String(rtcPort),
            RTC_MAX_PORT: String(rtcPort),
            NEXTRA_SMOKE_TEST: '1',
            NEXTRA_TEST_DIST_DIR: distDir,
            LOG_LEVEL: 'info',
        },
    });
    serverOutput = '';
    child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
    child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})\n${serverOutput}`);
        if (Date.now() > deadline) throw new Error(`server was not ready in time\n${serverOutput}`);
        try {
            if ((await fetch(`${baseUrl}/readyz`)).ok) break;
        } catch { /* not listening yet */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { child, baseUrl };
}

async function stopServer({ child, baseUrl }) {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
        await fetch(`${baseUrl}/api/test/shutdown`, { method: 'POST' });
    } catch {
        child.kill();
    }
    const timer = setTimeout(() => child.kill(), 7_000);
    await exited;
    clearTimeout(timer);
}

test.beforeAll(async () => {
    server = await startServer();
});

test.afterAll(async () => {
    if (server) await stopServer(server);
});

// The record a reloading page leaves behind, put into sessionStorage before
// the page's own scripts run.
async function seedRecoverySession(page, ingestMode) {
    const session = { code: 'ABCDEF', hostToken: 'a'.repeat(32), ingestMode };
    await page.addInitScript(([key, value]) => {
        window.sessionStorage.setItem(key, value);
    }, [RECOVERY_KEY, JSON.stringify(session)]);
    return session;
}

const readRecoveryRecord = (page) => page.evaluate((key) => window.sessionStorage.getItem(key), RECOVERY_KEY);

// Sits between the page's Socket.IO connection and the server. Every
// reclaim-host the page sends is counted, and `decide(n)` says what happens to
// the n-th: 'forward' (the server answers), 'drop' (the connection is cut right
// after the emit, as a timeout or a lost link would) or 'accept' (the test
// answers like a server that still holds the room).
async function routeSocket(page, decide) {
    const reclaims = [];
    await page.routeWebSocket(/\/socket\.io\//, (ws) => {
        const upstream = ws.connectToServer();
        ws.onMessage((raw) => {
            const text = typeof raw === 'string' ? raw : raw.toString();
            const match = /^42(\d*)\["reclaim-host",(.*)\]$/s.exec(text);
            if (!match) {
                upstream.send(raw);
                return;
            }
            const payload = JSON.parse(match[2]);
            reclaims.push(payload);
            const action = decide(reclaims.length);
            if (action === 'forward') {
                upstream.send(raw);
            } else if (action === 'accept') {
                ws.send(`43${match[1]}${JSON.stringify([{
                    success: true,
                    code: 'host-reconnected',
                    reason: 'Host reconnected.',
                    recoverable: true,
                    terminal: false,
                    ingestMode: 'browser',
                    hasRoomTurnServer: false,
                    reloadRecoveryEnabled: true,
                }])}`);
            } else {
                ws.close({ code: 3001, reason: 'test: connection dropped' });
                upstream.close({ code: 1000 });
            }
        });
    });
    return reclaims;
}

// A stand-in for OBS's obs-websocket server on its default port that records
// every request it is sent.
async function installObsStub(page) {
    const obs = { connections: [], requests: [] };
    await page.routeWebSocket(/:4455\/?$/, (ws) => {
        obs.connections.push(ws);
        ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '30.2.0', rpcVersion: 1 } }));
        ws.onMessage((raw) => {
            const message = JSON.parse(String(raw));
            if (message.op === 1) {
                ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
                return;
            }
            if (message.op !== 6) return;
            const { requestType, requestId } = message.d;
            obs.requests.push(requestType);
            ws.send(JSON.stringify({
                op: 7,
                d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData: {} },
            }));
        });
    });
    return obs;
}

test('a reclaim cut off twice by the connection is retried and the stored room is resumed', async ({ page }) => {
    await seedRecoverySession(page, 'browser');
    // The first two attempts lose the connection after the emit. The page's own
    // request retry spends one of them; the third reaches the server.
    const reclaims = await routeSocket(page, (n) => (n <= 2 ? 'drop' : 'accept'));

    await page.goto(`${server.baseUrl}/#host`);

    await expect(page.getByRole('button', { name: 'Resume Sharing' })).toBeVisible({ timeout: 20_000 });
    expect(reclaims.length, 'reclaim-host requests the page sent').toBe(3);
    expect(reclaims.every((payload) => payload.reloadRecovery === true && payload.code === 'ABCDEF')).toBe(true);
    // The record survived the failures: a further reload can still reclaim.
    expect(JSON.parse(await readRecoveryRecord(page))).toMatchObject({ code: 'ABCDEF', ingestMode: 'browser' });
    await expect(page.getByText(/room ended/i)).toHaveCount(0);
});

test('a reclaim the server rejects as terminal ends the session at once and clears the record', async ({ page }) => {
    await seedRecoverySession(page, 'browser');
    const obs = await installObsStub(page);
    const reclaims = await routeSocket(page, () => 'forward');

    await page.goto(`${server.baseUrl}/#host`);

    await expect(page.getByRole('button', { name: 'Create new room' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('alert')).toContainText('Room reclaim was rejected.');
    expect(reclaims.length, 'a terminal rejection is not retried').toBe(1);
    expect(await readRecoveryRecord(page)).toBeNull();
    // A browser-mode room has nothing in OBS to stop.
    await page.waitForTimeout(500);
    expect(obs.connections).toHaveLength(0);
});

test('a stored OBS room that cannot be reclaimed stops OBS even though the page starts in browser mode', async ({ page }) => {
    await seedRecoverySession(page, 'obs');
    const obs = await installObsStub(page);
    await routeSocket(page, () => 'forward');

    await page.goto(`${server.baseUrl}/#host`);

    await expect(page.getByRole('button', { name: 'Create new room' })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => obs.requests, { message: 'requests OBS received', timeout: 10_000 }).toContain('StopStream');
    expect(await readRecoveryRecord(page)).toBeNull();
});

test('leaving the host page during the pause between reclaim attempts sends no further attempt', async ({ page }) => {
    await seedRecoverySession(page, 'browser');
    const reclaims = await routeSocket(page, () => 'drop');

    await page.goto(`${server.baseUrl}/#host`);
    await expect.poll(() => reclaims.length, { message: 'reclaim attempts', timeout: 20_000 }).toBeGreaterThanOrEqual(2);

    await page.evaluate(() => { window.location.hash = '#privacy'; });
    await expect(page.getByRole('heading', { name: /Privacy/i })).toBeVisible();
    // The unmount teardown runs one task after the view is removed.
    await page.waitForTimeout(250);
    const sent = reclaims.length;
    // Longer than the pauses between attempts and a reconnect.
    await page.waitForTimeout(6_000);

    expect(reclaims.length, 'attempts sent after the host view was left').toBe(sent);
});

test('leaving the host page while a reclaim attempt waits for the connection sends nothing once it is back', async ({ page }) => {
    await seedRecoverySession(page, 'browser');
    // The first reclaim-host loses the connection right after the emit, and the
    // reconnection that follows is held: the server's messages reach the page
    // only once the test lets them through, so the page's socket stays
    // disconnected and the next attempt, due 0.5 s after the failure, waits for it.
    const reclaims = [];
    const reconnect = { released: false, held: [], connected: false, release: () => {} };
    let connections = 0;
    await page.routeWebSocket(/\/socket\.io\//, (ws) => {
        connections += 1;
        const upstream = ws.connectToServer();
        if (connections > 1) {
            const deliver = (message) => {
                // Socket.IO's namespace connect: the page's socket is up again.
                if (String(message).startsWith('40')) reconnect.connected = true;
                ws.send(message);
            };
            reconnect.release = () => {
                reconnect.released = true;
                reconnect.held.splice(0).forEach(deliver);
            };
            upstream.onMessage((message) => {
                if (reconnect.released) deliver(message);
                else reconnect.held.push(message);
            });
        }
        ws.onMessage((raw) => {
            const text = typeof raw === 'string' ? raw : raw.toString();
            if (!/^42\d*\["reclaim-host",/.test(text)) {
                upstream.send(raw);
                return;
            }
            reclaims.push(text);
            ws.close({ code: 3001, reason: 'test: connection dropped' });
            upstream.close({ code: 1000 });
        });
    });
    const firstFailed = page.waitForEvent('console', {
        predicate: (message) => message.text().includes('Reclaiming the previous room failed (attempt 1)'),
        timeout: 20_000,
    });

    await page.goto(`${server.baseUrl}/#host`);
    await firstFailed;
    // Past the 0.5 s pause and well inside the attempt's 5 s connect timeout.
    await page.waitForTimeout(1_500);
    expect(connections, 'the reconnection is held').toBe(2);
    expect(reclaims).toHaveLength(1);

    await page.evaluate(() => { window.location.hash = '#privacy'; });
    await expect(page.getByRole('heading', { name: /Privacy/i })).toBeVisible();
    reconnect.release();
    await expect.poll(() => reconnect.connected, { message: 'the page\'s socket connected again' }).toBe(true);
    // An attempt left waiting would have been sent as the socket connected.
    await page.waitForTimeout(1_000);

    expect(reclaims, 'reclaim-host requests sent after the host view was left').toHaveLength(1);
});

// Browser capture the test steers: getDisplayMedia hands out a canvas stream,
// or, while window.__captureMode is 'deny', rejects the way a cancelled or
// dismissed picker does.
async function installSteerableDisplayCapture(page) {
    await page.addInitScript(() => {
        window.__captureMode = 'canvas';
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
                getDisplayMedia: async () => {
                    if (window.__captureMode === 'deny') {
                        throw new DOMException('Permission denied', 'NotAllowedError');
                    }
                    return createCapture();
                },
            },
        });
    });
}

// Sits between the page's Socket.IO connection and the server and records the
// name of every event the page emits. An event named in `fail` is answered by
// the test with a failed acknowledgement instead of reaching the server.
async function watchSocketEvents(page) {
    const watch = { events: [], fail: {} };
    await page.routeWebSocket(/\/socket\.io\//, (ws) => {
        const upstream = ws.connectToServer();
        ws.onMessage((raw) => {
            const match = typeof raw === 'string' ? /^4(?:2|5\d+-)(\d*)\["([^"]+)"/.exec(raw) : null;
            if (match) {
                const [, ackId, event] = match;
                watch.events.push(event);
                if (watch.fail[event] && ackId) {
                    ws.send(`43${ackId}${JSON.stringify([{ success: false, error: watch.fail[event] }])}`);
                    return;
                }
            }
            upstream.send(raw);
        });
    });
    return watch;
}

async function activeRooms() {
    const metrics = await (await fetch(`${server.baseUrl}/api/metrics`)).json();
    return metrics.rooms.active;
}

// The host panel shows share links, not the code itself.
async function readRoomCode(page) {
    const localLink = await page.locator('.copy-field', { hasText: 'Local Link' })
        .locator('.copy-field-value').innerText();
    return localLink.trim().split('#watch/')[1];
}

// Shares with reload recovery on, reloads, and waits until the new page has
// reclaimed the room and offers Resume Sharing. Returns the room code.
async function shareAndReload(page) {
    await page.goto(`${server.baseUrl}/#host`);
    await page.getByLabel('Allow recovery after reload').check();
    await page.getByRole('button', { name: 'Start Sharing' }).click();
    await expect(page.getByText(/Streaming \(/)).toBeVisible();
    const code = await readRoomCode(page);
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    await expect.poll(() => readRecoveryRecord(page)).not.toBeNull();

    await page.reload();
    await expect(page.getByRole('button', { name: 'Resume Sharing' })).toBeVisible({ timeout: 20_000 });
    expect(await readRoomCode(page)).toBe(code);
    return code;
}

test('cancelling the capture picker on Resume Sharing keeps the reclaimed room, and the next Resume Sharing streams in it', async ({ page }) => {
    await installSteerableDisplayCapture(page);
    const socketWatch = await watchSocketEvents(page);
    const code = await shareAndReload(page);
    expect(await activeRooms()).toBe(1);
    socketWatch.events.length = 0;

    await page.evaluate(() => { window.__captureMode = 'deny'; });
    const resume = page.getByRole('button', { name: 'Resume Sharing' });
    await resume.click();
    await expect(page.getByRole('alert')).toContainText('Screen sharing was cancelled.');
    // Long enough for a host-stopped to reach the server and end the room.
    await page.waitForTimeout(1_000);

    expect.soft(socketWatch.events, 'events the page sent after the cancelled picker').not.toContain('host-stopped');
    expect.soft(await activeRooms(), 'rooms the server still holds').toBe(1);
    expect.soft(JSON.parse(await readRecoveryRecord(page) || 'null'), 'the stored recovery record')
        .toMatchObject({ code, ingestMode: 'browser' });
    await expect.soft(page.getByRole('alert')).toContainText('Press Resume Sharing to try again.');
    await expect.soft(resume).toBeEnabled();
    expect.soft(await page.locator('video').evaluate((video) => video.srcObject), 'the preview after the cancel').toBeNull();

    await page.evaluate(() => { window.__captureMode = 'canvas'; });
    await resume.click();
    await expect(page.getByText(/Streaming \(/)).toBeVisible();
    expect(await readRoomCode(page), 'the room the second Resume Sharing streams in').toBe(code);
    expect(socketWatch.events, 'a resumed room is not created again').not.toContain('create-room');
    expect(await activeRooms()).toBe(1);

    await page.getByRole('button', { name: 'Stop Sharing' }).click();
    await expect.poll(activeRooms).toBe(0);
});

test('a resumed room whose media setup fails after the capture is still torn down', async ({ page }) => {
    await installSteerableDisplayCapture(page);
    const socketWatch = await watchSocketEvents(page);
    await shareAndReload(page);
    socketWatch.events.length = 0;
    socketWatch.fail['create-send-transport'] = 'test: no send transport';

    await page.getByRole('button', { name: 'Resume Sharing' }).click();

    await expect(page.getByRole('alert')).toContainText('test: no send transport');
    await expect(page.getByRole('button', { name: 'Start Sharing' })).toBeEnabled();
    await expect.poll(() => socketWatch.events).toContain('host-stopped');
    await expect.poll(activeRooms).toBe(0);
    expect(await readRecoveryRecord(page)).toBeNull();
});

test('while a reclaimed browser room waits for Resume Sharing, its ingest mode cannot be switched to OBS', async ({ page }) => {
    await installSteerableDisplayCapture(page);
    const socketWatch = await watchSocketEvents(page);
    const code = await shareAndReload(page);
    socketWatch.events.length = 0;

    const obsToggle = page.getByLabel('Use OBS (WHIP ingest)');
    await expect.soft(obsToggle, 'the OBS toggle while the room waits').toBeDisabled();
    await expect.soft(page.getByText('keeps the ingest mode it was created with').first()).toBeVisible();
    await expect.soft(page.locator('#obsTryAv1'), 'the AV1 toggle while the room waits').toBeDisabled();

    // Whatever reaches the handler (here a click on the toggle with its
    // disabled attribute taken away) must not change the mode either.
    await obsToggle.evaluate((input) => { input.disabled = false; });
    await obsToggle.click();
    await expect.soft(obsToggle, 'the OBS toggle after a click').not.toBeChecked();

    await page.getByRole('button', { name: 'Resume Sharing' }).click();
    await expect(page.getByText(/Streaming \(/)).toBeVisible();
    // The recovered room is a browser-capture room: it streams the capture
    // instead of following the OBS path in a room the server knows as browser.
    await expect(page.getByText('Streaming via OBS')).toHaveCount(0);
    expect(await page.locator('video').evaluate((video) => (
        video.srcObject?.getVideoTracks().map((track) => track.readyState) ?? []
    )), 'the capture the resumed room streams').toEqual(['live']);
    expect(await readRoomCode(page)).toBe(code);
    expect(socketWatch.events).not.toContain('create-room');

    await page.getByRole('button', { name: 'Stop Sharing' }).click();
    await expect.poll(activeRooms).toBe(0);
});

// Sits between a sharing host's Socket.IO connections and the server and
// records the events the page sends on each. The test cuts the first one. On
// connection `cutReclaimOn` (by default the reconnection) the page's
// reclaim-host (onReconnect's) is cut off right after the emit, as a link that
// drops again would; on connection `holdConnection` (by default the one after
// that) the server's messages are held until release(), so the page's socket
// stays disconnected until then. The host token the server hands out is kept
// for the clean-up.
async function routeHostReconnects(page, { cutReclaimOn = 2, holdConnection = 3 } = {}) {
    const held = [];
    let deliverHeld = () => {};
    const route = {
        connections: [],
        hostToken: null,
        reconnected: false,
        released: false,
        release() {
            route.released = true;
            deliverHeld();
        },
    };
    await page.routeWebSocket(/\/socket\.io\//, (ws) => {
        const upstream = ws.connectToServer();
        const connection = {
            events: [],
            cut() {
                ws.close({ code: 3001, reason: 'test: connection dropped' });
                upstream.close({ code: 1000 });
            },
        };
        route.connections.push(connection);
        const index = route.connections.length;
        const deliver = (message) => {
            const text = String(message);
            const token = /"hostToken":"([^"]+)"/.exec(text);
            if (token) route.hostToken = token[1];
            // Socket.IO's namespace connect: the page's socket is up again.
            if (index === holdConnection && text.startsWith('40')) route.reconnected = true;
            ws.send(message);
        };
        if (index === holdConnection) deliverHeld = () => held.splice(0).forEach(deliver);
        upstream.onMessage((message) => {
            if (index === holdConnection && !route.released) held.push(message);
            else deliver(message);
        });
        ws.onMessage((raw) => {
            const event = typeof raw === 'string' ? /^4(?:2|5\d+-)\d*\["([^"]+)"/.exec(raw)?.[1] : undefined;
            if (event) connection.events.push(event);
            if (index === cutReclaimOn && event === 'reclaim-host') {
                connection.cut();
                return;
            }
            upstream.send(raw);
        });
    });
    return route;
}

// Shares, cuts the connection, and returns once the reclaim-host onReconnect
// sent on the reconnection was cut off and the page has opened the connection
// after it, which the route holds: socketRequest's second attempt of that
// reclaim now waits for the socket. Only the socket's link is cut here, so the
// media path stays up; with reload recovery on, the server keeps the room when
// the stopping page closes its media transport, as it does when that close
// never arrives because the whole link is down.
async function shareAndHoldReconnectReclaim(page) {
    await installSteerableDisplayCapture(page);
    const route = await routeHostReconnects(page);
    await page.goto(`${server.baseUrl}/#host`);
    await page.getByLabel('Allow recovery after reload').check();
    await page.getByRole('button', { name: 'Start Sharing' }).click();
    await expect(page.getByText(/Streaming \(/)).toBeVisible();
    const code = await readRoomCode(page);
    expect(route.hostToken, 'the host token create-room returned').toBeTruthy();

    route.connections[0].cut();
    // Socket.IO reconnects 0.5 to 1.5 s after a drop, twice here.
    await expect.poll(() => route.connections.length, { message: 'connections the page opened', timeout: 10_000 }).toBe(3);
    expect(route.connections[1].events, 'events sent on the first reconnection').toContain('reclaim-host');
    return { route, code };
}

// Lets the held connection through and checks that the page, which has
// stopped sharing, sends only its teardown's host-stopped there: buffered
// while the socket was down, it goes first, from a socket that does not host
// the room, so a reclaim-host after it would take the room over again.
async function expectNoReclaimOnceBack(page, route) {
    route.release();
    await expect.poll(() => route.reconnected, { message: 'the page\'s socket connected again' }).toBe(true);
    const back = route.connections[2];
    await expect.poll(() => back.events, { message: 'events sent once the socket was back' }).toContain('host-stopped');
    // An attempt left waiting would have been sent as the socket connected.
    await page.waitForTimeout(1_000);
    expect(back.events, 'reclaim-host requests sent after the host stopped').not.toContain('reclaim-host');
}

function connectTestSocket() {
    const client = connectSocket(server.baseUrl, {
        path: '/socket.io',
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
    });
    return new Promise((resolve, reject) => {
        client.once('connect', () => resolve(client));
        client.once('connect_error', reject);
    });
}

// Ends the room the way its host would, over a connection of the test's own,
// unless the page's own host-stopped has ended it already, so that it does not
// outlive the test.
async function endRoomIfLeft(code, hostToken) {
    const client = await connectTestSocket();
    try {
        const reply = await client.timeout(5_000).emitWithAck('reclaim-host', { code, hostToken });
        if (reply?.success) client.emit('host-stopped');
        await expect.poll(activeRooms).toBe(0);
    } finally {
        client.close();
    }
}

test('a sharing host who leaves while the reclaim after a reconnect waits for the connection sends no reclaim once it is back', async ({ page }) => {
    const { route, code } = await shareAndHoldReconnectReclaim(page);

    await page.evaluate(() => { window.location.hash = '#privacy'; });
    await page.getByRole('button', { name: 'Leave and Stop' }).click();
    await expect(page.getByRole('heading', { name: /Privacy/i })).toBeVisible();
    // The unmount teardown runs one task after the view is removed.
    await page.waitForTimeout(250);

    await expectNoReclaimOnceBack(page, route);
    await endRoomIfLeft(code, route.hostToken);
});

test('a sharing host who stops sharing while the reclaim after a reconnect waits for the connection sends no reclaim once it is back', async ({ page }) => {
    const { route, code } = await shareAndHoldReconnectReclaim(page);

    await page.getByRole('button', { name: 'Stop Sharing' }).click();
    await expect(page.getByRole('button', { name: 'Start Sharing' })).toBeVisible();

    await expectNoReclaimOnceBack(page, route);
    await endRoomIfLeft(code, route.hostToken);
});

// A viewer of the room over a Socket.IO connection of the test's own. It
// records the room states the server sends it, and when it was told the room
// ended.
async function joinAsViewer(code) {
    const client = await connectTestSocket();
    const viewer = { states: [], ended: null, close: () => client.close() };
    client.on('host-disconnected', (state) => {
        viewer.states.push(state.code);
        if (state.terminal === true && !viewer.ended) viewer.ended = { ...state, at: Date.now() };
    });
    const reply = await client.timeout(5_000).emitWithAck('join-room', { code });
    expect(reply, 'the viewer joined').toMatchObject({ success: true });
    return viewer;
}

// Shares with a viewer in the room, cuts the page's connection, and returns
// once the page has opened its next connection, which the route holds: the
// page's socket stays down, and the server holds the room for its host's
// reconnect window. Reload recovery is on so that the server keeps the room
// when the stopping page closes its media transport: only the socket's link is
// cut here, and in a real outage that close never arrives.
async function shareWithViewerAndCut(page) {
    await installSteerableDisplayCapture(page);
    const route = await routeHostReconnects(page, { cutReclaimOn: null, holdConnection: 2 });
    await page.goto(`${server.baseUrl}/#host`);
    await page.getByLabel('Allow recovery after reload').check();
    await page.getByRole('button', { name: 'Start Sharing' }).click();
    await expect(page.getByText(/Streaming \(/)).toBeVisible();
    const code = await readRoomCode(page);
    expect(route.hostToken, 'the host token create-room returned').toBeTruthy();
    const viewer = await joinAsViewer(code);
    await expect(page.locator('.viewer-count')).toContainText('1 viewer');

    route.connections[0].cut();
    await expect.poll(() => route.connections.length, { message: 'connections the page opened', timeout: 10_000 }).toBe(2);
    await expect.poll(() => viewer.states, { message: 'what the viewer was told' }).toEqual(['host-disconnected']);
    return { route, code, viewer };
}

// Lets the held connection through: the page's host-stopped, buffered while
// its socket was down, goes out first, from a connection that does not host
// the room. The viewer must be told at once that the room ended, not when the
// reconnect window (30 s) runs out.
async function expectRoomEndedOnceBack(route, viewer) {
    const releasedAt = Date.now();
    route.release();
    await expect.poll(() => route.reconnected, { message: 'the page\'s socket connected again' }).toBe(true);
    await expect.poll(() => route.connections[1].events, { message: 'events sent once the socket was back' }).toContain('host-stopped');
    await expect.poll(() => viewer.ended, { message: 'the viewer told the room ended', timeout: 2_000 }).not.toBeNull();
    expect(viewer.ended).toMatchObject({ code: 'host-stopped', terminal: true });
    expect(viewer.ended.at - releasedAt, 'ms from the release to the viewer being told').toBeLessThan(2_000);
    expect(await activeRooms()).toBe(0);
}

test('a host who stops sharing while the connection is down ends the room once it is back, and viewers are told at once', async ({ page }) => {
    const { route, code, viewer } = await shareWithViewerAndCut(page);
    try {
        await page.getByRole('button', { name: 'Stop Sharing' }).click();
        await page.getByRole('dialog', { name: 'Stop sharing?' }).getByRole('button', { name: 'Stop Sharing' }).click();
        await expect(page.getByRole('button', { name: 'Start Sharing' })).toBeVisible();

        await expectRoomEndedOnceBack(route, viewer);
    } finally {
        viewer.close();
        await endRoomIfLeft(code, route.hostToken);
    }
});

test('a host who leaves the host page while the connection is down ends the room once it is back, and viewers are told at once', async ({ page }) => {
    const { route, code, viewer } = await shareWithViewerAndCut(page);
    try {
        await page.evaluate(() => { window.location.hash = '#privacy'; });
        await page.getByRole('button', { name: 'Leave and Stop' }).click();
        await expect(page.getByRole('heading', { name: /Privacy/i })).toBeVisible();
        // The unmount teardown runs one task after the view is removed.
        await page.waitForTimeout(250);

        await expectRoomEndedOnceBack(route, viewer);
    } finally {
        viewer.close();
        await endRoomIfLeft(code, route.hostToken);
    }
});

test('a capture that ends while the connection is down ends the room once it is back, and viewers are told at once', async ({ page }) => {
    const { route, code, viewer } = await shareWithViewerAndCut(page);
    try {
        // What the browser's own "Stop sharing" bar does to the capture.
        await page.locator('video').evaluate((video) => {
            video.srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended'));
        });
        await expect(page.getByRole('button', { name: 'Start Sharing' })).toBeVisible();

        await expectRoomEndedOnceBack(route, viewer);
    } finally {
        viewer.close();
        await endRoomIfLeft(code, route.hostToken);
    }
});
