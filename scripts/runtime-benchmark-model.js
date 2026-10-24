'use strict';

const VALID_SCENARIOS = new Set(['webrtc', 'relay', 'mixed']);

function minimumRequirementsForScenario(scenario) {
    const includesWebRtc = scenario === 'webrtc' || scenario === 'mixed';
    const includesRelay = scenario === 'relay' || scenario === 'mixed';
    return {
        rooms: 1,
        producers: includesWebRtc ? 1 : 0,
        consumers: includesWebRtc ? 1 : 0,
        relayViewers: includesRelay ? 1 : 0,
        fallbackPipelines: includesRelay ? 1 : 0,
        relayBytesForwarded: includesRelay ? 1 : 0,
    };
}

function validateBenchmarkDefinition({ scenario, label, requirements }) {
    const failures = [];
    if (!VALID_SCENARIOS.has(scenario)) {
        failures.push('scenario must be one of: webrtc, relay, mixed');
        return failures;
    }
    if (typeof label !== 'string' || !label.trim()) {
        failures.push('label is required (for example: --label=1080p60-5-viewers)');
    }
    const minimums = minimumRequirementsForScenario(scenario);
    for (const [name, minimum] of Object.entries(minimums)) {
        const value = requirements?.[name];
        if (!Number.isFinite(value) || value < minimum) {
            failures.push(`${name} must be at least ${minimum} for the ${scenario} scenario`);
        }
    }
    return failures;
}

function calculateHeadroomPercent(observed, limit) {
    if (!Number.isFinite(observed) || !Number.isFinite(limit) || limit <= 0) return null;
    return Number((((limit - observed) / limit) * 100).toFixed(2));
}

function buildThresholdHeadroom(observed, thresholds) {
    return {
        ackP95: calculateHeadroomPercent(observed.ackP95Ms, thresholds.ackP95Ms),
        eventLoopP95: calculateHeadroomPercent(observed.eventLoopP95Ms, thresholds.eventLoopP95Ms),
        eventLoopMax: calculateHeadroomPercent(observed.eventLoopMaxMs, thresholds.eventLoopMaxMs),
        workerCpu: calculateHeadroomPercent(observed.workerCpuPercent, thresholds.workerCpuPercent),
        processCpu: calculateHeadroomPercent(observed.processCpuPercent, thresholds.processCpuPercent),
        memoryGrowth: calculateHeadroomPercent(observed.memoryGrowthPercent, thresholds.memoryGrowthPercent),
    };
}

// Resource metrics that the server did not report must stay "unavailable" (null).
// They are never coerced to 0, because 0 reads as an idle process with full headroom.
function finiteOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Sum of the named fields of a usage object, or null when any of them is missing.
function sumCpuComponents(usage, fields) {
    let total = 0;
    for (const field of fields) {
        const component = finiteOrNull(usage?.[field]);
        if (component === null) return null;
        total += component;
    }
    return total;
}

function cpuPercent(first, last, elapsedMs, scale) {
    if (!Number.isFinite(first) || !Number.isFinite(last) || elapsedMs <= 0) return null;
    return ((last - first) / scale / elapsedMs) * 100;
}

// Growth of a reading from first to last, in percent; null when either reading is
// missing or the first is not a positive number to measure growth against.
function growthPercent(first, last) {
    const start = finiteOrNull(first);
    const end = finiteOrNull(last);
    if (start === null || end === null || start <= 0) return null;
    return ((end - start) / start) * 100;
}

// Largest of the values, or null when there are none or any one is missing: a
// maximum over some samples would hide the samples that reported nothing.
function maxOrNull(values) {
    if (values.length === 0) return null;
    let max = -Infinity;
    for (const value of values) {
        const number = finiteOrNull(value);
        if (number === null) return null;
        if (number > max) max = number;
    }
    return max;
}

// Largest of the values that were reported; null when none was. For peaks that are
// shown for information and not checked against a limit.
function maxOfFiniteOrNull(values) {
    const reported = values.map(finiteOrNull).filter((value) => value !== null);
    return reported.length === 0 ? null : Math.max(...reported);
}

const RESOURCE_CHECKS = [
    ['eventLoopP95Ms', 'eventLoopP95Ms', 'event-loop p95'],
    ['eventLoopMaxMs', 'eventLoopMaxMs', 'event-loop max'],
    ['workerCpuPercent', 'workerCpuPercent', 'media-worker CPU'],
    ['processCpuPercent', 'processCpuPercent', 'Node process CPU'],
    ['memoryGrowthPercent', 'memoryGrowthPercent', 'RSS growth'],
];

// Failures for the benchmark's resource limits. A metric that is null or not a
// finite number fails as "<metric> unavailable" instead of passing unchecked.
function evaluateResourceThresholds(observed, thresholds) {
    const failures = [];
    for (const [observedKey, thresholdKey, label] of RESOURCE_CHECKS) {
        const value = finiteOrNull(observed?.[observedKey]);
        if (value === null) failures.push(`${label} unavailable`);
        else if (value > thresholds[thresholdKey]) failures.push(`${label} exceeded`);
    }
    return failures;
}

// Reads the churn harness's baseline and settled metrics. Every field the growth
// values depend on is null when absent, so a missing field cannot read as no growth.
function observeChurnResources(baselineMetrics, settledMetrics) {
    const socketsActive = (metrics) => finiteOrNull(metrics?.sockets?.counters?.activeSockets)
        ?? finiteOrNull(metrics?.sockets?.activeSockets);
    const baseline = {
        heapUsed: finiteOrNull(baselineMetrics?.process?.memory?.heapUsed),
        resources: finiteOrNull(baselineMetrics?.process?.resources?.total),
        socketsActive: socketsActive(baselineMetrics),
    };
    const settled = {
        heapUsed: finiteOrNull(settledMetrics?.process?.memory?.heapUsed),
        resources: finiteOrNull(settledMetrics?.process?.resources?.total),
        roomsActive: finiteOrNull(settledMetrics?.rooms?.active),
        socketsActive: socketsActive(settledMetrics),
    };
    const difference = (from, to) => (from === null || to === null ? null : to - from);
    return {
        baseline,
        settled,
        observed: {
            heapGrowthPercent: growthPercent(baseline.heapUsed, settled.heapUsed),
            resourceGrowth: difference(baseline.resources, settled.resources),
            roomResidual: settled.roomsActive,
            socketGrowth: difference(baseline.socketsActive, settled.socketsActive),
        },
    };
}

// Failures for the churn harness's limits; a growth that could not be computed
// fails as "<metric> unavailable".
function evaluateChurnThresholds(observed, thresholds) {
    const failures = [];
    const { heapGrowthPercent, resourceGrowth, roomResidual, socketGrowth } = observed;
    if (heapGrowthPercent === null) failures.push('heap growth unavailable');
    else if (heapGrowthPercent > thresholds.heapGrowthPercent) {
        failures.push(`heap grew ${heapGrowthPercent.toFixed(1)}% (limit ${thresholds.heapGrowthPercent}%)`);
    }
    if (resourceGrowth === null) failures.push('active resource growth unavailable');
    else if (resourceGrowth > thresholds.resourceGrowth) {
        failures.push(`active resources grew by ${resourceGrowth} (limit ${thresholds.resourceGrowth})`);
    }
    if (roomResidual === null) failures.push('rooms active after settle unavailable');
    else if (roomResidual > thresholds.roomResidual) {
        failures.push(`${roomResidual} rooms still active after settle (limit ${thresholds.roomResidual})`);
    }
    if (socketGrowth === null) failures.push('active socket growth unavailable');
    else if (socketGrowth > thresholds.socketGrowth) {
        failures.push(`active sockets grew by ${socketGrowth} (limit ${thresholds.socketGrowth})`);
    }
    return failures;
}

// Load the server reports at one moment. Each of these must hold in every sample of
// the measured window.
const PER_SAMPLE_TOPOLOGY_CHECKS = [
    ['rooms', 'rooms'],
    ['producers', 'producers'],
    ['consumers', 'mediasoup consumers'],
    ['relayViewers', 'relay viewers'],
    ['fallbackPipelines', 'fallback pipelines'],
];
// Counted over the whole window (last reading minus first), so one sample cannot hold it.
const WHOLE_WINDOW_TOPOLOGY_CHECKS = [
    ['relayBytesForwarded', 'relay bytes forwarded during measurement'],
];
const TOPOLOGY_CHECKS = [...PER_SAMPLE_TOPOLOGY_CHECKS, ...WHOLE_WINDOW_TOPOLOGY_CHECKS];
// The fields observeTopology reports; viewers has no requirement but is reported.
const OBSERVED_TOPOLOGY_FIELDS = ['rooms', 'producers', 'consumers', 'viewers', 'relayViewers', 'fallbackPipelines'];

function evaluateTopology(topology, requirements) {
    const failures = [];
    for (const [field, label] of TOPOLOGY_CHECKS) {
        if ((topology[field] || 0) < (requirements[field] || 0)) {
            failures.push(`required ${requirements[field]} ${label}, observed ${topology[field] || 0}`);
        }
    }
    return failures;
}

// The load one /api/metrics sample reports. A field the server did not report counts
// as no load, so a requirement for it fails instead of passing unchecked.
function observeTopology(metrics) {
    return {
        rooms: metrics?.rooms?.active || 0,
        producers: metrics?.sockets?.counters?.activeProducers || 0,
        consumers: metrics?.rooms?.totalMediasoupConsumers || 0,
        viewers: metrics?.rooms?.totalViewers || 0,
        relayViewers: metrics?.rooms?.totalRelayViewers || 0,
        fallbackPipelines: metrics?.sockets?.counters?.activeFallbackPipelines || 0,
    };
}

// Checks the required load against every sample of the measured window, not only the
// last one: a topology that was missing for most of the window and recovered just
// before the end must not pass with performance figures taken while it was missing.
//
// samples: [{ at?, topology }] in measurement order, topology as observeTopology
//   returns it. windowTotals: values counted over the whole window, such as
//   { relayBytesForwarded }; these are checked once, with the message evaluateTopology
//   gives. Returns { failures, minimums }: the lowest value of each observed field
//   across the samples (null when there is no sample), and one failure per unmet
//   requirement naming the sample where it was first unmet.
function evaluateTopologySamples(samples, requirements, windowTotals = {}) {
    const minimums = {};
    for (const field of OBSERVED_TOPOLOGY_FIELDS) {
        // A loop, not Math.min(...values): a long window has too many samples to spread.
        let lowest = null;
        for (const { topology } of samples) {
            const value = topology?.[field] || 0;
            if (lowest === null || value < lowest) lowest = value;
        }
        minimums[field] = lowest;
    }
    const failures = [];
    for (const [field, label] of PER_SAMPLE_TOPOLOGY_CHECKS) {
        const required = requirements[field] || 0;
        if (samples.length === 0) {
            if (required > 0) failures.push(`required ${required} ${label} in every sample, no sample observed`);
            continue;
        }
        const firstUnmet = samples.findIndex(({ topology }) => (topology?.[field] || 0) < required);
        if (firstUnmet === -1) continue;
        const { at } = samples[firstUnmet];
        const time = Number.isFinite(at) && Number.isFinite(new Date(at).getTime())
            ? ` (${new Date(at).toISOString()})`
            : '';
        failures.push(
            `required ${required} ${label} in every sample, lowest observed ${minimums[field]}, `
            + `first unmet at sample ${firstUnmet + 1} of ${samples.length}${time}`,
        );
    }
    for (const [field, label] of WHOLE_WINDOW_TOPOLOGY_CHECKS) {
        if ((windowTotals[field] || 0) < (requirements[field] || 0)) {
            failures.push(`required ${requirements[field]} ${label}, observed ${windowTotals[field] || 0}`);
        }
    }
    return { failures, minimums };
}

module.exports = {
    VALID_SCENARIOS,
    minimumRequirementsForScenario,
    validateBenchmarkDefinition,
    calculateHeadroomPercent,
    buildThresholdHeadroom,
    evaluateTopology,
    observeTopology,
    evaluateTopologySamples,
    finiteOrNull,
    sumCpuComponents,
    cpuPercent,
    growthPercent,
    maxOrNull,
    maxOfFiniteOrNull,
    evaluateResourceThresholds,
    observeChurnResources,
    evaluateChurnThresholds,
};
