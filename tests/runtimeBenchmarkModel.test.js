const test = require('node:test');
const assert = require('node:assert/strict');
const {
    minimumRequirementsForScenario,
    validateBenchmarkDefinition,
    calculateHeadroomPercent,
    buildThresholdHeadroom,
    evaluateTopology,
    finiteOrNull,
    sumCpuComponents,
    cpuPercent,
    growthPercent,
    maxOrNull,
    maxOfFiniteOrNull,
    evaluateResourceThresholds,
    observeChurnResources,
    evaluateChurnThresholds,
} = require('../scripts/runtime-benchmark-model');

test('real-media scenarios require evidence for the selected topology', () => {
    assert.deepEqual(minimumRequirementsForScenario('webrtc'), {
        rooms: 1,
        producers: 1,
        consumers: 1,
        relayViewers: 0,
        fallbackPipelines: 0,
        relayBytesForwarded: 0,
    });
    assert.deepEqual(minimumRequirementsForScenario('relay'), {
        rooms: 1,
        producers: 0,
        consumers: 0,
        relayViewers: 1,
        fallbackPipelines: 1,
        relayBytesForwarded: 1,
    });
    const missingScenario = validateBenchmarkDefinition({ scenario: '', label: '', requirements: {} });
    assert.match(missingScenario.join(' '), /scenario must be one of/);
    const weakenedRelay = validateBenchmarkDefinition({
        scenario: 'relay',
        label: 'h264',
        requirements: {
            rooms: 1,
            producers: 0,
            consumers: 0,
            relayViewers: 0,
            fallbackPipelines: 0,
            relayBytesForwarded: 0,
        },
    });
    assert.match(weakenedRelay.join(' '), /relayViewers must be at least 1/);
    assert.match(weakenedRelay.join(' '), /relayBytesForwarded must be at least 1/);
});

test('topology evaluation rejects signalling-only and idle relay runs', () => {
    const requirements = {
        rooms: 1,
        producers: 1,
        consumers: 5,
        relayViewers: 2,
        fallbackPipelines: 1,
        relayBytesForwarded: 1024,
    };
    const failures = evaluateTopology({
        rooms: 1,
        producers: 1,
        consumers: 0,
        relayViewers: 2,
        fallbackPipelines: 1,
        relayBytesForwarded: 0,
    }, requirements);
    assert.deepEqual(failures, [
        'required 5 mediasoup consumers, observed 0',
        'required 1024 relay bytes forwarded during measurement, observed 0',
    ]);
});

test('threshold headroom is explicit and negative when a limit is breached', () => {
    assert.equal(calculateHeadroomPercent(75, 100), 25);
    assert.equal(calculateHeadroomPercent(120, 100), -20);
    assert.equal(calculateHeadroomPercent(null, 100), null);
    assert.deepEqual(buildThresholdHeadroom({
        ackP95Ms: 75,
        eventLoopP95Ms: 25,
        eventLoopMaxMs: 220,
        workerCpuPercent: null,
        processCpuPercent: 50,
        memoryGrowthPercent: 5,
    }, {
        ackP95Ms: 100,
        eventLoopP95Ms: 50,
        eventLoopMaxMs: 200,
        workerCpuPercent: 80,
        processCpuPercent: 100,
        memoryGrowthPercent: 20,
    }), {
        ackP95: 25,
        eventLoopP95: 50,
        eventLoopMax: -10,
        workerCpu: null,
        processCpu: 50,
        memoryGrowth: 75,
    });
});

test('finiteOrNull keeps finite numbers and turns everything else into null', () => {
    assert.equal(finiteOrNull(0), 0);
    assert.equal(finiteOrNull(-3.5), -3.5);
    for (const missing of [undefined, null, NaN, Infinity, '12', '', true, {}]) {
        assert.equal(finiteOrNull(missing), null, String(missing));
    }
});

test('CPU components sum only when every component is reported', () => {
    const worker = ['ru_utime', 'ru_stime'];
    assert.equal(sumCpuComponents({ ru_utime: 120, ru_stime: 30 }, worker), 150);
    assert.equal(sumCpuComponents({ ru_utime: 0, ru_stime: 0 }, worker), 0);
    assert.equal(sumCpuComponents({ ru_utime: 120 }, worker), null);
    assert.equal(sumCpuComponents({ ru_utime: 120, ru_stime: null }, worker), null);
    assert.equal(sumCpuComponents({ ru_utime: 'x', ru_stime: 3 }, worker), null);
    assert.equal(sumCpuComponents(null, worker), null);
    assert.equal(sumCpuComponents(undefined, worker), null);
    assert.equal(sumCpuComponents({ user: 4_000, system: 1_000 }, ['user', 'system']), 5_000);
});

test('CPU percentage is null whenever either reading is missing', () => {
    const worker = ['ru_utime', 'ru_stime'];
    const first = sumCpuComponents({ ru_utime: 100, ru_stime: 50 }, worker);
    const last = sumCpuComponents({ ru_utime: 400, ru_stime: 150 }, worker);
    assert.equal(cpuPercent(first, last, 2_000, 1), 20);
    // A microsecond counter divided by 1000 gives milliseconds.
    assert.equal(cpuPercent(1_000, 501_000, 1_000, 1_000), 50);
    assert.equal(cpuPercent(null, last, 2_000, 1), null);
    assert.equal(cpuPercent(first, null, 2_000, 1), null);
    assert.equal(cpuPercent(first, last, 0, 1), null);
    // A missing last reading used to become 0 and gave a negative, idle-looking value.
    assert.equal(cpuPercent(first, sumCpuComponents({}, worker), 2_000, 1), null);
});

test('growth percent needs both readings and a positive start', () => {
    assert.equal(growthPercent(100, 110), 10);
    assert.equal(growthPercent(100, 100), 0);
    assert.equal(growthPercent(200, 150), -25);
    assert.equal(growthPercent(undefined, 110), null);
    assert.equal(growthPercent(100, undefined), null);
    assert.equal(growthPercent(null, null), null);
    assert.equal(growthPercent(0, 110), null);
});

test('maxOrNull reports a maximum only when every sample reported a value', () => {
    assert.equal(maxOrNull([1, 7, 3]), 7);
    assert.equal(maxOrNull([0, 0]), 0);
    assert.equal(maxOrNull([4]), 4);
    assert.equal(maxOrNull([1, undefined, 3]), null);
    assert.equal(maxOrNull([1, null, 3]), null);
    assert.equal(maxOrNull([undefined, undefined]), null);
    assert.equal(maxOrNull([]), null);
});

test('maxOfFiniteOrNull ignores missing values and is null when none was reported', () => {
    assert.equal(maxOfFiniteOrNull([1, undefined, 9, null, 3]), 9);
    assert.equal(maxOfFiniteOrNull([0]), 0);
    assert.equal(maxOfFiniteOrNull([undefined, null]), null);
    assert.equal(maxOfFiniteOrNull([]), null);
});

test('resource thresholds report breaches and unavailable metrics as failures', () => {
    const thresholds = {
        eventLoopP95Ms: 50,
        eventLoopMaxMs: 200,
        workerCpuPercent: 80,
        processCpuPercent: 100,
        memoryGrowthPercent: 20,
    };
    const within = {
        eventLoopP95Ms: 10,
        eventLoopMaxMs: 40,
        workerCpuPercent: 35,
        processCpuPercent: 60,
        memoryGrowthPercent: 2,
    };
    assert.deepEqual(evaluateResourceThresholds(within, thresholds), []);
    // Exactly at a limit still passes, as before.
    assert.deepEqual(evaluateResourceThresholds({ ...within, workerCpuPercent: 80 }, thresholds), []);
    assert.deepEqual(evaluateResourceThresholds({
        eventLoopP95Ms: 60,
        eventLoopMaxMs: 250,
        workerCpuPercent: 90,
        processCpuPercent: 120,
        memoryGrowthPercent: 25,
    }, thresholds), [
        'event-loop p95 exceeded',
        'event-loop max exceeded',
        'media-worker CPU exceeded',
        'Node process CPU exceeded',
        'RSS growth exceeded',
    ]);
    // Partial: only the missing metric is reported unavailable.
    assert.deepEqual(evaluateResourceThresholds({ ...within, workerCpuPercent: null }, thresholds), [
        'media-worker CPU unavailable',
    ]);
    assert.deepEqual(evaluateResourceThresholds({ ...within, memoryGrowthPercent: undefined, eventLoopMaxMs: null }, thresholds), [
        'event-loop max unavailable',
        'RSS growth unavailable',
    ]);
    // Missing: nothing observed at all fails every resource check.
    assert.deepEqual(evaluateResourceThresholds({}, thresholds), [
        'event-loop p95 unavailable',
        'event-loop max unavailable',
        'media-worker CPU unavailable',
        'Node process CPU unavailable',
        'RSS growth unavailable',
    ]);
    assert.deepEqual(evaluateResourceThresholds({ ...within, processCpuPercent: NaN }, thresholds), [
        'Node process CPU unavailable',
    ]);
});

test('unavailable observations leave headroom null', () => {
    const headroom = buildThresholdHeadroom({
        ackP95Ms: 75,
        eventLoopP95Ms: null,
        eventLoopMaxMs: null,
        workerCpuPercent: null,
        processCpuPercent: null,
        memoryGrowthPercent: null,
    }, {
        ackP95Ms: 100,
        eventLoopP95Ms: 50,
        eventLoopMaxMs: 200,
        workerCpuPercent: 80,
        processCpuPercent: 100,
        memoryGrowthPercent: 20,
    });
    assert.deepEqual(headroom, {
        ackP95: 25,
        eventLoopP95: null,
        eventLoopMax: null,
        workerCpu: null,
        processCpu: null,
        memoryGrowth: null,
    });
});

function churnMetrics({ heapUsed, resources, rooms, activeSockets, socketsAtTop } = {}) {
    return {
        process: {
            ...(heapUsed === undefined ? {} : { memory: { heapUsed } }),
            ...(resources === undefined ? {} : { resources: { total: resources } }),
        },
        ...(rooms === undefined ? {} : { rooms: { active: rooms } }),
        sockets: {
            ...(activeSockets === undefined ? {} : { counters: { activeSockets } }),
            ...(socketsAtTop === undefined ? {} : { activeSockets: socketsAtTop }),
        },
    };
}

test('churn observation computes growth from complete baseline and settled metrics', () => {
    const result = observeChurnResources(
        churnMetrics({ heapUsed: 100, resources: 20, rooms: 0, activeSockets: 4 }),
        churnMetrics({ heapUsed: 110, resources: 23, rooms: 1, activeSockets: 6 }),
    );
    assert.deepEqual(result, {
        baseline: { heapUsed: 100, resources: 20, socketsActive: 4 },
        settled: { heapUsed: 110, resources: 23, roomsActive: 1, socketsActive: 6 },
        observed: { heapGrowthPercent: 10, resourceGrowth: 3, roomResidual: 1, socketGrowth: 2 },
    });
    // The socket count may sit directly under sockets as well as under sockets.counters.
    assert.equal(observeChurnResources(
        churnMetrics({ socketsAtTop: 3 }),
        churnMetrics({ socketsAtTop: 5 }),
    ).observed.socketGrowth, 2);
    // A zero reading is a reading: no growth, not unavailable.
    assert.deepEqual(observeChurnResources(
        churnMetrics({ resources: 0, activeSockets: 0 }),
        churnMetrics({ resources: 0, rooms: 0, activeSockets: 0 }),
    ).observed, { heapGrowthPercent: null, resourceGrowth: 0, roomResidual: 0, socketGrowth: 0 });
});

test('churn observation leaves a growth null when its baseline or settled field is absent', () => {
    const full = churnMetrics({ heapUsed: 100, resources: 20, rooms: 0, activeSockets: 4 });
    const noHeap = churnMetrics({ resources: 20, rooms: 0, activeSockets: 4 });
    const noResources = churnMetrics({ heapUsed: 100, rooms: 0, activeSockets: 4 });
    const noRooms = churnMetrics({ heapUsed: 100, resources: 20, activeSockets: 4 });
    const noSockets = churnMetrics({ heapUsed: 100, resources: 20, rooms: 0 });

    assert.equal(observeChurnResources(noHeap, full).observed.heapGrowthPercent, null);
    assert.equal(observeChurnResources(full, noHeap).observed.heapGrowthPercent, null);
    assert.equal(observeChurnResources(noResources, full).observed.resourceGrowth, null);
    assert.equal(observeChurnResources(full, noResources).observed.resourceGrowth, null);
    assert.equal(observeChurnResources(full, noRooms).observed.roomResidual, null);
    assert.equal(observeChurnResources(noSockets, full).observed.socketGrowth, null);
    assert.equal(observeChurnResources(full, noSockets).observed.socketGrowth, null);
    // The other values are unaffected by one missing field.
    assert.deepEqual(observeChurnResources(full, noHeap).observed, {
        heapGrowthPercent: null,
        resourceGrowth: 0,
        roomResidual: 0,
        socketGrowth: 0,
    });
    // Nothing reported at all: every value is null, not 0.
    assert.deepEqual(observeChurnResources({}, undefined), {
        baseline: { heapUsed: null, resources: null, socketsActive: null },
        settled: { heapUsed: null, resources: null, roomsActive: null, socketsActive: null },
        observed: { heapGrowthPercent: null, resourceGrowth: null, roomResidual: null, socketGrowth: null },
    });
});

test('churn thresholds report breaches and unavailable growths as failures', () => {
    const thresholds = { heapGrowthPercent: 25, resourceGrowth: 8, roomResidual: 0, socketGrowth: 0 };
    assert.deepEqual(evaluateChurnThresholds(
        { heapGrowthPercent: 5, resourceGrowth: 2, roomResidual: 0, socketGrowth: 0 },
        thresholds,
    ), []);
    assert.deepEqual(evaluateChurnThresholds(
        { heapGrowthPercent: 30.04, resourceGrowth: 9, roomResidual: 2, socketGrowth: 3 },
        thresholds,
    ), [
        'heap grew 30.0% (limit 25%)',
        'active resources grew by 9 (limit 8)',
        '2 rooms still active after settle (limit 0)',
        'active sockets grew by 3 (limit 0)',
    ]);
    assert.deepEqual(evaluateChurnThresholds(
        { heapGrowthPercent: null, resourceGrowth: 2, roomResidual: null, socketGrowth: 0 },
        thresholds,
    ), [
        'heap growth unavailable',
        'rooms active after settle unavailable',
    ]);
    assert.deepEqual(evaluateChurnThresholds(
        { heapGrowthPercent: null, resourceGrowth: null, roomResidual: null, socketGrowth: null },
        thresholds,
    ), [
        'heap growth unavailable',
        'active resource growth unavailable',
        'rooms active after settle unavailable',
        'active socket growth unavailable',
    ]);
});
