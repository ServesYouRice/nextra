// lib/mediasoup.js - Mediasoup Worker, Router, Transport creation
const mediasoup = require('mediasoup');
const config = require('../config');

let worker = null;
let router = null;
let workerDeathHandler = null;

function setWorkerDeathHandler(fn) {
    workerDeathHandler = typeof fn === 'function' ? fn : null;
}

async function createMediasoupWorker() {
    worker = await mediasoup.createWorker({
        logLevel: config.MEDIASOUP_WORKER_LOG_LEVEL,
        rtcMinPort: config.RTC_MIN_PORT,
        rtcMaxPort: config.RTC_MAX_PORT,
    });

    worker.on('died', () => {
        console.error('Mediasoup worker died unexpectedly.');
        if (typeof workerDeathHandler === 'function') {
            // Let the application layer decide how to recover (e.g. auto-restart).
            workerDeathHandler();
        } else {
            // No handler registered — exit so an external supervisor can restart us.
            setTimeout(() => process.exit(1), 2000);
        }
    });

    router = await worker.createRouter({ mediaCodecs: config.MEDIA_CODECS });
    return { worker, router };
}

async function createWebRtcTransport(routerInstance, { purpose = 'host' } = {}) {
    // Bind the media plane to exactly what RTC_LISTEN_IP resolves to — no silent
    // promotion of loopback to 0.0.0.0. When the HTTP server is loopback-bound,
    // RTC_LISTEN_IP is 127.0.0.1 so media stays truly local. LAN/public viewing
    // requires BIND_HOST=0.0.0.0 (which also resolves RTC_LISTEN_IP to 0.0.0.0)
    // or an explicit RTC_LISTEN_IP; HTTP must be reachable for those viewers too.
    const effectiveListenIp = config.RTC_LISTEN_IP;
    const isLoopbackMedia = effectiveListenIp === '127.0.0.1';

    // When media is loopback-only, do not advertise a LAN/public address: ICE
    // candidates must be reachable from where the viewer actually connects.
    const listenIps = [{ ip: effectiveListenIp, announcedIp: isLoopbackMedia ? undefined : config.LAN_IP }];
    if (!isLoopbackMedia && config.PUBLIC_IP && config.PUBLIC_IP !== config.LAN_IP) {
        listenIps.unshift({ ip: effectiveListenIp, announcedIp: config.PUBLIC_IP });
    }

    // Host/WHIP transports start with high bitrate (LAN localhost path).
    // WHEP/viewer transports use conservative BWE to avoid remote congestion.
    const initialBitrate = (purpose === 'whep' || purpose === 'viewer')
        ? 600_000
        : 8_000_000;

    const transport = await routerInstance.createWebRtcTransport({
        listenIps,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: initialBitrate,
    });

    return {
        transport,
        params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
        },
    };
}

async function createPlainTransport(routerInstance, { rtcpMux = false } = {}) {
    const transport = await routerInstance.createPlainTransport({
        listenIp: { ip: '127.0.0.1' },
        rtcpMux,
        comedia: false,
    });

    return {
        transport,
        params: {
            id: transport.id,
            ip: transport.tuple.localIp,
            port: transport.tuple.localPort,
            rtcpPort: rtcpMux ? undefined : transport.rtcpTuple?.localPort,
        },
    };
}

function getRouterRtpCapabilities() {
    if (!router) throw new Error('Router not initialized');
    return router.rtpCapabilities;
}

module.exports = { createMediasoupWorker, createWebRtcTransport, createPlainTransport, getRouterRtpCapabilities, setWorkerDeathHandler };
