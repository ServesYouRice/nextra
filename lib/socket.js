// lib/socket.js - Socket.io signaling handlers for WebRTC + room management
const { execFile } = require('child_process');
const config = require('../config');
const { createWebRtcTransport, getRouterRtpCapabilities, createPlainTransport } = require('./mediasoup');
const { FFmpegRelay } = require('./ffmpegRelay');
const {
    normalizeIp,
    getTrustedForwardedClientIp,
} = require('./network');
const {
    createRoom,
    joinRoom,
    findRoomByHost,
    findRoomByCode,
    reclaimHostRoom,
    findRoomBySocket,
    removeViewer,
    destroyRoom,
    touchRoom,
    getAllRoomStats,
} = require('./rooms');

const joinAttempts = new Map(); // IP -> { count, resetAt }
const lastToggleByRoom = new Map(); // roomCode -> timestamp
const lastToggleByViewer = new Map(); // roomCode:socketId -> timestamp
const hostReconnectTimers = new Map(); // roomCode -> timeout
const ignoredTransportIds = new Set();
let joinCleanupInterval = null;
let metricsBroadcastInterval = null;

const MAX_CHUNK_SIZE = config.MEDIA_MAX_CHUNK_SIZE;

const activeConsumerIds = new Set();
const activeProducerIds = new Set();
const roomRelayMetrics = new Map(); // roomCode -> relay counters

const runtimeMetrics = {
    startedAt: Date.now(),
    totalConnections: 0,
    activeSockets: 0,
    roomsCreated: 0,
    joinDeniedRateLimit: 0,
    joinDeniedRoomFull: 0,
    toggleRequests: 0,
    toggleDenied: 0,
    relayStartRequests: 0,
    relayStopRequests: 0,
    relayChunksDroppedOversized: 0,
    relayChunksReceived: 0,
    relayBytesReceived: 0,
    relayChunksForwarded: 0,
    relayBytesForwarded: 0,
    consumesCreated: 0,
    consumerResumeCalls: 0,
    consumeDenied: 0,
    producersCreated: 0,
};

let keyboard = null;
let Key = null;
let nutInitAttempted = false;

async function loadNutJs() {
    if (keyboard || nutInitAttempted) return;
    nutInitAttempted = true;
    try {
        const nutjs = require('@nut-tree-fork/nut-js');
        keyboard = nutjs.keyboard;
        Key = nutjs.Key;
    } catch (err) {
        console.warn('nut.js is unavailable. Falling back to OS media key path when possible:', err.message);
    }
}

function pressMediaPlayPauseFallback() {
    return new Promise((resolve, reject) => {
        if (process.platform === 'win32') {
            const psScript = `
$signature = @"
using System;
using System.Runtime.InteropServices;
public static class NativeWin32 {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@;
Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue | Out-Null;
[NativeWin32]::keybd_event(0xB3, 0, 0, [UIntPtr]::Zero);
Start-Sleep -Milliseconds 40;
[NativeWin32]::keybd_event(0xB3, 0, 2, [UIntPtr]::Zero);
`;
            execFile(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
                { windowsHide: true, timeout: 3000 },
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        } else if (process.platform === 'linux') {
            execFile('xdotool', ['key', 'XF86AudioPlay'], { timeout: 3000 }, (err) => {
                if (err) reject(new Error('Linux fallback requires xdotool to be installed.'));
                else resolve();
            });
        } else {
            reject(new Error('Media control fallback is not supported on this operating system (macOS). Please install @nut-tree-fork/nut-js.'));
        }
    });
}

function isValidRoomCode(code) {
    return typeof code === 'string' && /^[A-Z2-9]{6}$/.test(code);
}

function isValidTransportId(id) {
    return typeof id === 'string' && id.length > 0 && id.length < 100;
}

function isValidProducerId(id) {
    return typeof id === 'string' && id.length > 0 && id.length < 100;
}

function isValidConsumerId(id) {
    return typeof id === 'string' && id.length > 0 && id.length < 100;
}

function getSocketIp(socket) {
    const peerAddress = socket?.request?.socket?.remoteAddress
        || socket?.conn?.remoteAddress
        || socket?.handshake?.address
        || '';
    const forwardedIp = getTrustedForwardedClientIp(
        socket?.handshake?.headers || {},
        peerAddress,
        config.TRUST_X_FORWARDED_HEADERS
    );
    if (forwardedIp) return forwardedIp;

    return normalizeIp(socket.handshake.address || 'unknown');
}

function emitHostDisconnected(io, roomCode, reason, recoverable = false) {
    io.to(roomCode).emit('host-disconnected', { reason, recoverable });
}

function clearHostReconnectTimer(roomCode) {
    const timer = hostReconnectTimers.get(roomCode);
    if (timer) {
        clearTimeout(timer);
        hostReconnectTimers.delete(roomCode);
    }
}

function safeCallback(callback, payload) {
    if (typeof callback === 'function') {
        callback(payload);
    }
}

function getOrCreateRoomRelayMetrics(roomCode) {
    let roomMetric = roomRelayMetrics.get(roomCode);
    if (!roomMetric) {
        roomMetric = {
            chunksReceived: 0,
            bytesReceived: 0,
            chunksForwarded: 0,
            bytesForwarded: 0,
            droppedOversized: 0,
        };
        roomRelayMetrics.set(roomCode, roomMetric);
    }
    return roomMetric;
}

function deleteRoomRelayMetrics(roomCode) {
    roomRelayMetrics.delete(roomCode);
}

function markTransportForShutdown(transport) {
    if (transport?.id) {
        ignoredTransportIds.add(transport.id);
    }
}

function markViewerTransportForShutdown(room, socketId) {
    const viewerData = room?.viewerTransports?.get(socketId);
    if (viewerData?.recvTransport) {
        markTransportForShutdown(viewerData.recvTransport);
    }
}

function markRoomTransportsForShutdown(room) {
    if (!room) return;

    markTransportForShutdown(room.hostTransport);
    for (const viewerData of room.viewerTransports.values()) {
        markTransportForShutdown(viewerData?.recvTransport);
    }
}

function cleanupRoomTransientState(roomCode) {
    clearHostReconnectTimer(roomCode);
    deleteRoomRelayMetrics(roomCode);
}

function getRelayAudienceRoom(roomCode) {
    return `${roomCode}:relay`;
}

function updateRelayAudienceMembership(io, roomCode, viewerSocketId, useRelay) {
    const viewerSocket = io?.sockets?.sockets?.get(viewerSocketId);
    if (!viewerSocket) return;

    const relayRoom = getRelayAudienceRoom(roomCode);
    if (useRelay) {
        viewerSocket.join(relayRoom);
    } else {
        viewerSocket.leave(relayRoom);
    }
}

function clearRelayAudienceMembership(io, room) {
    if (!room || room.relayViewers.size === 0) return;

    for (const viewerSocketId of room.relayViewers) {
        updateRelayAudienceMembership(io, room.code, viewerSocketId, false);
    }
}

function destroyRoomWithReason(io, roomCode, reason, recoverable = false) {
    const room = findRoomByCode(roomCode);
    if (!room) return false;

    if (reason) {
        emitHostDisconnected(io, roomCode, reason, recoverable);
    }
    clearRelayAudienceMembership(io, room);
    markRoomTransportsForShutdown(room);
    cleanupRoomTransientState(roomCode);
    destroyRoom(roomCode);
    return true;
}

function getRuntimeMetricsSnapshot() {
    const rooms = getAllRoomStats();
    const activeRelayViewers = rooms.reduce((sum, room) => sum + room.relayViewerCount, 0);
    const activeViewers = rooms.reduce((sum, room) => sum + room.viewerCount, 0);

    return {
        startedAt: runtimeMetrics.startedAt,
        uptimeSec: Math.floor((Date.now() - runtimeMetrics.startedAt) / 1000),
        counters: {
            ...runtimeMetrics,
            activeConsumers: activeConsumerIds.size,
            activeProducers: activeProducerIds.size,
            activeRooms: rooms.length,
            activeViewers,
            activeRelayViewers,
        },
        rooms: rooms.map((room) => ({
            ...room,
            relay: roomRelayMetrics.get(room.code) || {
                chunksReceived: 0,
                bytesReceived: 0,
                chunksForwarded: 0,
                bytesForwarded: 0,
                droppedOversized: 0,
            },
        })),
    };
}

function emitHostMetrics(io, roomCode) {
    if (!io || !roomCode) return;
    const summary = getAllRoomStats().find((room) => room.code === roomCode);
    if (!summary) return;

    const fullRoom = findRoomByCode(summary.code);
    io.to(summary.hostSocketId).emit('room-metrics', {
        roomCode: summary.code,
        viewerCount: summary.viewerCount,
        relayViewerCount: summary.relayViewerCount,
        mediasoupConsumerCount: summary.mediasoupConsumerCount,
        hasProducer: summary.hasProducer,
        hasAudioProducer: summary.hasAudioProducer,
        fallbackAvailable: fullRoom?.fallbackAvailable,
        fallbackViewerCount: fullRoom?.fallbackViewerCount || 0,
        fallbackCodec: fullRoom?.fallbackCodec,
        fallbackGeneration: fullRoom?.fallbackGeneration,
        relay: roomRelayMetrics.get(summary.code) || {
            chunksReceived: 0,
            bytesReceived: 0,
            chunksForwarded: 0,
            bytesForwarded: 0,
            droppedOversized: 0,
        },
        runtime: {
            activeConsumers: activeConsumerIds.size,
            activeProducers: activeProducerIds.size,
            totalConnections: runtimeMetrics.totalConnections,
            activeSockets: runtimeMetrics.activeSockets,
        },
    });
}

function emitAllHostsMetrics(io) {
    const rooms = getAllRoomStats();

    // Prune stale metric entries for rooms that no longer exist.
    const activeCodes = new Set(rooms.map((room) => room.code));
    for (const code of roomRelayMetrics.keys()) {
        if (!activeCodes.has(code)) {
            roomRelayMetrics.delete(code);
        }
    }

    rooms.forEach((room) => emitHostMetrics(io, room.code));
}

function emitRelayDemandChanged(io, room) {
    if (!room) return;
    io.to(room.hostSocketId).emit('relay-demand-changed', { count: room.relayViewers.size });
}

function setViewerRelayMode(io, room, viewerSocketId, useRelay) {
    if (!room || room.hostSocketId === viewerSocketId) {
        return false;
    }

    const wasRelay = room.relayViewers.has(viewerSocketId);
    if (useRelay === wasRelay) {
        return false;
    }

    if (useRelay) {
        room.relayViewers.add(viewerSocketId);
    } else {
        room.relayViewers.delete(viewerSocketId);
    }
    updateRelayAudienceMembership(io, room.code, viewerSocketId, useRelay);

    if (room.relayViewers.size === 0) {
        room.mediaInit = null;
        room.initChunk = null;
    }

    emitRelayDemandChanged(io, room);
    return true;
}

function emitToRelayViewers(io, room, event, payload) {
    if (!room || room.relayViewers.size === 0) return 0;
    io.to(getRelayAudienceRoom(room.code)).emit(event, payload);
    return room.relayViewers.size;
}

function removeConsumerFromViewer(viewerData, consumerId) {
    if (!viewerData || !viewerData.consumers) return;
    viewerData.consumers = viewerData.consumers.filter((consumer) => consumer.id !== consumerId);
}

function attachTransportStateHandlers(transport, onTerminalState) {
    if (!transport || typeof transport.on !== 'function') return;

    const transportId = transport.id;
    let handled = false;
    const maybeHandle = (kind, state) => {
        if (handled) return;
        if (ignoredTransportIds.has(transportId)) return;
        if (state !== 'failed' && state !== 'closed') return;

        handled = true;
        onTerminalState(kind, state);
    };

    transport.on('dtlsstatechange', (state) => maybeHandle('dtls', state));
    transport.on('icestatechange', (state) => maybeHandle('ice', state));
    transport.on('close', () => {
        ignoredTransportIds.delete(transportId);
    });
}

function handleViewerTransportFailure(io, socket, roomCode, transportId, kind, state) {
    const room = findRoomByCode(roomCode);
    const viewerData = room?.viewerTransports?.get(socket.id);
    if (!room || room.hostSocketId === socket.id || !viewerData || viewerData.recvTransport?.id !== transportId) {
        return false;
    }

    console.warn(`Viewer transport ${transportId} entered ${kind}:${state} for room ${roomCode}`);
    socket.emit('transport-failed', {
        reason: 'Stream connection failed. Please rejoin the room.',
    });

    const wasRelayViewer = room.relayViewers.has(socket.id);
    if (wasRelayViewer) {
        updateRelayAudienceMembership(io, room.code, socket.id, false);
    }
    const updatedRoom = removeViewer(socket.id);
    if (!updatedRoom) return true;

    try { socket.leave(updatedRoom.code); } catch { }
    io.to(updatedRoom.hostSocketId).emit('viewer-count', { count: updatedRoom.viewers.size });
    if (wasRelayViewer) {
        emitRelayDemandChanged(io, updatedRoom);
    }
    emitHostMetrics(io, updatedRoom.code);
    return true;
}

function handleHostTransportFailure(io, socket, roomCode, transportId, kind, state) {
    const room = findRoomByCode(roomCode);
    if (!room || room.hostSocketId !== socket.id || room.hostTransport?.id !== transportId) {
        return false;
    }

    console.warn(`Host transport ${transportId} entered ${kind}:${state} for room ${roomCode}`);
    socket.emit('transport-failed', {
        reason: 'Host media connection failed. Please start sharing again.',
    });

    return destroyRoomWithReason(io, roomCode, 'Host media connection failed.', false);
}

async function applyConsumerPriority(consumer) {
    if (!consumer || typeof consumer.setPriority !== 'function') return;

    const priority = consumer.kind === 'audio' ? 255 : 2;
    try {
        await consumer.setPriority(priority);
    } catch (err) {
        console.warn(`Could not set ${consumer.kind} consumer priority: ${err.message}`);
    }
}

/**
 * Start the fallback relay pipeline for an OBS room.
 * Creates PlainTransport egress, spawns FFmpeg, wires up fMP4 parser events.
 */
async function startFallbackRelay(room, mediasoupRouter, io) {
    if (room.fallbackWorker) return; // already running
    if (!room.whipProducer) return; // no OBS media yet

    try {
        // Create PlainTransport for video egress
        const videoEgress = await createPlainTransport(mediasoupRouter);
        const videoConsumer = await videoEgress.transport.consume({
            producerId: room.whipProducer.id,
            rtpCapabilities: mediasoupRouter.rtpCapabilities,
        });

        let audioEgress = null;
        let audioConsumer = null;
        if (room.whipAudioProducer) {
            audioEgress = await createPlainTransport(mediasoupRouter);
            audioConsumer = await audioEgress.transport.consume({
                producerId: room.whipAudioProducer.id,
                rtpCapabilities: mediasoupRouter.rtpCapabilities,
            });
        }

        // Spawn FFmpeg
        const relay = new FFmpegRelay({
            roomCode: room.code,
            videoCodec: room.fallbackCodec || 'av1',
            hasAudio: !!audioConsumer,
            videoRtpPort: videoEgress.params.port,
            videoRtcpPort: videoEgress.params.rtcpPort,
            audioRtpPort: audioEgress ? audioEgress.params.port : 0,
            audioRtcpPort: audioEgress ? audioEgress.params.rtcpPort : 0,
            videoPayloadType: videoConsumer.rtpParameters.codecs[0].payloadType,
            audioPayloadType: audioConsumer ? audioConsumer.rtpParameters.codecs[0].payloadType : 111,
        });

        relay.on('init', (data) => {
            room.fallbackGeneration++;
            room.fallbackInitSegment = data.initSegment;
            room.fallbackAvailable = true;
            room.fallbackSequence = 0;

            // Build MIME type
            const h264Profile = room.fallbackH264Profile || '640032';
            const videoMime = room.fallbackCodec === 'av1'
                ? 'av01.0.08M.08'
                : `avc1.${h264Profile}`;
            const audioMime = room.fallbackAudioCodec === 'aac' ? ', mp4a.40.2' : '';
            const mimeType = `video/mp4; codecs="${videoMime}${audioMime}"`;

            // Emit to all fallback viewers
            for (const viewerId of room.fallbackViewers) {
                io.to(viewerId).emit('media-init', {
                    format: 'fmp4',
                    mimeType,
                    codec: room.fallbackCodec,
                    audioCodec: room.fallbackAudioCodec,
                    generation: room.fallbackGeneration,
                    tier: 'passthrough',
                });
            }
        });

        relay.on('fragment', (data) => {
            room.fallbackSequence = data.sequence;

            for (const viewerId of room.fallbackViewers) {
                io.to(viewerId).emit('media-chunk', {
                    format: 'fmp4',
                    generation: room.fallbackGeneration,
                    tier: 'passthrough',
                    sequence: data.sequence,
                    keyframeStart: data.keyframeStart,
                    chunk: data.data,
                });
            }
        });

        relay.on('error', (err) => {
            console.error(`[Fallback] Error for room ${room.code}:`, err.message);
            room.fallbackLastError = err.message;
            room.fallbackRestartCount = relay.restartCount;
            // If restart cap exceeded, mark fallback unavailable and notify viewers
            if (relay.restartCount >= (require('../config').FALLBACK_RESTART_CAP || 5)) {
                room.fallbackAvailable = false;
                for (const viewerId of room.fallbackViewers) {
                    io.to(viewerId).emit('fallback-error', { reason: 'worker-failed', message: err.message });
                }
            }
        });

        relay.on('exit', () => {
            room.fallbackAvailable = false;
            room.fallbackRestartCount = relay.restartCount;
        });

        await relay.start();

        room.fallbackWorker = relay;
        room.fallbackStartedAt = Date.now();
        room.fallbackAvailable = false; // will become true once init segment arrives

        // Store transports for cleanup
        room._fallbackVideoEgress = videoEgress;
        room._fallbackAudioEgress = audioEgress;
        room._fallbackVideoConsumer = videoConsumer;
        room._fallbackAudioConsumer = audioConsumer;

        console.log(`[Fallback] Started relay for room ${room.code}`);
    } catch (err) {
        console.error(`[Fallback] Failed to start relay for room ${room.code}:`, err);
        room.fallbackLastError = err.message;
    }
}

function stopFallbackRelay(room) {
    if (room.fallbackWorker) {
        room.fallbackWorker.stop();
        room.fallbackWorker = null;
    }
    if (room._fallbackVideoConsumer) {
        try { room._fallbackVideoConsumer.close(); } catch {}
        room._fallbackVideoConsumer = null;
    }
    if (room._fallbackAudioConsumer) {
        try { room._fallbackAudioConsumer.close(); } catch {}
        room._fallbackAudioConsumer = null;
    }
    if (room._fallbackVideoEgress) {
        try { room._fallbackVideoEgress.transport.close(); } catch {}
        room._fallbackVideoEgress = null;
    }
    if (room._fallbackAudioEgress) {
        try { room._fallbackAudioEgress.transport.close(); } catch {}
        room._fallbackAudioEgress = null;
    }
    room.fallbackAvailable = false;
    room.fallbackInitSegment = null;
    room.fallbackStartedAt = null;
    console.log(`[Fallback] Stopped relay for room ${room.code}`);
}

function registerSocketHandlers(io, router) {
    registerSocketHandlers._ioRef = io;

    io.on('connection', (socket) => {
        console.log(`Client connected: ${socket.id}`);
        runtimeMetrics.totalConnections += 1;
        runtimeMetrics.activeSockets += 1;

        socket.on('create-room', (data = {}, callback) => {
            try {
                const existingRoom = findRoomByHost(socket.id);
                if (existingRoom) {
                    console.warn(`Host ${socket.id} already had room ${existingRoom.code}. Replacing it.`);
                    destroyRoomWithReason(io, existingRoom.code, 'Host restarted stream', false);
                }

                const room = createRoom(socket.id, { allowMediaControl: !!data.allowMediaControl });
                runtimeMetrics.roomsCreated += 1;
                getOrCreateRoomRelayMetrics(room.code);
                socket.join(room.code);
                console.log(`Room created: ${room.code} by ${socket.id}`);
                safeCallback(callback, {
                    success: true,
                    code: room.code,
                    hostToken: room.hostToken,
                });
            } catch (err) {
                console.error('create-room error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('reclaim-host', ({ code, hostToken } = {}, callback) => {
            try {
                const cleanCode = (typeof code === 'string' ? code : '').trim().toUpperCase().replace(/-/g, '');
                if (!isValidRoomCode(cleanCode) || typeof hostToken !== 'string' || hostToken.length < 16) {
                    safeCallback(callback, { success: false, error: 'Invalid reclaim parameters.' });
                    return;
                }

                const room = reclaimHostRoom(cleanCode, socket.id, hostToken);
                if (!room) {
                    safeCallback(callback, { success: false, error: 'Room not found or token invalid.' });
                    return;
                }

                clearHostReconnectTimer(cleanCode);
                socket.join(cleanCode);
                io.to(cleanCode).emit('host-reconnected');
                io.to(socket.id).emit('relay-demand-changed', { count: room.relayViewers.size });
                console.log(`Host ${socket.id} reclaimed room ${cleanCode}`);
                safeCallback(callback, { success: true });
            } catch (err) {
                console.error('reclaim-host error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('join-room', ({ code } = {}, callback) => {
            try {
                const cleanCode = (typeof code === 'string' ? code : '').trim().toUpperCase().replace(/-/g, '');
                if (!isValidRoomCode(cleanCode)) {
                    safeCallback(callback, { success: false, error: 'Invalid room code format.' });
                    return;
                }

                const existingRoom = findRoomBySocket(socket.id);
                if (existingRoom) {
                    safeCallback(callback, { success: false, error: 'Already in a room. Leave first.' });
                    return;
                }

                const ip = getSocketIp(socket);
                const now = Date.now();
                const record = joinAttempts.get(ip) || { count: 0, resetAt: now + config.JOIN_RATE_LIMIT_WINDOW_MS };
                if (now > record.resetAt) {
                    record.count = 0;
                    record.resetAt = now + config.JOIN_RATE_LIMIT_WINDOW_MS;
                }
                record.count += 1;
                joinAttempts.set(ip, record);

                if (record.count > config.JOIN_RATE_LIMIT_MAX) {
                    runtimeMetrics.joinDeniedRateLimit += 1;
                    safeCallback(callback, { success: false, error: 'Too many attempts. Wait 1 minute.' });
                    return;
                }

                const room = joinRoom(cleanCode, socket.id);
                if (!room) {
                    safeCallback(callback, { success: false, error: 'Room not found.' });
                    return;
                }

                if (room.viewers.size > config.MAX_VIEWERS_PER_ROOM) {
                    removeViewer(socket.id);
                    runtimeMetrics.joinDeniedRoomFull += 1;
                    safeCallback(callback, {
                        success: false,
                        error: `Room is full (max ${config.MAX_VIEWERS_PER_ROOM} viewers).`,
                    });
                    return;
                }

                socket.join(room.code);
                console.log(`Viewer ${socket.id} joined room ${room.code} (${room.viewers.size} viewers)`);
                io.to(room.hostSocketId).emit('viewer-count', { count: room.viewers.size });
                emitHostMetrics(io, room.code);

                safeCallback(callback, {
                    success: true,
                    hasProducer: !!room.producer,
                    hasAudioProducer: !!room.audioProducer,
                    allowMediaControl: room.allowMediaControl,
                    ingestMode: room.ingestMode,
                    relaySupported: room.relaySupported,
                    fallbackAvailable: room.fallbackAvailable,
                    fallbackFormat: room.fallbackFormat,
                    fallbackCodec: room.fallbackCodec,
                    fallbackAudioCodec: room.fallbackAudioCodec,
                    fallbackTiers: room.fallbackTiers,
                    whipConnected: room.whipConnected,
                    whipReconnecting: room.whipReconnecting,
                });
            } catch (err) {
                console.error('join-room error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('get-rtp-capabilities', (data, callback) => {
            try {
                const rtpCapabilities = getRouterRtpCapabilities();
                safeCallback(callback, { success: true, rtpCapabilities });
            } catch (err) {
                console.error('get-rtp-capabilities error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('get-producers', (data, callback) => {
            try {
                const room = findRoomBySocket(socket.id);
                if (!room) {
                    safeCallback(callback, { success: false, error: 'Not in a room.' });
                    return;
                }

                const producers = [];
                if (room.producer) {
                    producers.push({ producerId: room.producer.id, kind: 'video' });
                }
                if (room.audioProducer) {
                    producers.push({ producerId: room.audioProducer.id, kind: 'audio' });
                }
                safeCallback(callback, { success: true, producers });
            } catch (err) {
                console.error('get-producers error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('get-room-metrics', (data, callback) => {
            try {
                const room = findRoomByHost(socket.id) || findRoomBySocket(socket.id);
                if (!room) {
                    safeCallback(callback, { success: false, error: 'Not in a room.' });
                    return;
                }

                const summary = getAllRoomStats().find((entry) => entry.code === room.code);
                if (!summary) {
                    safeCallback(callback, { success: false, error: 'Room not found.' });
                    return;
                }

                safeCallback(callback, {
                    success: true,
                    metrics: {
                        roomCode: summary.code,
                        viewerCount: summary.viewerCount,
                        relayViewerCount: summary.relayViewerCount,
                        mediasoupConsumerCount: summary.mediasoupConsumerCount,
                        hasProducer: summary.hasProducer,
                        hasAudioProducer: summary.hasAudioProducer,
                        relay: roomRelayMetrics.get(summary.code) || {
                            chunksReceived: 0,
                            bytesReceived: 0,
                            chunksForwarded: 0,
                            bytesForwarded: 0,
                            droppedOversized: 0,
                        },
                    },
                });
            } catch (err) {
                console.error('get-room-metrics error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('create-send-transport', async (data, callback) => {
            try {
                const room = findRoomByHost(socket.id);
                if (!room) {
                    safeCallback(callback, { success: false, error: 'You are not a host.' });
                    return;
                }

                if (room.producer) {
                    try { room.producer.close(); } catch { }
                    room.producer = null;
                }
                if (room.audioProducer) {
                    try { room.audioProducer.close(); } catch { }
                    room.audioProducer = null;
                }
                if (room.hostTransport) {
                    markTransportForShutdown(room.hostTransport);
                    try { room.hostTransport.close(); } catch { }
                    room.hostTransport = null;
                }

                const { transport, params } = await createWebRtcTransport(router);
                attachTransportStateHandlers(transport, (kind, state) => {
                    handleHostTransportFailure(io, socket, room.code, transport.id, kind, state);
                });
                room.hostTransport = transport;
                safeCallback(callback, {
                    success: true,
                    params,
                    iceServers: config.getIceServers(),
                });
            } catch (err) {
                console.error('create-send-transport error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('create-recv-transport', async (data, callback) => {
            try {
                const room = findRoomBySocket(socket.id);
                if (!room) {
                    safeCallback(callback, { success: false, error: 'Not in a room.' });
                    return;
                }

                const previous = room.viewerTransports.get(socket.id);
                if (previous) {
                    if (previous.consumers) {
                        previous.consumers.forEach((consumer) => {
                            try { consumer.close(); } catch { }
                        });
                    }
                    if (previous.recvTransport) {
                        markTransportForShutdown(previous.recvTransport);
                        try { previous.recvTransport.close(); } catch { }
                    }
                }

                const { transport, params } = await createWebRtcTransport(router);
                attachTransportStateHandlers(transport, (kind, state) => {
                    handleViewerTransportFailure(io, socket, room.code, transport.id, kind, state);
                });
                room.viewerTransports.set(socket.id, { recvTransport: transport, consumers: [] });

                safeCallback(callback, {
                    success: true,
                    params,
                    iceServers: config.getIceServers(),
                });
            } catch (err) {
                console.error('create-recv-transport error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('connect-transport', async ({ transportId, dtlsParameters } = {}, callback) => {
            try {
                if (!isValidTransportId(transportId) || !dtlsParameters) {
                    safeCallback(callback, { success: false, error: 'Invalid parameters.' });
                    return;
                }

                const room = findRoomBySocket(socket.id);
                if (!room) {
                    safeCallback(callback, { success: false, error: 'Not in a room.' });
                    return;
                }

                if (room.hostTransport && room.hostTransport.id === transportId) {
                    await room.hostTransport.connect({ dtlsParameters });
                    safeCallback(callback, { success: true });
                    return;
                }

                const viewerData = room.viewerTransports.get(socket.id);
                if (viewerData && viewerData.recvTransport && viewerData.recvTransport.id === transportId) {
                    await viewerData.recvTransport.connect({ dtlsParameters });
                    safeCallback(callback, { success: true });
                    return;
                }

                safeCallback(callback, { success: false, error: 'Transport not found.' });
            } catch (err) {
                console.error('connect-transport error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('produce', async ({ kind, rtpParameters, appData } = {}, callback) => {
            try {
                if (kind !== 'video' && kind !== 'audio') {
                    safeCallback(callback, { success: false, error: 'Invalid media kind.' });
                    return;
                }

                const room = findRoomByHost(socket.id);
                if (!room || !room.hostTransport) {
                    safeCallback(callback, { success: false, error: 'No send transport.' });
                    return;
                }

                const producer = await room.hostTransport.produce({ kind, rtpParameters, appData });
                runtimeMetrics.producersCreated += 1;
                activeProducerIds.add(producer.id);
                if (kind === 'video') room.producer = producer;
                if (kind === 'audio') room.audioProducer = producer;

                socket.to(room.code).emit('new-producer', { producerId: producer.id, kind: producer.kind });
                producer.on('transportclose', () => {
                    console.log(`Producer ${producer.id} transport closed`);
                    activeProducerIds.delete(producer.id);
                    if (kind === 'video' && room.producer?.id === producer.id) room.producer = null;
                    if (kind === 'audio' && room.audioProducer?.id === producer.id) room.audioProducer = null;
                    emitHostMetrics(io, room.code);
                });
                producer.on('close', () => {
                    activeProducerIds.delete(producer.id);
                    if (kind === 'video' && room.producer?.id === producer.id) room.producer = null;
                    if (kind === 'audio' && room.audioProducer?.id === producer.id) room.audioProducer = null;
                    emitHostMetrics(io, room.code);
                });

                console.log(`Host producing ${kind} in room ${room.code} (producer ${producer.id})`);
                emitHostMetrics(io, room.code);
                safeCallback(callback, { success: true, producerId: producer.id });
            } catch (err) {
                console.error('produce error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('consume', async ({ producerId, rtpCapabilities } = {}, callback) => {
            try {
                if (!isValidProducerId(producerId) || !rtpCapabilities) {
                    runtimeMetrics.consumeDenied += 1;
                    safeCallback(callback, { success: false, error: 'Invalid parameters.' });
                    return;
                }

                const room = findRoomBySocket(socket.id);
                if (!room) {
                    runtimeMetrics.consumeDenied += 1;
                    safeCallback(callback, { success: false, error: 'Not in a room.' });
                    return;
                }

                const roomProducerIds = new Set(
                    [room.producer?.id, room.audioProducer?.id].filter(Boolean)
                );
                if (!roomProducerIds.has(producerId)) {
                    runtimeMetrics.consumeDenied += 1;
                    safeCallback(callback, { success: false, error: 'Producer is not available in this room.' });
                    return;
                }

                if (!router.canConsume({ producerId, rtpCapabilities })) {
                    runtimeMetrics.consumeDenied += 1;
                    safeCallback(callback, { success: false, error: 'Cannot consume this producer.' });
                    return;
                }

                const viewerData = room.viewerTransports.get(socket.id);
                if (!viewerData || !viewerData.recvTransport) {
                    runtimeMetrics.consumeDenied += 1;
                    safeCallback(callback, { success: false, error: 'No recv transport.' });
                    return;
                }

                const consumer = await viewerData.recvTransport.consume({
                    producerId,
                    rtpCapabilities,
                    paused: true,
                });
                await applyConsumerPriority(consumer);
                runtimeMetrics.consumesCreated += 1;
                activeConsumerIds.add(consumer.id);

                viewerData.consumers.push(consumer);
                consumer.on('transportclose', () => {
                    removeConsumerFromViewer(viewerData, consumer.id);
                    activeConsumerIds.delete(consumer.id);
                    console.log(`Consumer ${consumer.id} transport closed`);
                    emitHostMetrics(io, room.code);
                });
                consumer.on('producerclose', () => {
                    removeConsumerFromViewer(viewerData, consumer.id);
                    activeConsumerIds.delete(consumer.id);
                    console.log(`Consumer ${consumer.id} producer closed`);
                    socket.emit('producer-closed', { consumerId: consumer.id });
                    emitHostMetrics(io, room.code);
                });
                consumer.on('close', () => {
                    removeConsumerFromViewer(viewerData, consumer.id);
                    activeConsumerIds.delete(consumer.id);
                    emitHostMetrics(io, room.code);
                });

                safeCallback(callback, {
                    success: true,
                    params: {
                        id: consumer.id,
                        producerId: consumer.producerId,
                        kind: consumer.kind,
                        rtpParameters: consumer.rtpParameters,
                    },
                });
                emitHostMetrics(io, room.code);
            } catch (err) {
                console.error('consume error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('consumer-resume', async ({ consumerId } = {}, callback) => {
            try {
                if (!isValidConsumerId(consumerId)) {
                    safeCallback(callback, { success: false, error: 'Invalid consumer ID.' });
                    return;
                }

                const room = findRoomBySocket(socket.id);
                if (!room) {
                    safeCallback(callback, { success: false, error: 'Not in a room.' });
                    return;
                }

                const viewerData = room.viewerTransports.get(socket.id);
                if (!viewerData) {
                    safeCallback(callback, { success: false, error: 'No viewer data.' });
                    return;
                }

                const consumer = viewerData.consumers.find((c) => c.id === consumerId);
                if (!consumer) {
                    safeCallback(callback, { success: false, error: 'Consumer not found.' });
                    return;
                }

                await consumer.resume();
                runtimeMetrics.consumerResumeCalls += 1;
                safeCallback(callback, { success: true });
            } catch (err) {
                console.error('consumer-resume error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('set-consumer-layers', async ({ consumerId, spatialLayer, temporalLayer } = {}, callback) => {
            try {
                if (!isValidConsumerId(consumerId)) {
                    safeCallback(callback, { success: false, error: 'Invalid consumer ID.' });
                    return;
                }

                const room = findRoomBySocket(socket.id);
                if (!room) {
                    safeCallback(callback, { success: false, error: 'Not in a room.' });
                    return;
                }

                const viewerData = room.viewerTransports.get(socket.id);
                if (!viewerData) {
                    safeCallback(callback, { success: false, error: 'No viewer data.' });
                    return;
                }

                const consumer = viewerData.consumers.find((c) => c.id === consumerId);
                if (!consumer) {
                    safeCallback(callback, { success: false, error: 'Consumer not found.' });
                    return;
                }

                if (consumer.kind !== 'video') {
                    safeCallback(callback, { success: false, error: 'Layer control is only available for video.' });
                    return;
                }

                const layers = {};
                if (Number.isInteger(spatialLayer) && spatialLayer >= 0 && spatialLayer <= 2) {
                    layers.spatialLayer = spatialLayer;
                }
                if (Number.isInteger(temporalLayer) && temporalLayer >= 0 && temporalLayer <= 2) {
                    layers.temporalLayer = temporalLayer;
                }

                if (!Object.keys(layers).length) {
                    safeCallback(callback, { success: false, error: 'No valid layer values provided.' });
                    return;
                }

                await consumer.setPreferredLayers(layers);
                safeCallback(callback, { success: true });
            } catch (err) {
                console.error('set-consumer-layers error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('relay-consume-start', (data, callback) => {
            try {
                const room = findRoomBySocket(socket.id);
                if (!room) {
                    safeCallback(callback, { success: false, error: 'Not in a room.' });
                    return;
                }

                if (room.hostSocketId === socket.id) {
                    safeCallback(callback, { success: false, error: 'Host cannot consume relay.' });
                    return;
                }

                runtimeMetrics.relayStartRequests += 1;
                setViewerRelayMode(io, room, socket.id, true);
                emitHostMetrics(io, room.code);
                safeCallback(callback, {
                    success: true,
                    relayViewerCount: room.relayViewers.size,
                    initAvailable: !!room.mediaInit,
                });
            } catch (err) {
                console.error('relay-consume-start error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('relay-consume-stop', (data, callback) => {
            try {
                const room = findRoomBySocket(socket.id);
                if (!room) {
                    safeCallback(callback, { success: true });
                    return;
                }

                runtimeMetrics.relayStopRequests += 1;
                setViewerRelayMode(io, room, socket.id, false);
                emitHostMetrics(io, room.code);
                safeCallback(callback, {
                    success: true,
                    relayViewerCount: room.relayViewers.size,
                });
            } catch (err) {
                console.error('relay-consume-stop error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        // ── OBS Fallback viewer events ──
        socket.on('fallback-consume-start', async (data, callback) => {
            const room = findRoomBySocket(socket.id);
            if (!room || room.ingestMode !== 'obs') {
                return safeCallback(callback, { error: 'Not an OBS room' });
            }

            room.fallbackViewers.add(socket.id);
            room.fallbackViewerCount = room.fallbackViewers.size;

            // Start relay on first demand
            if (!room.fallbackWorker && room.whipConnected) {
                await startFallbackRelay(room, router, io);
            }

            safeCallback(callback, { ok: true, fallbackAvailable: room.fallbackAvailable });
        });

        socket.on('fallback-consume-stop', () => {
            const room = findRoomBySocket(socket.id);
            if (!room) return;

            room.fallbackViewers.delete(socket.id);
            room.fallbackViewerCount = room.fallbackViewers.size;

            // Stop relay when no more fallback viewers
            if (room.fallbackViewers.size === 0 && room.fallbackWorker) {
                stopFallbackRelay(room);
            }
        });

        // SECURITY: remote media toggle only sends a single media play/pause key.
        socket.on('toggle_media', async (data, callback) => {
            try {
                runtimeMetrics.toggleRequests += 1;
                const room = findRoomBySocket(socket.id);
                if (!room) {
                    runtimeMetrics.toggleDenied += 1;
                    safeCallback(callback, { success: false, message: 'Not in a room.' });
                    return;
                }

                if (room.hostSocketId === socket.id) {
                    runtimeMetrics.toggleDenied += 1;
                    safeCallback(callback, {
                        success: false,
                        message: 'Host cannot toggle their own media remotely.',
                    });
                    return;
                }

                if (!room.allowMediaControl) {
                    runtimeMetrics.toggleDenied += 1;
                    safeCallback(callback, {
                        success: false,
                        message: 'Host has disabled remote media control.',
                    });
                    return;
                }

                const now = Date.now();
                const lastToggle = lastToggleByRoom.get(room.code) || 0;
                if (now - lastToggle < config.MEDIA_TOGGLE_COOLDOWN_MS) {
                    runtimeMetrics.toggleDenied += 1;
                    safeCallback(callback, { success: false, message: 'Too fast - wait 1 second.' });
                    return;
                }

                const viewerKey = `${room.code}:${socket.id}`;
                const lastViewerToggle = lastToggleByViewer.get(viewerKey) || 0;
                if (now - lastViewerToggle < config.MEDIA_TOGGLE_VIEWER_COOLDOWN_MS) {
                    runtimeMetrics.toggleDenied += 1;
                    safeCallback(callback, {
                        success: false,
                        message: `Too fast - wait ${Math.ceil(config.MEDIA_TOGGLE_VIEWER_COOLDOWN_MS / 1000)} seconds.`,
                    });
                    return;
                }

                lastToggleByRoom.set(room.code, now);
                lastToggleByViewer.set(viewerKey, now);

                await loadNutJs();
                if (keyboard && Key) {
                    await keyboard.pressKey(Key.AudioPlay);
                    await keyboard.releaseKey(Key.AudioPlay);
                } else {
                    await pressMediaPlayPauseFallback();
                }

                safeCallback(callback, { success: true });
            } catch (err) {
                console.error('toggle_media error:', err.message);
                const isPlatformError = err.message.includes('fallback is not supported');
                const isLinuxError = err.message.includes('xdotool');
                
                safeCallback(callback, {
                    success: false,
                    message: isPlatformError
                        ? 'Host OS requires additional dependencies for media control.'
                        : isLinuxError
                            ? 'Linux host needs xdotool installed for media control.'
                            : 'Media control failed. Host may need to run as Administrator.',
                });
            }
        });

        socket.on('media-chunk', (data) => {
            const room = findRoomByHost(socket.id);
            if (!room) return;

            const size = data instanceof Buffer
                ? data.length
                : data instanceof ArrayBuffer
                    ? data.byteLength
                    : data?.byteLength || data?.size || 0;

            if (size <= 0) return;
            if (size > MAX_CHUNK_SIZE) {
                runtimeMetrics.relayChunksDroppedOversized += 1;
                const relayMetric = getOrCreateRoomRelayMetrics(room.code);
                relayMetric.droppedOversized += 1;
                console.warn(`[Nextra] Dropped oversized media chunk (${size} bytes, limit ${MAX_CHUNK_SIZE}).`);
                return;
            }

            // Always capture the first chunk after a media-init — it contains the
            // WebM initialization segment (EBML header + Tracks) needed by new
            // viewers, even if no relay viewers are connected yet (prewarm mode).
            if (!room.initChunk) {
                room.initChunk = data;
            }

            if (room.relayViewers.size === 0) return;
            const relayMetric = getOrCreateRoomRelayMetrics(room.code);

            runtimeMetrics.relayChunksReceived += 1;
            runtimeMetrics.relayBytesReceived += size;
            relayMetric.chunksReceived += 1;
            relayMetric.bytesReceived += size;

            const delivered = emitToRelayViewers(io, room, 'media-chunk', data);
            runtimeMetrics.relayChunksForwarded += delivered;
            runtimeMetrics.relayBytesForwarded += (size * delivered);
            relayMetric.chunksForwarded += delivered;
            relayMetric.bytesForwarded += (size * delivered);
        });

        socket.on('media-init', (data) => {
            const room = findRoomByHost(socket.id);
            if (!room) return;
            if (!data || typeof data.mimeType !== 'string' || data.mimeType.length > 100) return;

            room.mediaInit = { mimeType: data.mimeType };
            room.initChunk = null;
            emitToRelayViewers(io, room, 'media-init', { mimeType: data.mimeType });
        });

        socket.on('get-media-init', (data, callback) => {
            // Handle fMP4 format request (OBS fallback)
            if (data?.format === 'fmp4') {
                const room = findRoomBySocket(socket.id);
                if (!room || !room.fallbackAvailable || !room.fallbackInitSegment) {
                    safeCallback(callback, {
                        success: false,
                        reason: !room ? 'no-room' : !room.fallbackAvailable ? 'fallback-unavailable' : 'fallback-starting',
                    });
                    return;
                }

                const h264Profile = room.fallbackH264Profile || '640032';
                const videoMime = room.fallbackCodec === 'av1' ? 'av01.0.08M.08' : `avc1.${h264Profile}`;
                const audioMime = room.fallbackAudioCodec === 'aac' ? ', mp4a.40.2' : '';

                safeCallback(callback, {
                    success: true,
                    init: {
                        format: 'fmp4',
                        mimeType: `video/mp4; codecs="${videoMime}${audioMime}"`,
                        codec: room.fallbackCodec,
                        audioCodec: room.fallbackAudioCodec,
                        generation: room.fallbackGeneration,
                        tier: 'passthrough',
                    },
                    initSegment: room.fallbackInitSegment,
                });
                return;
            }

            // Existing WebM relay get-media-init handler
            const room = findRoomBySocket(socket.id);
            if (!room || !room.mediaInit) {
                safeCallback(callback, { success: false, error: 'No media init available' });
                return;
            }

            safeCallback(callback, {
                success: true,
                init: room.mediaInit,
                initChunk: room.initChunk,
            });
        });

        socket.on('host-stopped', () => {
            const room = findRoomByHost(socket.id);
            if (!room) return;

            console.log(`Host stopped sharing in room ${room.code}`);
            destroyRoomWithReason(io, room.code, 'Host stopped sharing', false);
        });

        socket.on('heartbeat', () => {
            const room = findRoomBySocket(socket.id);
            if (room) touchRoom(room.code);
        });

        socket.on('leave-room', (data, callback) => {
            try {
                const room = findRoomBySocket(socket.id);
                if (!room) {
                    safeCallback(callback, { success: true });
                    return;
                }

                if (room.hostSocketId === socket.id) {
                    console.log(`Host ${socket.id} left room ${room.code}`);
                    socket.leave(room.code);
                    destroyRoomWithReason(io, room.code, 'Host left room', false);
                    safeCallback(callback, { success: true });
                    return;
                }

                const wasRelayViewer = room.relayViewers.has(socket.id);
                if (wasRelayViewer) {
                    updateRelayAudienceMembership(io, room.code, socket.id, false);
                }
                markViewerTransportForShutdown(room, socket.id);
                const updatedRoom = removeViewer(socket.id);
                if (updatedRoom) {
                    socket.leave(updatedRoom.code);
                    console.log(`Viewer ${socket.id} left room ${updatedRoom.code} (${updatedRoom.viewers.size} viewers)`);
                    io.to(updatedRoom.hostSocketId).emit('viewer-count', { count: updatedRoom.viewers.size });
                    if (wasRelayViewer) {
                        emitRelayDemandChanged(io, updatedRoom);
                    }
                    emitHostMetrics(io, updatedRoom.code);
                }

                safeCallback(callback, { success: true });
            } catch (err) {
                console.error('leave-room error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('disconnect', () => {
            console.log(`Client disconnected: ${socket.id}`);
            runtimeMetrics.activeSockets = Math.max(0, runtimeMetrics.activeSockets - 1);

            const hostRoom = findRoomByHost(socket.id);
            if (hostRoom) {
                const roomCode = hostRoom.code;
                const oldHostSocketId = socket.id;
                console.log(`Host disconnected from room ${roomCode} - waiting for reconnect`);
                emitHostDisconnected(io, roomCode, 'Host connection lost. Attempting reconnect...', true);

                // If OBS room and WHIP was connected, notify fallback viewers
                if (hostRoom.ingestMode === 'obs') {
                    for (const viewerId of hostRoom.fallbackViewers || []) {
                        io.to(viewerId).emit('whip-status', {
                            connected: hostRoom.whipConnected,
                            reconnecting: hostRoom.whipReconnecting,
                        });
                    }
                }

                clearHostReconnectTimer(roomCode);
                const timer = setTimeout(() => {
                    const currentRoom = findRoomByCode(roomCode);
                    if (currentRoom && currentRoom.hostSocketId === oldHostSocketId) {
                        console.log(`Host reconnect timeout for room ${roomCode} - destroying room`);
                        destroyRoomWithReason(io, roomCode, 'Host disconnected', false);
                    }
                    hostReconnectTimers.delete(roomCode);
                }, config.HOST_RECONNECT_GRACE_MS);

                hostReconnectTimers.set(roomCode, timer);
                return;
            }

            const roomBeforeRemoval = findRoomBySocket(socket.id);
            const wasRelayViewer = !!roomBeforeRemoval?.relayViewers?.has(socket.id);
            if (wasRelayViewer) {
                updateRelayAudienceMembership(io, roomBeforeRemoval.code, socket.id, false);
            }
            markViewerTransportForShutdown(roomBeforeRemoval, socket.id);
            // Clean up fallback viewer membership
            if (roomBeforeRemoval?.fallbackViewers) {
                roomBeforeRemoval.fallbackViewers.delete(socket.id);
                roomBeforeRemoval.fallbackViewerCount = roomBeforeRemoval.fallbackViewers.size;
            }
            const room = removeViewer(socket.id);
            if (room) {
                console.log(`Viewer left room ${room.code} (${room.viewers.size} viewers)`);
                io.to(room.hostSocketId).emit('viewer-count', { count: room.viewers.size });
                if (wasRelayViewer) {
                    emitRelayDemandChanged(io, room);
                }
                emitHostMetrics(io, room.code);

                // Stop fallback relay if no more fallback viewers
                if (room.fallbackViewers && room.fallbackViewers.size === 0 && room.fallbackWorker) {
                    stopFallbackRelay(room);
                }
            }
        });
    });
}

function startJoinCleanup() {
    stopJoinCleanup();

    joinCleanupInterval = setInterval(() => {
        const now = Date.now();

        for (const [ip, record] of joinAttempts) {
            if (now > record.resetAt) joinAttempts.delete(ip);
        }

        for (const [code, timestamp] of lastToggleByRoom) {
            if (now - timestamp > config.MEDIA_TOGGLE_COOLDOWN_MS) {
                lastToggleByRoom.delete(code);
            }
        }

        for (const [key, timestamp] of lastToggleByViewer) {
            if (now - timestamp > config.MEDIA_TOGGLE_VIEWER_COOLDOWN_MS) {
                lastToggleByViewer.delete(key);
            }
        }
    }, 300000);

    metricsBroadcastInterval = setInterval(() => {
        if (registerSocketHandlers._ioRef) {
            emitAllHostsMetrics(registerSocketHandlers._ioRef);
        }
    }, config.METRICS_BROADCAST_INTERVAL_MS);
}

function stopJoinCleanup() {
    if (joinCleanupInterval) {
        clearInterval(joinCleanupInterval);
        joinCleanupInterval = null;
    }
    if (metricsBroadcastInterval) {
        clearInterval(metricsBroadcastInterval);
        metricsBroadcastInterval = null;
    }

    for (const timer of hostReconnectTimers.values()) {
        clearTimeout(timer);
    }
    hostReconnectTimers.clear();
    lastToggleByViewer.clear();
}

module.exports = {
    registerSocketHandlers,
    startJoinCleanup,
    stopJoinCleanup,
    getSocketRuntimeMetrics: getRuntimeMetricsSnapshot,
    emitAllHostsMetrics,
    destroyRoomWithReason,
    stopFallbackRelay,
};
