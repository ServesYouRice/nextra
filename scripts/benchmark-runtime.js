'use strict';

const os = require('node:os');
const { io } = require('socket.io-client');
const {
    minimumRequirementsForScenario,
    validateBenchmarkDefinition,
    buildThresholdHeadroom,
    evaluateTopology,
} = require('./runtime-benchmark-model');

function numberArg(name, fallback) {
    const prefix = `--${name}=`;
    const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeIntegerArg(name, fallback) {
    const prefix = `--${name}=`;
    const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function stringArg(name, fallback = '') {
    const prefix = `--${name}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim() || fallback;
}

const baseUrl = process.argv.find((arg) => arg.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:3000';
const allowInsecureTls = process.argv.includes('--allow-insecure-tls');
const scenario = stringArg('scenario');
const label = stringArg('label');
const durationMs = numberArg('duration-ms', 60_000);
const sampleIntervalMs = numberArg('sample-ms', 1_000);
const clients = Math.floor(numberArg('clients', 10));
const ackIntervalMs = numberArg('ack-interval-ms', 250);
const minimumRequirements = minimumRequirementsForScenario(scenario);
const requirements = {
    rooms: nonNegativeIntegerArg('require-rooms', minimumRequirements.rooms),
    producers: nonNegativeIntegerArg('require-producers', minimumRequirements.producers),
    consumers: nonNegativeIntegerArg('require-consumers', minimumRequirements.consumers),
    relayViewers: nonNegativeIntegerArg('require-relay-viewers', minimumRequirements.relayViewers),
    fallbackPipelines: nonNegativeIntegerArg('require-fallback-pipelines', minimumRequirements.fallbackPipelines),
    relayBytesForwarded: nonNegativeIntegerArg('min-relay-bytes', minimumRequirements.relayBytesForwarded),
};
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
            rejectUnauthorized: !allowInsecureTls,
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

function relayBytesForwarded(metrics) {
    return (metrics.sockets?.rooms || []).reduce((sum, room) => sum + (room.relay?.bytesForwarded || 0), 0);
}

async function main() {
    const definitionFailures = validateBenchmarkDefinition({ scenario, label, requirements });
    if (definitionFailures.length > 0) {
        throw new Error(`Invalid benchmark definition: ${definitionFailures.join('; ')}`);
    }
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
    const firstRelayBytes = relayBytesForwarded(first.metrics);
    const lastRelayBytes = relayBytesForwarded(last.metrics);
    const observedTopology = {
        rooms: last.metrics.rooms?.active || 0,
        producers: last.metrics.sockets?.counters?.activeProducers || 0,
        consumers: last.metrics.rooms?.totalMediasoupConsumers || 0,
        viewers: last.metrics.rooms?.totalViewers || 0,
        relayViewers: last.metrics.rooms?.totalRelayViewers || 0,
        fallbackPipelines: last.metrics.sockets?.counters?.activeFallbackPipelines || 0,
        relayBytesForwarded: Math.max(0, lastRelayBytes - firstRelayBytes),
    };
    const observed = {
        ackP50Ms: percentile(ackLatencies, 50),
        ackP95Ms: percentile(ackLatencies, 95),
        ackMaxMs: Math.max(0, ...ackLatencies),
        eventLoopP95Ms: eventLoopP95,
        eventLoopMaxMs: eventLoopMax,
        workerCpuPercent: workerCpu,
        processCpuPercent: processCpu,
        memoryGrowthPercent: memoryGrowth,
    };
    const summary = {
        measurement: {
            label,
            scenario,
            measuredAt: new Date().toISOString(),
            durationMs,
            sampleIntervalMs,
            targetOrigin: new URL(baseUrl).origin,
            tlsVerificationDisabled: allowInsecureTls,
            runtime: {
                node: process.version,
                platform: process.platform,
                arch: process.arch,
                cpuModel: os.cpus()[0]?.model || 'unknown',
                logicalCpuCount: os.cpus().length,
            },
        },
        expectedTopology: requirements,
        topology: { clients, ...observedTopology },
        samples: samples.length,
        acknowledgements: ackLatencies.length,
        errors: errors.length,
        observed,
        thresholds,
        headroomPercent: buildThresholdHeadroom(observed, thresholds),
    };
    const failures = evaluateTopology(observedTopology, requirements);
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
