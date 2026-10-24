const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { claimServerPorts } = require('./serverPorts');

const projectRoot = path.resolve(__dirname, '..');

// The destructive POST endpoints server.js offers to the smoke tests. Each is
// refused with 404 unless NEXTRA_SMOKE_TEST=1, even from a loopback caller.
const CONTROL_ENDPOINTS = [
    '/api/test/shutdown',
    '/api/test/unhandled-rejection',
    '/api/test/kill-media-worker',
];

// The handlers act one tick after they answer (setImmediate), so a live endpoint
// shows its effect a moment after the 202. Wait this long before looking.
const SETTLE_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForExit(child, timeoutMs = 10_000) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            child.removeListener('exit', onExit);
            reject(new Error(`server did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
        const onExit = (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal });
        };
        child.once('exit', onExit);
    });
}

async function waitForJson(url, predicate, child, getOutput, timeoutMs = 25_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`server exited before ${url} answered (code ${child.exitCode})\n${getOutput()}`);
        }
        try {
            const response = await fetch(url);
            if (response.ok) {
                const body = await response.json();
                if (predicate(body)) return body;
            }
        } catch {
            // The listener may not exist yet while mediasoup initializes.
        }
        await sleep(100);
    }
    throw new Error(`Timed out waiting for ${url}\n${getOutput()}`);
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

async function waitForProcessGone(pid, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) return true;
        await sleep(100);
    }
    return !isProcessAlive(pid);
}

test('the /api/test control endpoints answer 404 and change nothing when NEXTRA_SMOKE_TEST is unset', {
    concurrency: false,
    timeout: 40_000,
}, async (t) => {
    const { port, rtcPort } = await claimServerPorts();
    const baseUrl = `http://127.0.0.1:${port}`;
    let output = '';
    let workerPid = null;
    const testDistDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nextra-control-dist-'));
    await fs.writeFile(path.join(testDistDir, 'index.html'), '<!doctype html><div id="root"></div>');
    t.after(() => fs.rm(testDistDir, { recursive: true, force: true }));

    // The same values the other real-server tests use, minus the smoke flag. The
    // dist directory is passed as they pass it, but the server ignores it without
    // the flag, so the tests below rely on /healthz and /api/metrics only.
    const env = {
        ...process.env,
        NODE_ENV: 'test',
        APP_ENV: 'test',
        PORT: String(port),
        BIND_HOST: '127.0.0.1',
        LAN_IP: '127.0.0.1',
        RTC_LISTEN_IP: '127.0.0.1',
        RTC_MIN_PORT: String(rtcPort),
        RTC_MAX_PORT: String(rtcPort),
        LOCAL_HTTPS: 'false',
        OPEN_BROWSER: 'false',
        AUTO_DETECT_PUBLIC_IP: 'false',
        AUTO_PUBLIC_TUNNEL: 'false',
        CLOUDFLARED_TUNNEL_TOKEN: '',
        SHARE_BASE_URL: '',
        WHIP_ENABLED: 'false',
        WHEP_ENABLED: 'false',
        NEXTRA_TEST_DIST_DIR: testDistDir,
        WORKER_RECOVERY_MIN_UPTIME_SECONDS: '0',
        LOG_LEVEL: 'warn',
    };
    delete env.NEXTRA_SMOKE_TEST;

    const child = spawn(process.execPath, ['server.js'], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });

    // Never through /api/test/shutdown: stop the server directly, and the worker
    // too if it outlived the server.
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill();
            try {
                await waitForExit(child, 7_000);
            } catch {
                child.kill('SIGKILL');
            }
        }
        if (workerPid !== null && !await waitForProcessGone(workerPid, 3_000)) {
            try { process.kill(workerPid, 'SIGKILL'); } catch {}
        }
    });

    const before = await waitForJson(
        `${baseUrl}/api/metrics`,
        (body) => Number.isInteger(body.mediaWorker?.pid) && Number.isInteger(body.process?.pid),
        child,
        () => output,
    );
    workerPid = before.mediaWorker.pid;
    assert.equal(before.process.pid, child.pid, 'metrics report the spawned server process');

    for (const endpoint of CONTROL_ENDPOINTS) {
        const response = await fetch(`${baseUrl}${endpoint}`, { method: 'POST' });
        assert.equal(response.status, 404, `${endpoint} must be disabled without NEXTRA_SMOKE_TEST\n${output}`);
        await sleep(SETTLE_MS);
        assert.equal(child.exitCode, null, `the server stopped after ${endpoint}\n${output}`);
        assert.equal(child.signalCode, null, `the server was killed after ${endpoint}\n${output}`);
        const health = await fetch(`${baseUrl}/healthz`);
        assert.equal(health.status, 200, `/healthz failed after ${endpoint}\n${output}`);
        assert.ok(isProcessAlive(workerPid), `the media worker died after ${endpoint}\n${output}`);
    }

    // A killed worker is replaced by a new server process and a new worker, so an
    // unchanged pair of pids means nothing was touched.
    const after = await (await fetch(`${baseUrl}/api/metrics`)).json();
    assert.equal(after.process.pid, before.process.pid);
    assert.equal(after.mediaWorker.pid, before.mediaWorker.pid);
    assert.ok(!output.includes('injected unhandled rejection'), output);

    // Teardown: stopping the server process also ends its media worker.
    child.kill();
    await waitForExit(child, 10_000);
    assert.ok(
        await waitForProcessGone(workerPid),
        `the media worker ${workerPid} outlived the server process`,
    );
});
