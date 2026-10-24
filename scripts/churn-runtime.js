'use strict';

// Long-running churn / leak harness.
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
const {
    maxOfFiniteOrNull,
    observeChurnResources,
    evaluateChurnThresholds,
} = require('./runtime-benchmark-model');
const { closeSockets, settleWithin } = require('./runtime-harness-cleanup');

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

// Every socket is added to `sockets` as soon as it is created, so a run that fails
// part-way can still close the ones that did connect.
function connectClient(sockets) {
    return new Promise((resolve, reject) => {
        const socket = io(baseUrl, { transports: ['websocket'], reconnection: false, timeout: ackTimeoutMs });
        sockets.push(socket);
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
    const allSockets = [];
    const pairs = [];
    const loops = [];
    const counters = { cycles: 0, errors: 0, errorCounts: {} };
    const recordError = (error) => {
        counters.errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        counters.errorCounts[message] = (counters.errorCounts[message] || 0) + 1;
    };
    const samples = [];
    let running = true;
    let baseline;
    let settled;

    // Whatever ends the run, including a refused connect or a failed metrics request,
    // the loops are stopped and every socket that connected is closed, including a
    // host whose viewer never connected; otherwise the open sockets keep the process
    // alive after it has failed.
    try {
        // Build the persistent pool up front so the baseline sample reflects the
        // steady-state socket count the run holds.
        for (let i = 0; i < concurrency; i += 1) {
            const host = await connectClient(allSockets);
            const viewer = await connectClient(allSockets);
            pairs.push({ host, viewer });
        }

        await delay(sampleIntervalMs); // let the pool settle
        baseline = await fetchMetrics();

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
        loops.push(sampler);

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
        loops.push(...workers);

        await sampler;
        running = false;
        await Promise.all(workers);

        // Sample while the pool is still connected and idle, so the settled sample is
        // directly comparable to the pool-connected baseline: rooms should be back to
        // zero and resources/heap back near baseline, while the persistent pool sockets
        // account for the expected socket residual.
        await delay(settleMs);
        try {
            settled = await fetchMetrics();
        } catch (err) {
            console.error(`Could not read settled metrics: ${err.message}`);
            process.exitCode = 1;
            return;
        }
    } finally {
        running = false;
        // A cycle in flight normally ends within an acknowledgement timeout; the bound
        // only keeps a stuck loop from holding up the cleanup.
        await settleWithin(loops, ackTimeoutMs + cycleDelayMs + 1_000);
        closeSockets(allSockets);
    }

    // A field the server did not report is null (unavailable), never 0: zero would
    // read as no growth and pass. The run then fails with an explicit "unavailable".
    const resources = observeChurnResources(baseline, settled);
    const { observed } = resources;

    const heapSamples = samples.map(({ metrics }) => metrics?.process?.memory?.heapUsed);
    const resourceSamples = samples.map(({ metrics }) => metrics?.process?.resources?.total);
    const peakHeap = maxOfFiniteOrNull([resources.settled.heapUsed, ...heapSamples]);
    const peakResources = maxOfFiniteOrNull([resources.settled.resources, ...resourceSamples]);

    const failures = [];
    if (counters.cycles === 0) failures.push('no churn cycles completed');
    if (counters.errors > 0) failures.push(`${counters.errors} churn or metrics operations failed`);
    failures.push(...evaluateChurnThresholds(observed, thresholds));

    const summary = {
        url: baseUrl,
        durationMs,
        concurrency,
        cycleDelayMs,
        cycles: counters.cycles,
        churnErrors: counters.errors,
        churnErrorCounts: counters.errorCounts,
        samples: samples.length,
        baseline: resources.baseline,
        settled: {
            ...resources.settled,
            resourcesByType: settled.process?.resources?.byType || {},
        },
        observed: {
            heapGrowthPercent: observed.heapGrowthPercent === null ? null : Number(observed.heapGrowthPercent.toFixed(2)),
            resourceGrowth: observed.resourceGrowth,
            socketGrowth: observed.socketGrowth,
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
