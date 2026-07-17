'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('connection quality summarizes WebRTC RTT, jitter, and loss', async () => {
    const { summarizeConnectionQuality } = await import('../src/lib/connectionQuality.mjs');
    const result = summarizeConnectionQuality([
        { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.08 },
        { type: 'inbound-rtp', packetsLost: 2, jitter: 0.01 },
    ]);
    assert.deepEqual(result, { quality: 'excellent', rttMs: 80, packetsLost: 2, jitterMs: 10 });
});

test('connection quality marks high RTT as poor', async () => {
    const { summarizeConnectionQuality } = await import('../src/lib/connectionQuality.mjs');
    assert.equal(summarizeConnectionQuality([
        { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.7 },
    ]).quality, 'poor');
});
