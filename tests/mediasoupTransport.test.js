const test = require('node:test');
const assert = require('node:assert/strict');

const { createWebRtcTransport } = require('../lib/mediasoup');

test('viewer and WHEP transports use conservative BWE while hosts keep the high initial estimate', async () => {
    const optionsSeen = [];
    const router = {
        createWebRtcTransport: async (options) => {
            optionsSeen.push(options);
            return {
                id: `transport-${optionsSeen.length}`,
                iceParameters: {},
                iceCandidates: [],
                dtlsParameters: {},
            };
        },
    };

    await createWebRtcTransport(router, { purpose: 'viewer' });
    await createWebRtcTransport(router, { purpose: 'whep' });
    await createWebRtcTransport(router, { purpose: 'host' });

    assert.deepEqual(
        optionsSeen.map(({ initialAvailableOutgoingBitrate }) => initialAvailableOutgoingBitrate),
        [600_000, 600_000, 8_000_000]
    );
});
