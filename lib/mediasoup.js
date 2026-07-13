// lib/mediasoup.js - Mediasoup Worker, Router, Transport creation
const mediasoup = require('mediasoup');
const config = require('../config');

let worker = null;
let router = null;
let webRtcServer = null;
let workerDeathHandler = null;

function setWorkerDeathHandler(fn) {
    workerDeathHandler = typeof fn === 'function' ? fn : null;
}

/**
 * Create a shared WebRtcServer so every WebRtcTransport multiplexes over one
 * (or two, with a distinct public announce) UDP/TCP port instead of binding
 * its own port from the RTC range. Without this, the ~100-port range caps the
 * whole server at ~100 concurrent transports (host + viewers + WHIP + WHEP).
 * Returns null on failure — transports then fall back to per-transport ports.
 */
async function createSharedWebRtcServer(workerInstance) {
    const ip = config.RTC_LISTEN_IP;
    const isLoopback = ip === '127.0.0.1';
    const basePort = config.RTC_MIN_PORT;
    const primaryAnnounced = isLoopback ? undefined : (config.LAN_IP || undefined);

    const listenInfos = [];
    // Public announce first so remote viewers prefer the public candidate,
    // mirroring the previous per-transport listenIps ordering.
    if (!isLoopback && config.PUBLIC_IP && config.PUBLIC_IP !== config.LAN_IP) {
        listenInfos.push({ protocol: 'udp', ip, announcedAddress: config.PUBLIC_IP, port: basePort + 1 });
        listenInfos.push({ protocol: 'tcp', ip, announcedAddress: config.PUBLIC_IP, port: basePort + 1 });
    }
    listenInfos.push({ protocol: 'udp', ip, announcedAddress: primaryAnnounced, port: basePort });
    listenInfos.push({ protocol: 'tcp', ip, announcedAddress: primaryAnnounced, port: basePort });

    try {
        const server = await workerInstance.createWebRtcServer({ listenInfos });
        const ports = [...new Set(listenInfos.map((info) => info.port))].join(', ');
        console.log(`Shared WebRTC server listening on ${ip} port(s) ${ports} (udp/tcp)`);
        return server;
    } catch (err) {
        console.warn(`Could not create shared WebRTC server (${err.message}). Falling back to per-transport ports; concurrent transports are limited by the RTC port range.`);
        return null;
    }
}

async function createMediasoupWorker() {
    worker = await mediasoup.createWorker({
        logLevel: config.MEDIASOUP_WORKER_LOG_LEVEL,
        rtcMinPort: config.RTC_MIN_PORT,
        rtcMaxPort: config.RTC_MAX_PORT,
    });

    worker.on('died', () => {
        console.error('Mediasoup worker died unexpectedly.');
        webRtcServer = null;
        if (typeof workerDeathHandler === 'function') {
            // Let the application layer decide how to recover (e.g. auto-restart).
            workerDeathHandler();
        } else {
            // No handler registered — exit so an external supervisor can restart us.
            setTimeout(() => process.exit(1), 2000);
        }
    });

    router = await worker.createRouter({ mediaCodecs: config.MEDIA_CODECS });
    webRtcServer = await createSharedWebRtcServer(worker);
    return { worker, router };
}

async function createWebRtcTransport(routerInstance, { purpose = 'host' } = {}) {
    // Host/WHIP transports start with high bitrate (LAN localhost path).
    // WHEP/viewer transports use conservative BWE to avoid remote congestion.
    const initialBitrate = (purpose === 'whep' || purpose === 'viewer')
        ? 600_000
        : 8_000_000;

    let transport;
    if (webRtcServer) {
        // Preferred path: all transports share the WebRtcServer's port(s),
        // so concurrent transport count is not bounded by the RTC port range.
        transport = await routerInstance.createWebRtcTransport({
            webRtcServer,
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            initialAvailableOutgoingBitrate: initialBitrate,
        });
    } else {
        // Fallback: per-transport ports (one port per transport from the range).
        // Bind the media plane to exactly what RTC_LISTEN_IP resolves to — no
        // silent promotion of loopback to 0.0.0.0. When the HTTP server is
        // loopback-bound, RTC_LISTEN_IP is 127.0.0.1 so media stays truly local.
        // LAN/public viewing requires BIND_HOST=0.0.0.0 (which also resolves
        // RTC_LISTEN_IP to 0.0.0.0) or an explicit RTC_LISTEN_IP.
        const effectiveListenIp = config.RTC_LISTEN_IP;
        const isLoopbackMedia = effectiveListenIp === '127.0.0.1';

        // When media is loopback-only, do not advertise a LAN/public address: ICE
        // candidates must be reachable from where the viewer actually connects.
        const listenIps = [{ ip: effectiveListenIp, announcedIp: isLoopbackMedia ? undefined : config.LAN_IP }];
        if (!isLoopbackMedia && config.PUBLIC_IP && config.PUBLIC_IP !== config.LAN_IP) {
            listenIps.unshift({ ip: effectiveListenIp, announcedIp: config.PUBLIC_IP });
        }

        transport = await routerInstance.createWebRtcTransport({
            listenIps,
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            initialAvailableOutgoingBitrate: initialBitrate,
        });
    }

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

module.exports = { createMediasoupWorker, createWebRtcTransport, getRouterRtpCapabilities, setWorkerDeathHandler };
