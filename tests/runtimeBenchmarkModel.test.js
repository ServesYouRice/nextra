const test = require('node:test');
const assert = require('node:assert/strict');
const {
    minimumRequirementsForScenario,
    validateBenchmarkDefinition,
    calculateHeadroomPercent,
    buildThresholdHeadroom,
    evaluateTopology,
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
