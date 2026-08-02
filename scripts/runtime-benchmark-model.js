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

function evaluateTopology(topology, requirements) {
    const failures = [];
    const checks = [
        ['rooms', 'rooms'],
        ['producers', 'producers'],
        ['consumers', 'mediasoup consumers'],
        ['relayViewers', 'relay viewers'],
        ['fallbackPipelines', 'fallback pipelines'],
        ['relayBytesForwarded', 'relay bytes forwarded during measurement'],
    ];
    for (const [field, label] of checks) {
        if ((topology[field] || 0) < (requirements[field] || 0)) {
            failures.push(`required ${requirements[field]} ${label}, observed ${topology[field] || 0}`);
        }
    }
    return failures;
}

module.exports = {
    VALID_SCENARIOS,
    minimumRequirementsForScenario,
    validateBenchmarkDefinition,
    calculateHeadroomPercent,
    buildThresholdHeadroom,
    evaluateTopology,
};
