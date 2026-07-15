'use strict';

const { io } = require('socket.io-client');

function numberArg(name, fallback) {
    const prefix = `--${name}=`;
    const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

const baseUrl = process.argv.find((arg) => arg.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:3000';
const durationMs = numberArg('duration-ms', 60_000);
const sampleIntervalMs = numberArg('sample-ms', 1_000);
const clients = Math.floor(numberArg('clients', 10));
const ackIntervalMs = numberArg('ack-interval-ms', 250);
const requiredRooms = Math.floor(numberArg('require-rooms', 0));
const requiredFallbackPipelines = Math.floor(numberArg('require-fallback-pipelines', 0));
const thresholds = {
    ackP95Ms: numberArg('max-ack-p95-ms', 100),
    eventLoopP95Ms: numberArg('max-event-loop-p95-ms', 50),
    eventLoopMaxMs: numberArg('max-event-loop-max-ms', 200),
    workerCpuPercent: numberArg('max-worker-cpu-percent', 80),
    processCpuPercent: numberArg('max-process-cpu-percent', 100),
    memoryGrowthPercent: numberArg('max-memory-growth-percent', 20),
};
const metricsToken = process.env.METRICS_TOKEN || '';

function percentile(values, percentileValue) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1)];
}

async function fetchMetrics() {
    const headers = metricsToken ? { Authorization: `Bearer ${metricsToken}` } : {};
    const response = await fetch(`${baseUrl}/api/metrics?resetEventLoopDelay=true`, { headers });
    if (!response.ok) throw new Error(`/api/metrics returned ${response.status}`);
    return response.json();
}

function connectClient() {
    return new Promise((resolve, reject) => {
        const socket = io(baseUrl, {
            transports: ['websocket'],
            reconnection: false,
            timeout: 5_000,
        });
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', reject);
    });
}

function measureAck(socket) {
    return new Promise((resolve, reject) => {
        const started = performance.now();
        socket.timeout(5_000).emit('get-rtp-capabilities', {}, (err, response) => {
            if (err) return reject(err);
            if (!response?.success) return reject(new Error(response?.error || 'Signaling acknowledgement failed'));
            resolve(performance.now() - started);
        });
    });
}

function cpuPercent(first, last, elapsedMs, scale) {
    if (!Number.isFinite(first) || !Number.isFinite(last) || elapsedMs <= 0) return null;
    return ((last - first) / scale / elapsedMs) * 100;
}

async function main() {
    const sockets = await Promise.all(Array.from({ length: clients }, () => connectClient()));
    const ackLatencies = [];
    const errors = [];
    const samples = [];
    let running = true;

    // Discard process-startup history so event-loop histogram values represent
    // only the measured steady-state intervals.
    await fetchMetrics();
    await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));

    const ackLoops = sockets.map(async (socket) => {
        while (running) {
            try {
                ackLatencies.push(await measureAck(socket));
            } catch (err) {
                errors.push(err.message);
            }
            await new Promise((resolve) => setTimeout(resolve, ackIntervalMs));
        }
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < durationMs) {
        samples.push({ at: Date.now(), metrics: await fetchMetrics() });
        await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
    }
    running = false;
    await Promise.all(ackLoops);
    sockets.forEach((socket) => socket.close());

    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last) throw new Error('No metric samples collected');
    const elapsedMs = Math.max(1, last.at - first.at);
    const firstWorker = first.metrics.mediaWorker?.resourceUsage;
    const lastWorker = last.metrics.mediaWorker?.resourceUsage;
    const workerCpu = cpuPercent(
        (firstWorker?.ru_utime || 0) + (firstWorker?.ru_stime || 0),
        (lastWorker?.ru_utime || 0) + (lastWorker?.ru_stime || 0),
        elapsedMs,
        1,
    );
    const firstProcess = first.metrics.process?.cpuUsageMicroseconds;
    const lastProcess = last.metrics.process?.cpuUsageMicroseconds;
    const processCpu = cpuPercent(
        (firstProcess?.user || 0) + (firstProcess?.system || 0),
        (lastProcess?.user || 0) + (lastProcess?.system || 0),
        elapsedMs,
        1_000,
    );
    const firstRss = first.metrics.process?.memory?.rss || 0;
    const lastRss = last.metrics.process?.memory?.rss || 0;
    const memoryGrowth = firstRss > 0 ? ((lastRss - firstRss) / firstRss) * 100 : 0;
    const eventLoopP95 = Math.max(...samples.map(({ metrics }) => metrics.process?.eventLoopDelayMs?.p95 || 0));
    const eventLoopMax = Math.max(...samples.map(({ metrics }) => metrics.process?.eventLoopDelayMs?.max || 0));
    const summary = {
        topology: {
            clients,
            rooms: last.metrics.rooms?.active || 0,
            viewers: last.metrics.rooms?.totalViewers || 0,
            relayViewers: last.metrics.rooms?.totalRelayViewers || 0,
            fallbackPipelines: last.metrics.sockets?.counters?.activeFallbackPipelines || 0,
        },
        samples: samples.length,
        acknowledgements: ackLatencies.length,
        errors: errors.length,
        observed: {
            ackP50Ms: percentile(ackLatencies, 50),
            ackP95Ms: percentile(ackLatencies, 95),
            ackMaxMs: Math.max(0, ...ackLatencies),
            eventLoopP95Ms: eventLoopP95,
            eventLoopMaxMs: eventLoopMax,
            workerCpuPercent: workerCpu,
            processCpuPercent: processCpu,
            memoryGrowthPercent: memoryGrowth,
        },
        thresholds,
    };
    const failures = [];
    if (summary.topology.rooms < requiredRooms) failures.push(`required ${requiredRooms} rooms, observed ${summary.topology.rooms}`);
    if (summary.topology.fallbackPipelines < requiredFallbackPipelines) {
        failures.push(`required ${requiredFallbackPipelines} fallback pipelines, observed ${summary.topology.fallbackPipelines}`);
    }
    if (errors.length > 0) failures.push(`${errors.length} signalling acknowledgements failed`);
    if (summary.observed.ackP95Ms > thresholds.ackP95Ms) failures.push('ack p95 exceeded');
    if (eventLoopP95 > thresholds.eventLoopP95Ms) failures.push('event-loop p95 exceeded');
    if (eventLoopMax > thresholds.eventLoopMaxMs) failures.push('event-loop max exceeded');
    if (workerCpu !== null && workerCpu > thresholds.workerCpuPercent) failures.push('media-worker CPU exceeded');
    if (processCpu !== null && processCpu > thresholds.processCpuPercent) failures.push('Node process CPU exceeded');
    if (memoryGrowth > thresholds.memoryGrowthPercent) failures.push('RSS growth exceeded');
    summary.pass = failures.length === 0;
    summary.failures = failures;
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.pass) process.exitCode = 1;
}

main().catch((err) => {
    console.error(`Benchmark failed: ${err.message}`);
    process.exitCode = 1;
});
