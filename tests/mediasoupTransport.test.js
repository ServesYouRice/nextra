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

const config = require('../config');

function makeRouterStub() {
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
    return { router, optionsSeen };
}

test('fallback listenIps for loopback media suppresses LAN and public candidates', { concurrency: false }, async () => {
    const prevRtcListenIp = config.RTC_LISTEN_IP;
    const prevLanIp = config.LAN_IP;
    const prevPublicIp = config.PUBLIC_IP;

    try {
        config.RTC_LISTEN_IP = '127.0.0.1';
        config.LAN_IP = '192.168.1.50';
        config.PUBLIC_IP = '203.0.113.1';

        const { router, optionsSeen } = makeRouterStub();
        await createWebRtcTransport(router);

        assert.deepEqual(optionsSeen[0].listenIps, [
            { ip: '127.0.0.1', announcedIp: undefined },
        ]);
    } finally {
        config.RTC_LISTEN_IP = prevRtcListenIp;
        config.LAN_IP = prevLanIp;
        config.PUBLIC_IP = prevPublicIp;
    }
});

test('fallback listenIps for LAN-only media announces LAN_IP', { concurrency: false }, async () => {
    const prevRtcListenIp = config.RTC_LISTEN_IP;
    const prevLanIp = config.LAN_IP;
    const prevPublicIp = config.PUBLIC_IP;

    try {
        config.RTC_LISTEN_IP = '0.0.0.0';
        config.LAN_IP = '192.168.1.50';
        config.PUBLIC_IP = '';

        const { router, optionsSeen } = makeRouterStub();
        await createWebRtcTransport(router);

        assert.deepEqual(optionsSeen[0].listenIps, [
            { ip: '0.0.0.0', announcedIp: '192.168.1.50' },
        ]);
    } finally {
        config.RTC_LISTEN_IP = prevRtcListenIp;
        config.LAN_IP = prevLanIp;
        config.PUBLIC_IP = prevPublicIp;
    }
});

test('fallback listenIps puts distinct PUBLIC_IP first before LAN_IP', { concurrency: false }, async () => {
    const prevRtcListenIp = config.RTC_LISTEN_IP;
    const prevLanIp = config.LAN_IP;
    const prevPublicIp = config.PUBLIC_IP;

    try {
        config.RTC_LISTEN_IP = '0.0.0.0';
        config.LAN_IP = '192.168.1.50';
        config.PUBLIC_IP = '203.0.113.1';

        const { router, optionsSeen } = makeRouterStub();
        await createWebRtcTransport(router);

        assert.deepEqual(optionsSeen[0].listenIps, [
            { ip: '0.0.0.0', announcedIp: '203.0.113.1' },
            { ip: '0.0.0.0', announcedIp: '192.168.1.50' },
        ]);
    } finally {
        config.RTC_LISTEN_IP = prevRtcListenIp;
        config.LAN_IP = prevLanIp;
        config.PUBLIC_IP = prevPublicIp;
    }
});

test('fallback listenIps does not duplicate candidate when PUBLIC_IP equals LAN_IP', { concurrency: false }, async () => {
    const prevRtcListenIp = config.RTC_LISTEN_IP;
    const prevLanIp = config.LAN_IP;
    const prevPublicIp = config.PUBLIC_IP;

    try {
        config.RTC_LISTEN_IP = '0.0.0.0';
        config.LAN_IP = '192.168.1.50';
        config.PUBLIC_IP = '192.168.1.50';

        const { router, optionsSeen } = makeRouterStub();
        await createWebRtcTransport(router);

        assert.deepEqual(optionsSeen[0].listenIps, [
            { ip: '0.0.0.0', announcedIp: '192.168.1.50' },
        ]);
    } finally {
        config.RTC_LISTEN_IP = prevRtcListenIp;
        config.LAN_IP = prevLanIp;
        config.PUBLIC_IP = prevPublicIp;
    }
});

test('createWebRtcTransport defaults to host purpose bitrate of 8_000_000', async () => {
    const { router, optionsSeen } = makeRouterStub();
    await createWebRtcTransport(router);
    assert.equal(optionsSeen[0].initialAvailableOutgoingBitrate, 8_000_000);
});
