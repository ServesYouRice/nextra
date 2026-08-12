'use strict';

// Long-running churn / leak harness (implementation/KANBAN.md, T10).
//
// Holds a small pool of persistent host+viewer socket pairs and, on each pair,
// repeatedly creates and tears down a room, a host send transport, a viewer join,
// and a viewer recv transport. It samples /api/metrics throughout and fails if
// resource usage does not return to a stable baseline after the churn settles. A
// monotonic climb in active rooms, active sockets, active libuv resources, or heap
// across cycles indicates a leaked resource on the destroy path.
//
// A persistent pool (rather than reconnecting every cycle) keeps the harness off
// the per-IP socket connection limiter and focuses the test on room/transport
// lifecycle cleanup. Socket-connect churn and media-driven churn (OBS reconnect,
// fallback pipeline start/stop, playback-generation replacement under live media)
// need a real media runtime and remain target-host gated; run them against a live
// topology alongside this suite when certifying a host.
//
// Usage:
//   node scripts/churn-runtime.js --url=http://127.0.0.1:3000 --duration-ms=1800000
// Optional gates:
//   --concurrency=4               room pairs churned in parallel
//   --cycle-delay-ms=25           pause between cycles on each pair
//   --settle-ms=5000              idle wait before the final baseline sample
//   --max-heap-growth-percent=25  heapUsed growth from baseline to settled
//   --max-resource-growth=8       active libuv resource count growth allowed
//   --max-room-residual=0         rooms still active after settle
//   --max-socket-growth=0         Socket.IO connections above the connected baseline

const { io } = require('socket.io-client');

function numberArg(name, fallback) {
    const prefix = `--${name}=`;
    const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

const baseUrl = process.argv.find((arg) => arg.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:3000';
const durationMs = numberArg('duration-ms', 30 * 60_000);
const sampleIntervalMs = numberArg('sample-ms', 2_000);
const concurrency = Math.max(1, Math.floor(numberArg('concurrency', 4)));
const cycleDelayMs = Math.max(0, numberArg('cycle-delay-ms', 25));
const settleMs = numberArg('settle-ms', 5_000);
const ackTimeoutMs = numberArg('ack-timeout-ms', 5_000);
const thresholds = {
    heapGrowthPercent: numberArg('max-heap-growth-percent', 25),
    resourceGrowth: numberArg('max-resource-growth', 8),
    roomResidual: numberArg('max-room-residual', 0),
    socketGrowth: numberArg('max-socket-growth', 0),
};
const metricsToken = process.env.METRICS_TOKEN || '';

async function fetchMetrics() {
    const headers = metricsToken ? { Authorization: `Bearer ${metricsToken}` } : {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ackTimeoutMs);
    try {
        const response = await fetch(`${baseUrl}/api/metrics`, { headers, signal: controller.signal });
        if (!response.ok) throw new Error(`/api/metrics returned ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

function connectClient() {
    return new Promise((resolve, reject) => {
        const socket = io(baseUrl, { transports: ['websocket'], reconnection: false, timeout: ackTimeoutMs });
        // Guard against a handshake that neither connects nor emits an error
        // (e.g. a transport closed by the server's connection limiter).
        const guard = setTimeout(() => {
            socket.close();
            reject(new Error('socket connect timed out'));
        }, ackTimeoutMs + 1_000);
        socket.once('connect', () => { clearTimeout(guard); resolve(socket); });
        socket.once('connect_error', (err) => { clearTimeout(guard); socket.close(); reject(err); });
    });
}

function request(socket, event, payload = {}) {
    return new Promise((resolve, reject) => {
        socket.timeout(ackTimeoutMs).emit(event, payload, (err, response) => {
            if (err) return reject(err);
            if (response && response.success === false) {
                return reject(new Error(response.error || `${event} failed`));
            }
            resolve(response);
        });
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// One create/join/teardown cycle on a persistent host+viewer pair. Exercises room
// creation, a host send transport, a viewer join + recv transport, then a full
// reverse-order teardown (leave-room for both peers) so the next cycle starts clean.
async function churnCycle({ host, viewer }) {
    try {
        const created = await request(host, 'create-room', { ingestMode: 'browser' });
        if (!created?.code) throw new Error('create-room returned no code');
        await request(host, 'create-send-transport');

        await request(viewer, 'join-room', { code: created.code });
        await request(viewer, 'create-recv-transport');
    } finally {
        // A failed intermediate operation must not poison the persistent pair or
        // leave a room behind for every later cycle.
        await request(viewer, 'leave-room').catch(() => {});
        await request(host, 'leave-room').catch(() => {});
    }
}

async function main() {
    // Build the persistent pool up front so the baseline sample reflects the
    // steady-state socket count the run holds.
    const pairs = [];
    for (let i = 0; i < concurrency; i += 1) {
        const host = await connectClient();
        const viewer = await connectClient();
        pairs.push({ host, viewer });
    }

    const counters = { cycles: 0, errors: 0, errorCounts: {} };
    const recordError = (error) => {
        counters.errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        counters.errorCounts[message] = (counters.errorCounts[message] || 0) + 1;
    };
    const samples = [];
    let running = true;

    await delay(sampleIntervalMs); // let the pool settle
    const baseline = await fetchMetrics();

    const sampler = (async () => {
        const startedAt = Date.now();
        while (running && Date.now() - startedAt < durationMs) {
            try {
                samples.push({ at: Date.now(), metrics: await fetchMetrics() });
            } catch (err) {
                recordError(err);
                samples.push({ at: Date.now(), error: err.message });
            }
            await delay(sampleIntervalMs);
        }
        running = false;
    })();

    const workers = pairs.map(async (pair) => {
        while (running) {
            try {
                await churnCycle(pair);
                counters.cycles += 1;
            } catch (err) {
                recordError(err);
            }
            if (cycleDelayMs) await delay(cycleDelayMs);
        }
    });

    await sampler;
    running = false;
    await Promise.all(workers);

    // Sample while the pool is still connected and idle, so the settled sample is
    // directly comparable to the pool-connected baseline: rooms should be back to
    // zero and resources/heap back near baseline, while the persistent pool sockets
    // account for the expected socket residual.
    await delay(settleMs);
    let settled;
    try {
        settled = await fetchMetrics();
    } catch (err) {
        console.error(`Could not read settled metrics: ${err.message}`);
        pairs.forEach(({ host, viewer }) => { host.close(); viewer.close(); });
        process.exitCode = 1;
        return;
    }
    pairs.forEach(({ host, viewer }) => { host.close(); viewer.close(); });

    const baseHeap = baseline.process?.memory?.heapUsed || 0;
    const settledHeap = settled.process?.memory?.heapUsed || 0;
    const heapGrowthPercent = baseHeap > 0 ? ((settledHeap - baseHeap) / baseHeap) * 100 : 0;
    const baseResources = baseline.process?.resources?.total || 0;
    const settledResources = settled.process?.resources?.total || 0;
    const resourceGrowth = settledResources - baseResources;
    const roomResidual = settled.rooms?.active || 0;
    const baselineSockets = baseline.sockets?.counters?.activeSockets ?? baseline.sockets?.activeSockets ?? 0;
    const settledSockets = settled.sockets?.counters?.activeSockets ?? settled.sockets?.activeSockets ?? 0;
    const socketGrowth = settledSockets - baselineSockets;

    const heapSamples = samples.map(({ metrics }) => metrics?.process?.memory?.heapUsed || 0);
    const resourceSamples = samples.map(({ metrics }) => metrics?.process?.resources?.total || 0);
    const peakHeap = Math.max(settledHeap, ...heapSamples);
    const peakResources = Math.max(settledResources, ...resourceSamples);

    const failures = [];
    if (counters.cycles === 0) failures.push('no churn cycles completed');
    if (counters.errors > 0) failures.push(`${counters.errors} churn or metrics operations failed`);
    if (heapGrowthPercent > thresholds.heapGrowthPercent) {
        failures.push(`heap grew ${heapGrowthPercent.toFixed(1)}% (limit ${thresholds.heapGrowthPercent}%)`);
    }
    if (resourceGrowth > thresholds.resourceGrowth) {
        failures.push(`active resources grew by ${resourceGrowth} (limit ${thresholds.resourceGrowth})`);
    }
    if (roomResidual > thresholds.roomResidual) {
        failures.push(`${roomResidual} rooms still active after settle (limit ${thresholds.roomResidual})`);
    }
    if (socketGrowth > thresholds.socketGrowth) {
        failures.push(`active sockets grew by ${socketGrowth} (limit ${thresholds.socketGrowth})`);
    }

    const summary = {
        url: baseUrl,
        durationMs,
        concurrency,
        cycleDelayMs,
        cycles: counters.cycles,
        churnErrors: counters.errors,
        churnErrorCounts: counters.errorCounts,
        samples: samples.length,
        baseline: { heapUsed: baseHeap, resources: baseResources, socketsActive: baselineSockets },
        settled: {
            heapUsed: settledHeap,
            resources: settledResources,
            roomsActive: roomResidual,
            socketsActive: settledSockets,
            resourcesByType: settled.process?.resources?.byType || {},
        },
        observed: {
            heapGrowthPercent: Number(heapGrowthPercent.toFixed(2)),
            resourceGrowth,
            socketGrowth,
            peakHeapUsed: peakHeap,
            peakResources,
        },
        thresholds,
        pass: failures.length === 0,
        failures,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.pass) process.exitCode = 1;
}

main().catch((err) => {
    console.error(`Churn suite failed: ${err.message}`);
    process.exitCode = 1;
});
