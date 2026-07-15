'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderOpenMetrics } = require('../lib/openMetrics');

test('OpenMetrics renderer exports bounded aggregate runtime metrics', () => {
    const output = renderOpenMetrics({
        processMetrics: { uptimeSec: 12, memory: { rss: 2048 }, eventLoopDelayMs: { p95: 4 } },
        rooms: {
            active: 1,
            totalViewers: 2,
            totalRelayViewers: 3,
            totalWhepViewers: 4,
            totalMediasoupConsumers: 5,
        },
        sockets: { totalConnections: 6, activeSockets: 2, relayBytesForwarded: 1024 },
    });

    assert.match(output, /nextra_rooms_active 1/);
    assert.match(output, /nextra_event_loop_delay_p95_seconds 0\.004/);
    assert.match(output, /nextra_socket_connections_total 6/);
    assert.match(output, /# EOF\n$/);
    assert.doesNotMatch(output, /roomCode|hostSocketId/);
});
