// lib/rooms.js - Room management: code generation, host/viewer tracking, heartbeat cleanup
const crypto = require('crypto');
const config = require('../config');

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

const rooms = new Map();
const socketToRoom = new Map();

/**
 * Resolve the active video/audio producers for a room based on ingest mode.
 * Used by join-room, get-producers, consume, getRoomStats, and WHEP routes.
 */
function getActiveRoomProducers(room) {
    if (room.ingestMode === 'obs') {
        return {
            videoProducer: room.whipProducer,
            audioProducer: room.whipAudioProducer,
        };
    }
    return {
        videoProducer: room.producer,
        audioProducer: room.audioProducer,
    };
}

function generateCode() {
    let code;
    do {
        code = '';
        for (let i = 0; i < CODE_LENGTH; i++) {
            code += CHARS[crypto.randomInt(CHARS.length)];
        }
    } while (rooms.has(code));
    return code;
}

function createRoom(hostSocketId, options = {}) {
    const code = generateCode();
    const ingestMode = options.ingestMode || 'browser';
    const obsAv1Mode = ingestMode === 'obs' && options.obsAv1Mode === true;
    const room = {
        code,
        hostSocketId,
        hostToken: crypto.randomBytes(24).toString('hex'),
        viewers: new Set(),
        relayViewers: new Set(),
        producer: null,
        audioProducer: null,
        hostTransport: null,
        viewerTransports: new Map(),
        allowMediaControl: options.allowMediaControl === true,
        mediaInit: null,
        initChunk: null,
        createdAt: Date.now(),
        lastHeartbeat: Date.now(),

        // OBS / WHIP state
        ingestMode,
        // Host-configured capture frame rate; used by the H.264 relay to assign
        // constant-rate timestamps to the depacketized video.
        frameRate: (Number.isFinite(options.frameRate) && options.frameRate >= 1 && options.frameRate <= 120)
            ? Math.round(options.frameRate)
            : null,
        // Host-selected quality-tier bitrate (kbps) for the H.264 fallback relay's
        // re-encode. Bounded to a sane range; null => relay uses its tier default.
        relayVideoKbps: (Number.isFinite(options.relayVideoKbps) && options.relayVideoKbps >= 1000 && options.relayVideoKbps <= 60000)
            ? Math.round(options.relayVideoKbps)
            : null,
        obsAv1Mode,
        obsVideoCodec: ingestMode === 'obs' ? (obsAv1Mode ? 'av1' : 'h264') : null,
        turnConfig: obsAv1Mode ? config.normalizeTurnConfig(options.turnConfig) : null,
        iceServers: [],
        hasRoomTurnServer: false,
        relayAllowed: ingestMode !== 'obs' || !obsAv1Mode,
        whipSessionId: null,
        whipStarting: false,
        whipGeneration: null,
        whipResourceId: null,
        whipTransport: null,
        whipProducer: null,
        whipAudioProducer: null,
        whipConnected: false,
        whipReconnecting: false,
        whipGraceTimer: null,

        // Fallback relay state
        relaySupported: ingestMode === 'obs' && !obsAv1Mode,
        fallbackAvailable: false,
        fallbackFormat: 'fmp4',
        fallbackCodec: null,
        fallbackAudioCodec: null,
        fallbackTiers: ['passthrough'],
        fallbackGeneration: 0,
        fallbackInitSegment: null,
        fallbackSequence: 0,
        fallbackWorker: null,
        // Owns fallback startup generation, resources, timers, and capacity slot.
        _mediaPipeline: null,
        // Public status mirror maintained by RoomMediaPipeline.
        fallbackStarting: false,
        fallbackStartedAt: null,
        fallbackRestartCount: 0,
        fallbackLastError: null,
        fallbackViewerCount: 0,
        fallbackViewers: new Set(),
        fallbackH264Profile: null,

        // WHEP viewer sessions
        whepSessions: new Map(),
        whepViewerCount: 0,
        whepPendingReservations: 0,
    };

    refreshRoomIceServers(room);
    rooms.set(code, room);
    socketToRoom.set(hostSocketId, code);
    return room;
}

function refreshRoomIceServers(room) {
    if (!room) return [];

    room.iceServers = room.turnConfig
        ? config.buildIceServers(room.turnConfig)
        : config.getIceServers();
    room.hasRoomTurnServer = config.iceServersIncludeTurn(room.iceServers);
    return room.iceServers;
}

function joinRoom(code, viewerSocketId) {
    const room = rooms.get(code);
    if (!room) return null;
    room.viewers.add(viewerSocketId);
    socketToRoom.set(viewerSocketId, code);
    return room;
}

function findRoomByCode(code) {
    return rooms.get(code) || null;
}

function reclaimHostRoom(code, hostSocketId, hostToken) {
    const room = rooms.get(code);
    if (!room) return null;
    if (!hostToken || room.hostToken !== hostToken) return null;

    socketToRoom.delete(room.hostSocketId);
    room.hostSocketId = hostSocketId;
    socketToRoom.set(hostSocketId, code);
    room.lastHeartbeat = Date.now();
    return room;
}

function findRoomByHost(hostSocketId) {
    const code = socketToRoom.get(hostSocketId);
    if (!code) return null;
    const room = rooms.get(code);
    if (room && room.hostSocketId === hostSocketId) return room;
    return null;
}

function findRoomBySocket(socketId) {
    const code = socketToRoom.get(socketId);
    if (!code) return null;
    return rooms.get(code) || null;
}

function removeViewer(socketId) {
    const code = socketToRoom.get(socketId);
    if (!code) return null;

    const room = rooms.get(code);
    if (!room) {
        socketToRoom.delete(socketId);
        return null;
    }

    room.viewers.delete(socketId);
    room.relayViewers.delete(socketId);
    if (room.fallbackViewers) {
        room.fallbackViewers.delete(socketId);
        room.fallbackViewerCount = room.fallbackViewers.size;
    }
    const viewerData = room.viewerTransports.get(socketId);
    if (viewerData) {
        if (viewerData.consumers) {
            viewerData.consumers.forEach((consumer) => {
                try { consumer.close(); } catch { }
            });
        }
        if (viewerData.recvTransport) {
            try { viewerData.recvTransport.close(); } catch { }
        }
        room.viewerTransports.delete(socketId);
    }

    socketToRoom.delete(socketId);
    return room;
}

function destroyRoom(code) {
    const room = rooms.get(code);
    if (!room) return;

    if (room.producer) {
        try { room.producer.close(); } catch { }
    }
    if (room.audioProducer) {
        try { room.audioProducer.close(); } catch { }
    }
    if (room.hostTransport) {
        try { room.hostTransport.close(); } catch { }
    }

    for (const [, viewerData] of room.viewerTransports) {
        if (viewerData.consumers) {
            viewerData.consumers.forEach((consumer) => {
                try { consumer.close(); } catch { }
            });
        }
        if (viewerData.recvTransport) {
            try { viewerData.recvTransport.close(); } catch { }
        }
    }

    // Clean up WHIP/OBS resources
    if (room.whipGraceTimer) {
        clearTimeout(room.whipGraceTimer);
        room.whipGraceTimer = null;
    }
    if (room.whipProducer) {
        try { room.whipProducer.close(); } catch { }
    }
    if (room.whipAudioProducer) {
        try { room.whipAudioProducer.close(); } catch { }
    }
    if (room.whipTransport) {
        try { room.whipTransport.close(); } catch { }
    }
    if (room._mediaPipeline) {
        try { room._mediaPipeline.close(); } catch { }
        room._mediaPipeline = null;
        room.fallbackWorker = null;
    } else if (room.fallbackWorker) {
        try { room.fallbackWorker.stop(); } catch { }
        room.fallbackWorker = null;
    }
    room.fallbackInitSegment = null;

    // Clean up WHEP sessions
    const { closeAllWhepSessions } = require('./whepRoutes');
    closeAllWhepSessions(room);

    for (const socketId of room.viewers) {
        socketToRoom.delete(socketId);
    }

    socketToRoom.delete(room.hostSocketId);
    rooms.delete(code);
}

function touchRoom(code) {
    const room = rooms.get(code);
    if (room) room.lastHeartbeat = Date.now();
}

function getRoomStats(code) {
    const room = rooms.get(code);
    if (!room) return null;
    const mediasoupConsumerCount = Array.from(room.viewerTransports.values())
        .reduce((sum, viewerData) => sum + (viewerData?.consumers?.length || 0), 0);
    const { videoProducer, audioProducer } = getActiveRoomProducers(room);
    return {
        code: room.code,
        hostSocketId: room.hostSocketId,
        viewerCount: room.viewers.size,
        relayViewerCount: room.relayViewers.size,
        mediasoupConsumerCount,
        hasProducer: !!videoProducer,
        hasAudioProducer: !!audioProducer,
        createdAt: room.createdAt,
        lastHeartbeat: room.lastHeartbeat,
        ingestMode: room.ingestMode,
        obsAv1Mode: room.obsAv1Mode,
        obsVideoCodec: room.obsVideoCodec,
        relayAllowed: room.relayAllowed,
        hasRoomTurnServer: room.hasRoomTurnServer,
        whipConnected: room.whipConnected,
        fallbackAvailable: room.fallbackAvailable,
        fallbackCodec: room.fallbackCodec,
        fallbackViewerCount: room.fallbackViewers ? room.fallbackViewers.size : 0,
        fallbackGeneration: room.fallbackGeneration,
        whepViewerCount: room.whepViewerCount || 0,
        totalViewerCount: room.viewers.size + (room.whepViewerCount || 0),
    };
}

function getAllRoomStats() {
    return Array.from(rooms.keys()).map((code) => getRoomStats(code)).filter(Boolean);
}

function getRoomCount() {
    return rooms.size;
}

let cleanupInterval = null;

function startRoomCleanup(options = {}) {
    stopRoomCleanup();

    const onStaleRoom = typeof options.onStaleRoom === 'function'
        ? options.onStaleRoom
        : null;
    cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [code, room] of rooms) {
            // WHIP connection counts as room liveness
            if (room.whipConnected) {
                room.lastHeartbeat = now;
            }

            if (now - room.lastHeartbeat > config.ROOM_STALE_TIMEOUT_MS) {
                const staleForSec = Math.round((now - room.lastHeartbeat) / 1000);
                console.log(`Cleaning stale room ${code} (no heartbeat for ${staleForSec}s)`);

                let handled = false;
                if (onStaleRoom) {
                    try {
                        handled = onStaleRoom(room, { staleForSec, now }) === true;
                    } catch (err) {
                        console.error(`Stale-room cleanup hook failed for ${code}: ${err.message}`);
                    }
                }

                if (!handled) {
                    destroyRoom(code);
                }
            }
        }
    }, config.ROOM_HEARTBEAT_INTERVAL_MS);
}

function stopRoomCleanup() {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
}

module.exports = {
    createRoom,
    joinRoom,
    findRoomByHost,
    findRoomByCode,
    reclaimHostRoom,
    findRoomBySocket,
    removeViewer,
    destroyRoom,
    getRoomStats,
    getAllRoomStats,
    getRoomCount,
    getActiveRoomProducers,
    refreshRoomIceServers,
    startRoomCleanup,
    stopRoomCleanup,
    touchRoom,
};
