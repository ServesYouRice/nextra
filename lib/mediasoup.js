// lib/mediasoup.js - Mediasoup Worker, Router, Transport creation
const mediasoup = require('mediasoup');
const config = require('../config');

let worker = null;
let router = null;

async function createMediasoupWorker() {
    worker = await mediasoup.createWorker({
        logLevel: config.MEDIASOUP_WORKER_LOG_LEVEL,
        rtcMinPort: config.RTC_MIN_PORT,
        rtcMaxPort: config.RTC_MAX_PORT,
    });

    worker.on('died', () => {
        console.error('Mediasoup Worker died unexpectedly. Restarting in 2s...');
        setTimeout(() => process.exit(1), 2000);
    });

    router = await worker.createRouter({ mediaCodecs: config.MEDIA_CODECS });
    return { worker, router };
}

async function createWebRtcTransport(routerInstance) {
    // Use 0.0.0.0 when the default inherited 127.0.0.1 from BIND_HOST — loopback
    // blocks all non-localhost WebRTC connections (ICE candidates are unreachable).
    const effectiveListenIp = config.RTC_LISTEN_IP === '127.0.0.1' ? '0.0.0.0' : config.RTC_LISTEN_IP;

    const listenIps = [{ ip: effectiveListenIp, announcedIp: config.LAN_IP }];
    if (config.PUBLIC_IP && config.PUBLIC_IP !== config.LAN_IP) {
        listenIps.unshift({ ip: effectiveListenIp, announcedIp: config.PUBLIC_IP });
    }

    const transport = await routerInstance.createWebRtcTransport({
        listenIps,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
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

function getRouterRtpCapabilities() {
    if (!router) throw new Error('Router not initialized');
    return router.rtpCapabilities;
}

module.exports = { createMediasoupWorker, createWebRtcTransport, getRouterRtpCapabilities };
