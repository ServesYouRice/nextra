'use strict';

const os = require('node:os');
const { io } = require('socket.io-client');
const { createMetricsFetcher } = require('./runtime-metrics-client');
const {
    minimumRequirementsForScenario,
    validateBenchmarkDefinition,
    buildThresholdHeadroom,
    observeTopology,
    evaluateTopologySamples,
    sumCpuComponents,
    cpuPercent,
    growthPercent,
    maxOrNull,
    evaluateResourceThresholds,
} = require('./runtime-benchmark-model');
const { closeSockets, settleWithin } = require('./runtime-harness-cleanup');

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
const ackTimeoutMs = 5_000;
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
const fetchMetrics = createMetricsFetcher({ baseUrl, allowInsecureTls, token: metricsToken });

function percentile(values, percentileValue) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1)];
}

// Every socket is added to `sockets` as soon as it is created, so a run that fails
// part-way can still close the ones that did connect.
function connectClient(sockets) {
    return new Promise((resolve, reject) => {
        const socket = io(baseUrl, {
            transports: ['websocket'],
            reconnection: false,
            timeout: 5_000,
            rejectUnauthorized: !allowInsecureTls,
        });
        sockets.push(socket);
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', (err) => {
            socket.close();
            reject(err);
        });
    });
}

function measureAck(socket) {
    return new Promise((resolve, reject) => {
        const started = performance.now();
        socket.timeout(ackTimeoutMs).emit('get-rtp-capabilities', {}, (err, response) => {
            if (err) return reject(err);
            if (!response?.success) return reject(new Error(response?.error || 'Signaling acknowledgement failed'));
            resolve(performance.now() - started);
        });
    });
}

function relayBytesForwarded(metrics) {
    return (metrics.sockets?.rooms || []).reduce((sum, room) => sum + (room.relay?.bytesForwarded || 0), 0);
}

async function main() {
    const definitionFailures = validateBenchmarkDefinition({ scenario, label, requirements });
    if (definitionFailures.length > 0) {
        throw new Error(`Invalid benchmark definition: ${definitionFailures.join('; ')}`);
    }
    const sockets = [];
    const ackLoops = [];
    const ackLatencies = [];
    const errors = [];
    const samples = [];
    let running = true;

    // Whatever ends the measurement, including a failed connect or metrics request,
    // the acknowledgement loops are stopped and every socket is closed; otherwise the
    // open sockets keep the process alive after it has failed.
    try {
        // Wait for every connect attempt to settle before failing, so no socket that
        // connects after the first refusal is left out of `sockets`.
        const connections = await Promise.allSettled(Array.from({ length: clients }, () => connectClient(sockets)));
        const refused = connections.find((connection) => connection.status === 'rejected');
        if (refused) throw refused.reason;

        // Discard process-startup history so event-loop histogram values represent
        // only the measured steady-state intervals.
        await fetchMetrics();
        await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));

        for (const socket of sockets) {
            ackLoops.push((async () => {
                while (running) {
                    try {
                        ackLatencies.push(await measureAck(socket));
                    } catch (err) {
                        errors.push(err.message);
                    }
                    await new Promise((resolve) => setTimeout(resolve, ackIntervalMs));
                }
            })());
        }

        const startedAt = Date.now();
        while (Date.now() - startedAt < durationMs) {
            samples.push({ at: Date.now(), metrics: await fetchMetrics() });
            await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
        }
    } finally {
        running = false;
        // An acknowledgement in flight ends within ackTimeoutMs, and a loop then ends
        // after one more interval; the bound only guards against one that never does.
        await settleWithin(ackLoops, ackTimeoutMs + ackIntervalMs + 1_000);
        closeSockets(sockets);
    }

    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last) throw new Error('No metric samples collected');
    const elapsedMs = Math.max(1, last.at - first.at);
    // A metric the server did not report stays null (unavailable) and fails the
    // run below; it is never counted as 0.
    const workerCpuFields = ['ru_utime', 'ru_stime'];
    const processCpuFields = ['user', 'system'];
    const workerCpu = cpuPercent(
        sumCpuComponents(first.metrics.mediaWorker?.resourceUsage, workerCpuFields),
        sumCpuComponents(last.metrics.mediaWorker?.resourceUsage, workerCpuFields),
        elapsedMs,
        1,
    );
    const processCpu = cpuPercent(
        sumCpuComponents(first.metrics.process?.cpuUsageMicroseconds, processCpuFields),
        sumCpuComponents(last.metrics.process?.cpuUsageMicroseconds, processCpuFields),
        elapsedMs,
        1_000,
    );
    const memoryGrowth = growthPercent(first.metrics.process?.memory?.rss, last.metrics.process?.memory?.rss);
    const eventLoopP95 = maxOrNull(samples.map(({ metrics }) => metrics.process?.eventLoopDelayMs?.p95));
    const eventLoopMax = maxOrNull(samples.map(({ metrics }) => metrics.process?.eventLoopDelayMs?.max));
    const firstRelayBytes = relayBytesForwarded(first.metrics);
    const lastRelayBytes = relayBytesForwarded(last.metrics);
    // `topology` keeps reporting the last sample (and the whole-window relay total); the
    // requirements are checked against every sample, and the lowest value each one
    // reached is reported as `topologyMinimums`.
    const observedTopology = {
        ...observeTopology(last.metrics),
        relayBytesForwarded: Math.max(0, lastRelayBytes - firstRelayBytes),
    };
    const topologyEvaluation = evaluateTopologySamples(
        samples.map(({ at, metrics }) => ({ at, topology: observeTopology(metrics) })),
        requirements,
        { relayBytesForwarded: observedTopology.relayBytesForwarded },
    );
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
        topologyMinimums: topologyEvaluation.minimums,
        samples: samples.length,
        acknowledgements: ackLatencies.length,
        errors: errors.length,
        observed,
        thresholds,
        headroomPercent: buildThresholdHeadroom(observed, thresholds),
    };
    const failures = [...topologyEvaluation.failures];
    if (errors.length > 0) failures.push(`${errors.length} signalling acknowledgements failed`);
    if (summary.observed.ackP95Ms > thresholds.ackP95Ms) failures.push('ack p95 exceeded');
    failures.push(...evaluateResourceThresholds(observed, thresholds));
    summary.pass = failures.length === 0;
    summary.failures = failures;
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.pass) process.exitCode = 1;
}

main().catch((err) => {
    console.error(`Benchmark failed: ${err.message}`);
    process.exitCode = 1;
});
