const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHostRoomMetricsPayload, EMPTY_RELAY_METRICS } = require('../lib/roomMetrics');

const summary = {
    code: 'ABC123',
    viewerCount: 2,
    relayViewerCount: 1,
    mediasoupConsumerCount: 3,
    hasProducer: true,
    hasAudioProducer: false,
};

test('room metrics builder preserves broadcast payload fields', () => {
    const runtime = { activeConsumers: 3 };
    const metrics = buildHostRoomMetricsPayload({
        summary,
        room: { whepViewerCount: 2, fallbackGeneration: 7 },
        eventLoopDelayMs: { p95: 1 },
        includeFallbackGeneration: true,
        runtime,
    });
    assert.equal(metrics.totalViewerCount, 4);
    assert.equal(metrics.fallbackGeneration, 7);
    assert.equal(metrics.fallbackAvailable, undefined);
    assert.equal(metrics.fallbackCodec, undefined);
    assert.equal(metrics.runtime, runtime);
    assert.equal(metrics.relay, EMPTY_RELAY_METRICS);
});

test('room metrics builder preserves request payload defaults', () => {
    const metrics = buildHostRoomMetricsPayload({
        summary,
        room: {},
        eventLoopDelayMs: { p95: 2 },
        normalizeFallback: true,
    });
    assert.equal(metrics.fallbackAvailable, false);
    assert.equal(metrics.fallbackCodec, null);
    assert.equal('fallbackGeneration' in metrics, false);
    assert.equal('runtime' in metrics, false);
    assert.deepEqual(metrics.relay, EMPTY_RELAY_METRICS);
});
