const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const mediasoup = require('mediasoup');
const config = require('../config');

function setupSharedServerTest() {
    const prevRtcListenIp = config.RTC_LISTEN_IP;
    const prevRtcMinPort = config.RTC_MIN_PORT;
    const prevRtcMaxPort = config.RTC_MAX_PORT;
    const prevLanIp = config.LAN_IP;
    const prevPublicIp = config.PUBLIC_IP;
    const originalCreateWorker = mediasoup.createWorker;

    delete require.cache[require.resolve('../lib/mediasoup')];

    return {
        restore: () => {
            config.RTC_LISTEN_IP = prevRtcListenIp;
            config.RTC_MIN_PORT = prevRtcMinPort;
            config.RTC_MAX_PORT = prevRtcMaxPort;
            config.LAN_IP = prevLanIp;
            config.PUBLIC_IP = prevPublicIp;
            mediasoup.createWorker = originalCreateWorker;
            delete require.cache[require.resolve('../lib/mediasoup')];
        },
    };
}

test('shared WebRtcServer listenInfos for loopback media binds 127.0.0.1 on base port with undefined announcedAddress', { concurrency: false }, async () => {
    const harness = setupSharedServerTest();
    try {
        config.RTC_LISTEN_IP = '127.0.0.1';
        config.RTC_MIN_PORT = 40000;
        config.RTC_MAX_PORT = 40050;
        config.LAN_IP = '192.168.1.50';
        config.PUBLIC_IP = '203.0.113.1';

        let capturedListenInfos = null;
        mediasoup.createWorker = async () => {
            const fakeWorker = new EventEmitter();
            fakeWorker.createRouter = async () => ({ rtpCapabilities: {} });
            fakeWorker.createWebRtcServer = async ({ listenInfos }) => {
                capturedListenInfos = listenInfos;
                return { id: 'fake-webrtc-server' };
            };
            return fakeWorker;
        };

        const { createMediasoupWorker } = require('../lib/mediasoup');
        await createMediasoupWorker();

        assert.deepEqual(capturedListenInfos, [
            { protocol: 'udp', ip: '127.0.0.1', announcedAddress: undefined, port: 40000 },
            { protocol: 'tcp', ip: '127.0.0.1', announcedAddress: undefined, port: 40000 },
        ]);
    } finally {
        harness.restore();
    }
});

test('shared WebRtcServer listenInfos for LAN-only media announces LAN_IP on base port', { concurrency: false }, async () => {
    const harness = setupSharedServerTest();
    try {
        config.RTC_LISTEN_IP = '0.0.0.0';
        config.RTC_MIN_PORT = 40000;
        config.RTC_MAX_PORT = 40050;
        config.LAN_IP = '192.168.1.50';
        config.PUBLIC_IP = '';

        let capturedListenInfos = null;
        mediasoup.createWorker = async () => {
            const fakeWorker = new EventEmitter();
            fakeWorker.createRouter = async () => ({ rtpCapabilities: {} });
            fakeWorker.createWebRtcServer = async ({ listenInfos }) => {
                capturedListenInfos = listenInfos;
                return { id: 'fake-webrtc-server' };
            };
            return fakeWorker;
        };

        const { createMediasoupWorker } = require('../lib/mediasoup');
        await createMediasoupWorker();

        assert.deepEqual(capturedListenInfos, [
            { protocol: 'udp', ip: '0.0.0.0', announcedAddress: '192.168.1.50', port: 40000 },
            { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: '192.168.1.50', port: 40000 },
        ]);
    } finally {
        harness.restore();
    }
});

test('shared WebRtcServer listenInfos for distinct public IP orders public first on basePort + 1 then LAN', { concurrency: false }, async () => {
    const harness = setupSharedServerTest();
    try {
        config.RTC_LISTEN_IP = '0.0.0.0';
        config.RTC_MIN_PORT = 40000;
        config.RTC_MAX_PORT = 40050;
        config.LAN_IP = '192.168.1.50';
        config.PUBLIC_IP = '203.0.113.1';

        let capturedListenInfos = null;
        mediasoup.createWorker = async () => {
            const fakeWorker = new EventEmitter();
            fakeWorker.createRouter = async () => ({ rtpCapabilities: {} });
            fakeWorker.createWebRtcServer = async ({ listenInfos }) => {
                capturedListenInfos = listenInfos;
                return { id: 'fake-webrtc-server' };
            };
            return fakeWorker;
        };

        const { createMediasoupWorker } = require('../lib/mediasoup');
        await createMediasoupWorker();

        assert.deepEqual(capturedListenInfos, [
            { protocol: 'udp', ip: '0.0.0.0', announcedAddress: '203.0.113.1', port: 40001 },
            { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: '203.0.113.1', port: 40001 },
            { protocol: 'udp', ip: '0.0.0.0', announcedAddress: '192.168.1.50', port: 40000 },
            { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: '192.168.1.50', port: 40000 },
        ]);
    } finally {
        harness.restore();
    }
});

test('shared WebRtcServer listenInfos for PUBLIC_IP equal to LAN_IP contains only LAN entries', { concurrency: false }, async () => {
    const harness = setupSharedServerTest();
    try {
        config.RTC_LISTEN_IP = '0.0.0.0';
        config.RTC_MIN_PORT = 40000;
        config.RTC_MAX_PORT = 40050;
        config.LAN_IP = '192.168.1.50';
        config.PUBLIC_IP = '192.168.1.50';

        let capturedListenInfos = null;
        mediasoup.createWorker = async () => {
            const fakeWorker = new EventEmitter();
            fakeWorker.createRouter = async () => ({ rtpCapabilities: {} });
            fakeWorker.createWebRtcServer = async ({ listenInfos }) => {
                capturedListenInfos = listenInfos;
                return { id: 'fake-webrtc-server' };
            };
            return fakeWorker;
        };

        const { createMediasoupWorker } = require('../lib/mediasoup');
        await createMediasoupWorker();

        assert.deepEqual(capturedListenInfos, [
            { protocol: 'udp', ip: '0.0.0.0', announcedAddress: '192.168.1.50', port: 40000 },
            { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: '192.168.1.50', port: 40000 },
        ]);
    } finally {
        harness.restore();
    }
});

test('rejected shared-server creation resolves and transports fall back to per-transport listenIps with no webRtcServer property', { concurrency: false }, async () => {
    const harness = setupSharedServerTest();
    try {
        config.RTC_LISTEN_IP = '0.0.0.0';
        config.RTC_MIN_PORT = 40000;
        config.RTC_MAX_PORT = 40050;
        config.LAN_IP = '192.168.1.50';
        config.PUBLIC_IP = '';

        mediasoup.createWorker = async () => {
            const fakeWorker = new EventEmitter();
            fakeWorker.createRouter = async () => ({ rtpCapabilities: {} });
            fakeWorker.createWebRtcServer = async () => {
                throw new Error('EADDRINUSE: bind failure');
            };
            return fakeWorker;
        };

        const { createMediasoupWorker, createWebRtcTransport } = require('../lib/mediasoup');
        const { worker, router } = await createMediasoupWorker();
        assert.ok(worker);
        assert.ok(router);

        let capturedTransportOptions = null;
        const routerStub = {
            createWebRtcTransport: async (options) => {
                capturedTransportOptions = options;
                return {
                    id: 'fallback-transport-1',
                    iceParameters: {},
                    iceCandidates: [],
                    dtlsParameters: {},
                };
            },
        };

        const result = await createWebRtcTransport(routerStub);
        assert.ok(result);
        assert.equal('webRtcServer' in capturedTransportOptions, false);
        assert.deepEqual(capturedTransportOptions.listenIps, [
            { ip: '0.0.0.0', announcedIp: '192.168.1.50' },
        ]);
    } finally {
        harness.restore();
    }
});
