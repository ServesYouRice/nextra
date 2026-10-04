// lib/socket.js - Socket.io signaling handlers for WebRTC + room management
const { execFile } = require('child_process');
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');
const config = require('../config');
const { createWebRtcTransport, getRouterRtpCapabilities } = require('./mediasoup');
const { ROOM_STATE_CODES, createRoomState } = require('./roomState');

/**
 * Estimate the source frame rate from a list of distinct RTP timestamps (90 kHz
 * video clock). Used so the fallback relay can assign correct constant-rate PTS
 * to the depacketized H.264 (wallclock timing is unreliable for a bursty pipe).
 */
function frameRateFromRtpTimestamps(timestamps, clockRate = 90000) {
    if (!Array.isArray(timestamps) || timestamps.length < 3) return 30;
    const deltas = [];
    for (let i = 1; i < timestamps.length; i++) {
        let d = timestamps[i] - timestamps[i - 1];
        if (d < 0) d += 0x100000000; // 32-bit RTP timestamp wrap
        if (d > 0 && d < clockRate) deltas.push(d); // ignore zero/huge gaps
    }
    if (deltas.length === 0) return 30;
    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)];
    const fps = clockRate / median;
    const common = [24, 25, 30, 48, 50, 60, 90, 120];
    let best = 30;
    let bestDiff = Infinity;
    for (const candidate of common) {
        const diff = Math.abs(candidate - fps);
        if (diff < bestDiff) { bestDiff = diff; best = candidate; }
    }
    return best;
}

function initSegmentHasCodec(initSegment, codecTag) {
    if (!initSegment || !codecTag) return false;

    try {
        const buffer = Buffer.isBuffer(initSegment)
            ? initSegment
            : Buffer.from(initSegment.buffer || initSegment);
        return buffer.includes(Buffer.from(codecTag));
    } catch {
        return false;
    }
}

const { FFmpegRelay } = require('./ffmpegRelay');
const { H264Depacketizer } = require('./h264Depacketizer');
const { RtpReorderBuffer } = require('./rtpReorder');
const { RoomMediaPipeline } = require('./roomMediaPipeline');
const { closeWhipSession } = require('./roomLifecycle');
const { profileLevelIdFromInitSegment } = require('./h264Sprop');
const { createMp4RelayStream, decideFragmentDelivery, decideHostCongestion } = require('./relayMp4');
const {
    FLOOR_KBPS,
    OVERLOAD_LAG_SEC,
    createBitrateState,
    easeBitrate,
    estimateDrainKbps,
    isOverloaded,
    lowerBitrate,
    paddingShare,
    pruneSamples: pruneBitrateSamples,
    raiseBitrate,
    resetRaise,
    settleRaise,
    startingKbps,
    trackLag,
    trackPressure,
    trackSkips,
} = require('./relayBitrate');
const {
    normalizeIp,
    getTrustedForwardedClientIp,
} = require('./network');
const {
    prepareRoom,
    commitRoom,
    joinRoom,
    findRoomByHost,
    findRoomByCode,
    reclaimHostRoom,
    findRoomBySocket,
    removeViewer,
    destroyRoom,
    touchRoom,
    getAllRoomStats,
    getRoomStats,
    getRoomCount,
    getActiveRoomProducers,
    refreshRoomIceServers,
    verifyRoomPassphrase,
} = require('./rooms');
const { buildHostRoomMetricsPayload, EMPTY_RELAY_METRICS } = require('./roomMetrics');

const joinAttempts = new Map(); // IP -> { count, resetAt }
const createRoomAttempts = new Map(); // IP -> { count, resetAt }
const pendingRoomCreations = new Map(); // host socket -> capacity reservation
const lastToggleByRoom = new Map(); // roomCode -> timestamp
const lastToggleByViewer = new Map(); // roomCode:socketId -> timestamp
const hostReconnectTimers = new Map(); // roomCode -> timeout
const ignoredTransportIds = new Set();
let joinCleanupInterval = null;
let metricsBroadcastInterval = null;
let activeIo = null;
let activeFallbackPipelines = 0;
// Set by registerSocketHandlers so fallback delivery shares the relay clock and
// backlog probe (tests substitute both). Defaults keep a prewarmed relay working
// before any socket handler is registered.
let activeRelayRuntime = { measureBacklogBytes: (socket) => getSocketBufferedBytes(socket), now: Date.now };
// The last relay bitrate cut: a slow public path stays slow for the next room.
let fallbackBitrateHint = null;
// What one connection through the public link was measured to carry (kbps), or
// null when it has not been measured. Every relay viewer shares that path.
let relayCapacityKbps = config.RELAY_PUBLIC_LINK_KBPS > 0 ? config.RELAY_PUBLIC_LINK_KBPS : null;

const MAX_CHUNK_SIZE = config.MEDIA_MAX_CHUNK_SIZE;
const MAX_RELAY_BOOTSTRAP_BYTES = 24 * 1024 * 1024;
// Relay re-encode bitrate (1440p at 30 fps tier) when the host did not pick one.
const DEFAULT_FALLBACK_VIDEO_KBPS = 14000;
// Most the relay keeps of the source GOP for an instant (re)start.
const MAX_FALLBACK_GOP_BYTES = 32 * 1024 * 1024;
// After a GOP replay, viewers start on the keyframe nearest live. Anything
// earlier is video without its audio, which the player would have to hop over.
const REPLAY_DELIVERY_MARGIN_SEC = 0.25;
// A viewer this far behind for this long is not catching up by itself (the
// stream leaves its connection no headroom): skip it ahead to live.
const FALLBACK_LAG_TOLERANCE_SEC = 0.7;
const FALLBACK_LAG_PATIENCE_MS = 4000;
// With nobody watching for this long, a lowered relay returns to its start rate.
const FALLBACK_IDLE_RESET_MS = 10_000;
// A bitrate change restarts FFmpeg. Done on a keyframe from the source, the new
// process picks up exactly where the old one stops; this is how long a change
// waits for one (OBS sends one every second with Nextra's settings).
const FALLBACK_SWITCH_MAX_WAIT_MS = 1500;
// Framing bytes a queued fragment may add to the measured send queue.
const FALLBACK_QUEUE_SLACK_BYTES = 8 * 1024;
// How many sent-but-unacknowledged fragments are remembered per viewer, and how
// long the quickest delivery seen stands as "this viewer's normal".
const FALLBACK_MAX_UNACKED = 1200;
// A fragment that took this much longer than normal to arrive met a queue.
const FALLBACK_LATE_TRANSIT_MS = 100;
const FALLBACK_TRANSIT_BUCKET_MS = 5 * 60_000;
// A source with keyframes at least this often is waited for after packet loss;
// one with longer GOPs keeps being decoded (artifacts beat a long freeze).
const FALLBACK_WAIT_FOR_KEYFRAME_MAX_GOP_MS = 2500;

const activeConsumerIds = new Set();
const activeProducerIds = new Set();
const roomRelayMetrics = new Map(); // roomCode -> relay counters
const socketEventLoopDelay = monitorEventLoopDelay({ resolution: 50 });
socketEventLoopDelay.enable();

function getEventLoopHealth() {
    return {
        p95: socketEventLoopDelay.percentile(95) / 1e6,
        max: socketEventLoopDelay.max / 1e6,
    };
}

function mediaDebugLog(...args) {
    if (config.MEDIA_DEBUG_LOGS) {
        console.log(...args);
    }
}

const runtimeMetrics = {
    startedAt: Date.now(),
    totalConnections: 0,
    activeSockets: 0,
    roomsCreated: 0,
    createRoomDeniedUnauthorized: 0,
    createRoomDeniedRateLimit: 0,
    createRoomDeniedCapacity: 0,
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

function emitHostDisconnected(io, roomCode, reason, recoverable = false, code = null) {
    const reasonCode = code || (recoverable
        ? ROOM_STATE_CODES.HOST_DISCONNECTED
        : ROOM_STATE_CODES.HOST_STOPPED);
    io.to(roomCode).emit('host-disconnected', createRoomState(reasonCode, reason, recoverable));
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

function isRateLimitedAttempt(tracker, key, maxAttempts, windowMs) {
    const now = Date.now();
    const record = tracker.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > record.resetAt) {
        record.count = 0;
        record.resetAt = now + windowMs;
    }

    record.count += 1;
    tracker.set(key, record);
    return record.count > maxAttempts;
}

function reserveRoomCreation(hostSocketId, replacingRoomCode = null) {
    if (pendingRoomCreations.has(hostSocketId)) {
        return { ok: false, error: 'A room creation request is already in progress.' };
    }
    const consumesCapacity = !replacingRoomCode;
    const pendingCapacity = [...pendingRoomCreations.values()]
        .filter((reservation) => reservation.active && reservation.consumesCapacity)
        .length;
    if (consumesCapacity && getRoomCount() + pendingCapacity >= config.MAX_ACTIVE_ROOMS) {
        return { ok: false, error: 'Server room capacity reached. Try again later.' };
    }
    const reservation = {
        ok: true,
        hostSocketId,
        replacingRoomCode,
        consumesCapacity,
        active: true,
        cancelled: false,
    };
    pendingRoomCreations.set(hostSocketId, reservation);
    return reservation;
}

function releaseRoomCreation(reservation, { cancelled = false } = {}) {
    if (!reservation?.active) return false;
    reservation.active = false;
    reservation.cancelled = reservation.cancelled || cancelled;
    if (pendingRoomCreations.get(reservation.hostSocketId) === reservation) {
        pendingRoomCreations.delete(reservation.hostSocketId);
    }
    return true;
}

function cancelPendingRoomCreation(hostSocketId) {
    return releaseRoomCreation(pendingRoomCreations.get(hostSocketId), { cancelled: true });
}

function getRoomIceServers(room) {
    return refreshRoomIceServers(room);
}

function validateRoomTurnConfig(turnConfig) {
    const normalized = config.normalizeTurnConfig(turnConfig);
    if (!normalized || normalized.urls.length === 0) {
        return { valid: false, error: 'AV1 mode requires at least one TURN URL.' };
    }

    if (normalized.urls.some((url) => !/^turns?:/i.test(url))) {
        return { valid: false, error: 'TURN URLs must start with turn: or turns:.' };
    }

    if (normalized.authType === 'secret') {
        if (!normalized.secret) {
            return { valid: false, error: 'AV1 mode requires a TURN shared secret.' };
        }
        return { valid: true, turnConfig: normalized };
    }

    if (!normalized.username || !normalized.credential) {
        return { valid: false, error: 'AV1 mode requires a TURN username and credential.' };
    }

    return { valid: true, turnConfig: normalized };
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

function getFallbackAudienceRoom(roomCode) {
    return `${roomCode}:fallback`;
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

function updateFallbackAudienceMembership(io, roomCode, viewerSocketId, useFallback) {
    const viewerSocket = io?.sockets?.sockets?.get(viewerSocketId);
    if (!viewerSocket) return;

    const fallbackRoom = getFallbackAudienceRoom(roomCode);
    if (useFallback) {
        viewerSocket.join(fallbackRoom);
    } else {
        viewerSocket.leave(fallbackRoom);
    }
}

function clearRelayAudienceMembership(io, room) {
    if (!room || room.relayViewers.size === 0) return;

    for (const viewerSocketId of room.relayViewers) {
        updateRelayAudienceMembership(io, room.code, viewerSocketId, false);
    }
}

function clearFallbackAudienceMembership(io, room) {
    if (!room || !room.fallbackViewers || room.fallbackViewers.size === 0) return;

    for (const viewerSocketId of room.fallbackViewers) {
        updateFallbackAudienceMembership(io, room.code, viewerSocketId, false);
    }
}

function destroyRoomWithReason(io, roomCode, reason, recoverable = false, code = null) {
    const room = findRoomByCode(roomCode);
    if (!room) return false;

    if (reason) {
        emitHostDisconnected(io, roomCode, reason, recoverable, code);
    }
    clearRelayAudienceMembership(io, room);
    clearFallbackAudienceMembership(io, room);
    markRoomTransportsForShutdown(room);
    stopFallbackRelay(room);
    closeWhipSession(room);
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
            activeFallbackPipelines,
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

function emitHostMetricsSummary(io, summary) {
    if (!io || !summary) return;
    const fullRoom = findRoomByCode(summary.code);
    io.to(summary.hostSocketId).emit('room-metrics', buildHostRoomMetricsPayload({
        summary,
        room: fullRoom,
        relayMetrics: roomRelayMetrics.get(summary.code),
        eventLoopDelayMs: getEventLoopHealth(),
        includeFallbackGeneration: true,
        runtime: {
            activeConsumers: activeConsumerIds.size,
            activeProducers: activeProducerIds.size,
            totalConnections: runtimeMetrics.totalConnections,
            activeSockets: runtimeMetrics.activeSockets,
        },
    }));
}

function emitHostMetrics(io, roomCode) {
    if (!io || !roomCode) return;
    emitHostMetricsSummary(io, getRoomStats(roomCode));
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

    let delivered = 0;
    rooms.forEach((room) => {
        if (!io?.sockets?.sockets?.has(room.hostSocketId)) return;
        emitHostMetricsSummary(io, room);
        delivered += 1;
    });
    return delivered;
}

function emitRelayDemandChanged(io, room) {
    if (!room) return;
    io.to(room.hostSocketId).emit('relay-demand-changed', { count: room.relayViewers.size });
}

// Per-generation MP4 relay state. The congestion rate limit deliberately
// survives a new generation: the host restarts its recorder in answer to a
// congestion signal, and viewers need time to catch up before the next step.
function resetMp4Relay(room, { keepCongestion = false } = {}) {
    room.relayMp4 = null;
    room.relayGop = [];
    room.relayGopBytes = 0;
    room.relayIngestBps = 0;
    room.relayLastFragmentAt = 0;
    room.relayDelivery = new Map();
    if (!keepCongestion || !room.relayCongestion) {
        room.relayCongestion = { since: 0, lastSignalAt: 0 };
    } else {
        room.relayCongestion.since = 0;
    }
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
        if (room.relayViewers.size === 0) {
            room.mediaInit = null;
            room.mediaGeneration = null;
            room.initChunk = null;
            room.mediaBootstrapChunks = [];
            room.mediaBootstrapBytes = 0;
            room.mediaBootstrapComplete = true;
        }
        room.relayViewers.add(viewerSocketId);
    } else {
        room.relayViewers.delete(viewerSocketId);
        room.relayDelivery?.delete(viewerSocketId);
    }
    updateRelayAudienceMembership(io, room.code, viewerSocketId, useRelay);

    if (room.relayViewers.size === 0) {
        room.mediaInit = null;
        room.mediaGeneration = null;
        room.initChunk = null;
        room.mediaBootstrapChunks = [];
        room.mediaBootstrapBytes = 0;
        room.mediaBootstrapComplete = true;
        resetMp4Relay(room);
    }

    emitRelayDemandChanged(io, room);
    return true;
}

/**
 * Bytes currently queued in a socket's engine.io write buffer (packets not yet
 * flushed to the transport). Socket.IO has no per-socket send-buffer limit, so
 * a slow consumer of a high-bitrate stream would otherwise grow server memory
 * without bound.
 */
let warnedMissingEngineWriteBuffer = false;

function getSocketBufferedBytes(socket) {
    const writeBuffer = socket?.conn?.writeBuffer;
    if (!Array.isArray(writeBuffer)) {
        if (!warnedMissingEngineWriteBuffer) {
            warnedMissingEngineWriteBuffer = true;
            console.warn('[Nextra] Engine.IO writeBuffer is unavailable; relay slow-consumer protection cannot inspect queued bytes. Check Socket.IO/Engine.IO compatibility.');
        }
        return 0;
    }
    let total = 0;
    for (const packet of writeBuffer) {
        const data = packet?.data;
        if (typeof data === 'string') total += data.length;
        else if (data?.byteLength) total += data.byteLength;
        else if (data?.length) total += data.length;
    }
    // Engine.IO only holds packets while a send is in flight; everything already
    // handed to the WebSocket library is counted by ws itself.
    const wsBufferedAmount = socket?.conn?.transport?.socket?.bufferedAmount;
    if (Number.isFinite(wsBufferedAmount)) total += wsBufferedAmount;
    return total;
}

// A later relay viewer replays the active generation: for MP4 the init segment
// plus the GOP in progress, for WebM every chunk since the generation began.
function buildRelayBootstrap(room) {
    if (room.relayViewers.size <= 1) return [];
    const chunks = room.relayMp4
        ? (room.initChunk ? [room.initChunk, ...room.relayGop] : [])
        : (room.mediaBootstrapChunks || []);
    return chunks.length ? [Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))] : [];
}

function dropSlowRelayViewer(io, room, viewerSocket) {
    console.warn(`[Nextra] Relay viewer ${viewerSocket.id} in room ${room.code} exceeded the send-buffer cap — dropping from relay audience.`);
    setViewerRelayMode(io, room, viewerSocket.id, false);
    viewerSocket.emit('transport-failed', createRoomState(
        ROOM_STATE_CODES.RELAY_BACKPRESSURE,
        'Relay connection is too slow. Reconnecting...',
        true
    ));
}

/**
 * Sends one MP4 relay unit (init segment or whole fragment) to each relay
 * viewer. A viewer more than ~1.5 s behind skips fragments until a keyframe
 * fragment arrives with its queue drained, so it catches up without affecting
 * the others; the init segment is never skipped. When every relay viewer is
 * skipping, the host uplink is the bottleneck and the host is asked to lower
 * the relay bitrate.
 */
function deliverMp4RelayUnit(io, room, generation, unit, relayRuntime) {
    if (room.relayViewers.size === 0) return 0;
    const now = relayRuntime.now();
    const bytesPerSecond = Math.max(room.relayIngestBps || 0, 250_000) / 8;
    let delivered = 0;
    let skippingCount = 0;

    for (const viewerSocketId of [...room.relayViewers]) {
        const viewerSocket = io?.sockets?.sockets?.get(viewerSocketId);
        if (!viewerSocket) continue;
        const backlogBytes = relayRuntime.measureBacklogBytes(viewerSocket);
        if (backlogBytes > config.RELAY_SOCKET_MAX_BUFFERED_BYTES) {
            dropSlowRelayViewer(io, room, viewerSocket);
            continue;
        }

        let send = true;
        if (!unit.init) {
            let state = room.relayDelivery.get(viewerSocketId);
            if (!state) {
                state = { skipping: false, skippingSince: 0 };
                room.relayDelivery.set(viewerSocketId, state);
            }
            const decision = decideFragmentDelivery(state, {
                backlogSec: backlogBytes / bytesPerSecond,
                keyframe: unit.keyframe,
                now,
            });
            if (decision.giveUp) {
                dropSlowRelayViewer(io, room, viewerSocket);
                continue;
            }
            send = decision.send;
            if (state.skipping) skippingCount += 1;
        }

        if (send) {
            viewerSocket.emit('media-chunk', { generation, chunk: unit.data });
            delivered += 1;
        }
    }

    if (!unit.init && decideHostCongestion(room.relayCongestion, {
        viewerCount: room.relayViewers.size,
        skippingCount,
        now,
    })) {
        io.to(room.hostSocketId).emit('relay-congestion', { relayViewerCount: room.relayViewers.size });
    }
    return delivered;
}

function emitToRelayViewers(io, room, event, payload) {
    if (!room || room.relayViewers.size === 0) return 0;

    let delivered = 0;
    for (const viewerSocketId of [...room.relayViewers]) {
        const viewerSocket = io?.sockets?.sockets?.get(viewerSocketId);
        if (!viewerSocket) continue;

        // WebM relay chunks are a continuous byte stream — once a viewer falls
        // this far behind, dropping chunks would corrupt their stream anyway.
        // Kick them from the relay audience; the client's transport-failed
        // recovery path rejoins, which restarts the recorder for a fresh init.
        if (getSocketBufferedBytes(viewerSocket) > config.RELAY_SOCKET_MAX_BUFFERED_BYTES) {
            dropSlowRelayViewer(io, room, viewerSocket);
            continue;
        }

        viewerSocket.emit(event, payload);
        delivered += 1;
    }
    return delivered;
}

/**
 * Emit an fMP4 fallback event per-viewer, skipping viewers whose send buffer is
 * over the cap. Unlike WebM chunks, fMP4 fragments are self-contained GOPs with
 * sequence numbers — the player tolerates gaps and seeks back to the live edge.
 */
// The relay can be prewarmed before (or without) a Socket.IO handle, and these
// emits run inside the FFmpeg stdout parser callback: an unguarded `io.to()`
// there surfaces as a pipeline error and strands viewers on "buffering".
function emitToFallbackAudience(io, roomCode, event, payload) {
    if (!io) return false;
    io.to(getFallbackAudienceRoom(roomCode)).emit(event, payload);
    return true;
}

function parseKbps(value) {
    const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(String(value || '').trim());
    if (!match) return 0;
    const unit = match[2].toLowerCase();
    return Math.round(Number(match[1]) * (unit === 'm' ? 1000 : unit === 'k' ? 1 : 0.001));
}

function createFallbackViewerState(previous) {
    return {
        started: false,
        skipping: false,
        skippingSince: 0,
        sentBytes: 0,
        samples: [],
        skips: [],
        queued: [],
        // Fragments sent and not yet acknowledged by the viewer's player.
        unacked: [],
        // What is known about the path to this viewer outlives an encoder restart.
        acking: previous?.acking === true,
        transitMinMs: previous?.transitMinMs ?? null,
        transitPreviousMinMs: previous?.transitPreviousMinMs ?? null,
        transitBucketAt: previous?.transitBucketAt ?? 0,
    };
}

function resetFallbackDelivery(room, { keepCongestion = false } = {}) {
    const previous = room.fallbackDelivery;
    room.fallbackDelivery = new Map();
    if (previous) {
        for (const [viewerSocketId, state] of previous) {
            room.fallbackDelivery.set(viewerSocketId, createFallbackViewerState(state));
        }
    }
    if (!keepCongestion || !room.fallbackCongestion) {
        room.fallbackCongestion = { since: 0, lastSignalAt: 0 };
    } else {
        room.fallbackCongestion.since = 0;
    }
}

/**
 * Best estimate of what the connections of the viewers that are behind can
 * carry: the fastest drain rate seen among them (they all share the host
 * uplink, and one slow viewer must not set the quality for the rest).
 */
function measureFallbackGoodputKbps(room, now) {
    let best = null;
    for (const state of room.fallbackDelivery.values()) {
        const kbps = estimateDrainKbps(state.samples, now);
        if (kbps !== null && (best === null || kbps > best)) best = kbps;
    }
    return best;
}

/**
 * Whether the OBS stream can go to relay viewers as it is, with no second
 * encode. It has to be what a viewer needs already: keyframes close together (a
 * viewer can only start on one) and no B-frames. That holds when OBS runs on the
 * encoder settings Nextra wrote for it and the stream shows them in effect.
 */
function canPassSourceThrough(room) {
    const source = room.fallbackSource;
    return room.obsEncoderSettingsApplied === true && !!source
        && source.keyframeIntervalMs > 0 && source.keyframeIntervalMs <= FALLBACK_WAIT_FOR_KEYFRAME_MAX_GOP_MS;
}

/** At its full bitrate the relay passes the source through, if the source allows it. */
function wantsSourceCopy(room) {
    const bitrate = room.fallbackBitrate;
    return !!bitrate && bitrate.currentKbps >= bitrate.targetKbps && canPassSourceThrough(room);
}

function applyFallbackBitrate(io, room, relay, kbps, reason, runtime) {
    const { targetKbps } = room.fallbackBitrate;
    fallbackBitrateHint = kbps < targetKbps ? { kbps, at: runtime.now() } : null;
    console.warn(`[Fallback] ${reason}: relay video bitrate for room ${room.code} is now ${kbps}kbps (target ${targetKbps}kbps)`);
    emitHostMetrics(io, room.code);
    // Carried out by switchFallbackBitrate on the source's next keyframe.
    room.fallbackPendingBitrate = { kbps, copy: wantsSourceCopy(room), deadline: runtime.now() + FALLBACK_SWITCH_MAX_WAIT_MS };
}

// What the link is tested with before a bitrate step up: random, so that nothing
// on the way can compress it. The player has no handler for it.
const RELAY_FILLER = crypto.randomBytes(256 * 1024);

/**
 * A viewer's player reports a fragment it has received. Timed against when that
 * fragment was sent, this shows how long the stream really takes to arrive. The
 * socket's own send queue shows only part of that: most of a backlog sits in
 * buffers this process cannot see (the operating system's, the tunnel's).
 */
function recordFallbackAck(room, socketId, data, now) {
    const state = room?.fallbackDelivery?.get(socketId);
    if (!state || !data || data.generation !== room.fallbackGeneration || !Number.isInteger(data.sequence)) return;
    let arrived = null;
    while (state.unacked.length > 0 && state.unacked[0].sequence <= data.sequence) {
        arrived = state.unacked.shift();
    }
    if (arrived === null) return;
    const transitMs = now - arrived.at;
    if (!state.acking) {
        // From here on the samples are what the viewer received, not what left
        // this process: the two cannot be mixed.
        state.acking = true;
        state.samples = [];
    }
    // The quickest delivery over the last five to ten minutes is this viewer's
    // normal; anything beyond it is waiting somewhere.
    if (state.transitMinMs === null || now - state.transitBucketAt > FALLBACK_TRANSIT_BUCKET_MS) {
        state.transitPreviousMinMs = state.transitMinMs;
        state.transitMinMs = transitMs;
        state.transitBucketAt = now;
    } else if (transitMs < state.transitMinMs) {
        state.transitMinMs = transitMs;
    }
    // What the viewer has received by now. While fragments arrive late the link
    // is carrying all it can, so the rate these grow at is what it carries.
    const normalMs = Math.min(state.transitMinMs, state.transitPreviousMinMs ?? Infinity);
    const late = transitMs - normalMs > FALLBACK_LATE_TRANSIT_MS;
    state.samples.push({ at: now, drained: arrived.end, backlog: late ? state.sentBytes - arrived.end + 1 : 0 });
}

/** How far behind an acknowledging viewer is: the wait of its oldest unacknowledged fragment beyond its normal. */
function fallbackAckLagSec(state, now) {
    if (!state.acking || state.unacked.length === 0) return 0;
    const normalMs = Math.min(state.transitMinMs, state.transitPreviousMinMs ?? Infinity);
    return Math.max(0, (now - state.unacked[0].at - normalMs) / 1000);
}

/** Restart the relay at the bitrate that is waiting, if one is. */
function switchFallbackBitrate(room, relay) {
    const pending = room.fallbackPendingBitrate;
    if (!pending) return false;
    room.fallbackPendingBitrate = null;
    relay.reconfigure(pending.kbps, { copy: pending.copy === true }).catch((err) => {
        room.fallbackLastError = err.message;
        console.error(`[Fallback] Failed to restart relay at ${pending.kbps}kbps for room ${room.code}:`, err);
    });
    return true;
}

/**
 * Sends one fMP4 fragment to each OBS-relay viewer. A fragment is a few frames;
 * one in every second starts on a keyframe. A viewer who stays behind skips to
 * the next keyframe fragment once its queue has drained, instead of falling
 * further behind. When every viewer keeps skipping, the encode bitrate is more
 * than the connection carries and is lowered; when every viewer has kept up for
 * a while, a step back up is tried (see lib/relayBitrate.js).
 */
function deliverFallbackFragment(io, room, relay, payload, runtime = activeRelayRuntime) {
    if (!room.fallbackDelivery) resetFallbackDelivery(room);
    const now = runtime.now();
    // The source turned out fit to pass through (it takes two keyframes to
    // tell), or stopped being so, with the bitrate where it was.
    if (!room.fallbackPendingBitrate && room.fallbackBitrate && (relay.videoCopy === true) !== wantsSourceCopy(room)) {
        room.fallbackPendingBitrate = {
            kbps: room.fallbackBitrate.currentKbps,
            copy: wantsSourceCopy(room),
            deadline: now + FALLBACK_SWITCH_MAX_WAIT_MS,
        };
    }
    // A source that sends keyframes far apart cannot hold a bitrate change up.
    if (room.fallbackPendingBitrate && now >= room.fallbackPendingBitrate.deadline) switchFallbackBitrate(room, relay);

    let viewerCount = 0;
    let strugglingCount = 0;
    // How far behind the viewers that are furthest and least behind are.
    let worstLagSec = -1;
    let leastLagSec = Number.POSITIVE_INFINITY;
    const fillerBytes = Math.min(RELAY_FILLER.length, Math.round(payload.chunk.length * paddingShare(room.fallbackBitrate)));
    for (const viewerSocketId of room.fallbackViewers) {
        const viewerSocket = io?.sockets?.sockets?.get(viewerSocketId);
        if (!viewerSocket) continue;
        viewerCount += 1;

        let state = room.fallbackDelivery.get(viewerSocketId);
        if (!state) {
            state = createFallbackViewerState();
            room.fallbackDelivery.set(viewerSocketId, state);
        }
        const backlogBytes = runtime.measureBacklogBytes(viewerSocket);
        const drained = state.sentBytes - backlogBytes;
        // An acknowledging viewer's samples come from its acknowledgements.
        if (!state.acking) state.samples.push({ at: now, drained, backlog: backlogBytes });
        pruneBitrateSamples(state.samples, now);
        // How far behind this viewer is, in time: how long its oldest fragment
        // has been on the way, by the player's acknowledgements and by what is
        // still in the send queue here. (Bytes say little: a keyframe fragment
        // is many times the size of a still one.)
        while (state.queued.length > 0 && state.queued[0].end <= drained + FALLBACK_QUEUE_SLACK_BYTES) state.queued.shift();
        const queueAgeSec = state.queued.length > 0 ? (now - state.queued[0].at) / 1000 : 0;
        const behindSec = Math.max(queueAgeSec, fallbackAckLagSec(state, now));
        if (!state.started) {
            // A viewer can only begin on a keyframe. Waiting for one is not
            // falling behind.
            if (!payload.keyframeStart || backlogBytes > config.RELAY_SOCKET_MAX_BUFFERED_BYTES) continue;
            state.started = true;
        }
        // Without acknowledgements most of a backlog is invisible, and that is
        // no basis for sending more.
        worstLagSec = Math.max(worstLagSec, state.acking ? behindSec : Number.POSITIVE_INFINITY);
        leastLagSec = Math.min(leastLagSec, behindSec);

        if (behindSec <= FALLBACK_LAG_TOLERANCE_SEC) {
            state.behindSince = 0;
        } else if (!state.behindSince) {
            state.behindSince = now;
        } else if (!state.skipping && now - state.behindSince >= FALLBACK_LAG_PATIENCE_MS) {
            state.skipping = true;
            state.skippingSince = now;
            state.behindSince = 0;
        }
        const decision = decideFragmentDelivery(state, {
            backlogSec: behindSec,
            keyframe: payload.keyframeStart === true,
            now,
        });
        const send = decision.send && backlogBytes <= config.RELAY_SOCKET_MAX_BUFFERED_BYTES;
        if (trackSkips(state.skips, { skipped: !send, now })) strugglingCount += 1;
        if (!send) continue;
        viewerSocket.emit('media-chunk', payload);
        state.sentBytes += payload.chunk.length;
        state.queued.push({ end: state.sentBytes, at: now });
        state.unacked.push({ sequence: payload.sequence, at: now, end: state.sentBytes });
        if (state.unacked.length > FALLBACK_MAX_UNACKED) state.unacked.shift();
        if (fillerBytes > 0) {
            viewerSocket.emit('relay-filler', RELAY_FILLER.subarray(0, fillerBytes));
            state.sentBytes += fillerBytes;
        }
    }

    if (viewerCount === 0) {
        // A relay that was lowered for viewers who have since left goes back to
        // its starting rate while the restart costs nobody anything.
        if (!room.fallbackIdleSince) room.fallbackIdleSince = now;
        if (now - room.fallbackIdleSince < FALLBACK_IDLE_RESET_MS) return;
        room.fallbackIdleSince = now;
        const bitrate = room.fallbackBitrate;
        resetRaise(bitrate);
        const startKbps = startingKbps(bitrate.targetKbps, { hint: fallbackBitrateHint, capacityKbps: relayCapacityKbps, audioKbps: bitrate.audioKbps, now });
        if (startKbps > bitrate.currentKbps) {
            bitrate.currentKbps = startKbps;
            applyFallbackBitrate(io, room, relay, startKbps, 'No relay viewers', runtime);
        }
        return;
    }
    room.fallbackIdleSince = 0;
    const bitrate = room.fallbackBitrate;
    if (worstLagSec >= 0) {
        trackLag(bitrate, { lagSec: worstLagSec, now });
        trackPressure(bitrate, { lagSec: leastLagSec, now });
    }
    const takenBack = settleRaise(bitrate, { now });
    if (takenBack !== null) {
        applyFallbackBitrate(io, room, relay, takenBack, 'Relay viewers started to lag at the higher bitrate', runtime);
        return;
    }
    const congested = decideHostCongestion(room.fallbackCongestion, { viewerCount, skippingCount: strugglingCount, now });
    let goodputKbps = congested ? measureFallbackGoodputKbps(room, now) : null;
    let overloaded = false;
    if (!congested && leastLagSec >= OVERLOAD_LAG_SEC) {
        goodputKbps = measureFallbackGoodputKbps(room, now);
        overloaded = isOverloaded(bitrate, { leastLagSec, goodputKbps, now });
        // This cut stands in for the one skipping viewers would bring later.
        if (overloaded) room.fallbackCongestion.lastSignalAt = now;
    }
    if (congested || overloaded) {
        const next = lowerBitrate(bitrate, { now, goodputKbps });
        if (next !== null) {
            const measured = goodputKbps === null ? 'not measured' : `measured ${Math.round(goodputKbps)}kbps`;
            applyFallbackBitrate(io, room, relay, next, `Every relay viewer is falling behind (${measured})`, runtime);
        }
        return;
    }
    // Viewers who are skipping are about to get the larger cut above.
    const eased = strugglingCount < viewerCount ? easeBitrate(bitrate, { now }) : null;
    if (eased !== null) {
        applyFallbackBitrate(io, room, relay, eased, 'Relay viewers cannot quite keep up', runtime);
        return;
    }
    const raised = raiseBitrate(bitrate, { now });
    if (raised !== null) applyFallbackBitrate(io, room, relay, raised, 'The link carried more than the relay was sending', runtime);
}

function createSourceStats() {
    return { frames: 0, keyframes: 0, keyframeIntervalMs: 0, bitrateKbps: 0, lastKeyframeTimestamp: null, windowStartedAt: 0, windowBytes: 0 };
}

/**
 * Tracks what OBS is actually sending: its bitrate and how far apart its
 * keyframes are. OBS ignores keyframe requests, so a long interval is how long a
 * new WebRTC viewer waits for a picture.
 */
function observeSourceFrame(source, frame, now) {
    source.frames += 1;
    source.windowBytes += frame.data.length;
    if (!source.windowStartedAt) {
        source.windowStartedAt = now;
    } else if (now - source.windowStartedAt >= 2000) {
        source.bitrateKbps = Math.round((source.windowBytes * 8) / (now - source.windowStartedAt));
        source.windowStartedAt = now;
        source.windowBytes = 0;
    }
    if (!frame.keyframe) return;
    if (source.lastKeyframeTimestamp !== null) {
        const ticks = (frame.timestamp - source.lastKeyframeTimestamp) | 0;
        if (ticks > 0) source.keyframeIntervalMs = Math.round(ticks / 90);
    }
    source.lastKeyframeTimestamp = frame.timestamp;
    source.keyframes += 1;
}

/** Record what one connection through the public link carries (kbps), or null. */
function setRelayCapacityKbps(kbps) {
    relayCapacityKbps = Number.isFinite(kbps) && kbps > 0 ? Math.round(kbps) : null;
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

    const wasRelayViewer = room.relayViewers.has(socket.id);
    const isFallbackViewer = room.fallbackViewers?.has(socket.id);
    if (wasRelayViewer || isFallbackViewer) {
        console.warn(`Viewer transport ${transportId} entered ${kind}:${state} during relay/fallback switch for room ${roomCode}`);

        if (viewerData.consumers) {
            viewerData.consumers.forEach((consumer) => {
                try { consumer.close(); } catch { }
            });
            viewerData.consumers = [];
        }

        markTransportForShutdown(viewerData.recvTransport);
        try { viewerData.recvTransport.close(); } catch { }
        viewerData.recvTransport = null;
        emitHostMetrics(io, room.code);
        return true;
    }

    console.warn(`Viewer transport ${transportId} entered ${kind}:${state} for room ${roomCode}`);
    socket.emit('transport-failed', createRoomState(
        ROOM_STATE_CODES.VIEWER_TRANSPORT_FAILED,
        'Stream connection interrupted. Reconnecting...',
        true
    ));

    if (viewerData.consumers) {
        viewerData.consumers.forEach((consumer) => {
            try { consumer.close(); } catch { }
        });
        viewerData.consumers = [];
    }

    markTransportForShutdown(viewerData.recvTransport);
    try { viewerData.recvTransport.close(); } catch { }
    viewerData.recvTransport = null;
    emitHostMetrics(io, room.code);
    return true;
}

function handleHostTransportFailure(io, socket, roomCode, transportId, kind, state) {
    const room = findRoomByCode(roomCode);
    if (!room || room.hostSocketId !== socket.id || room.hostTransport?.id !== transportId) {
        return false;
    }

    // A document reload closes DTLS before Socket.IO's disconnect/reclaim flow
    // completes. For rooms that explicitly opted into reload recovery, retain
    // ownership until the normal reconnect grace expires; reclaim-host will
    // close and replace these stale browser-media resources.
    if (room.reloadRecoveryEnabled && state === 'closed') {
        console.log(`Host transport ${transportId} closed during recoverable reload window for room ${roomCode}`);
        return true;
    }

    console.warn(`Host transport ${transportId} entered ${kind}:${state} for room ${roomCode}`);
    socket.emit('transport-failed', createRoomState(
        ROOM_STATE_CODES.HOST_MEDIA_FAILED,
        'Host media connection failed. Please start sharing again.'
    ));

    return destroyRoomWithReason(
        io,
        roomCode,
        'Host media connection failed.',
        false,
        ROOM_STATE_CODES.HOST_MEDIA_FAILED
    );
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
 * Creates DirectTransport consumers, spawns FFmpeg, and wires fMP4 events.
 */
async function startFallbackRelay(room, mediasoupRouter, io, dependencies = {}) {
    if (!io) io = activeIo;
    const RelayClass = dependencies.FFmpegRelay || FFmpegRelay;
    // Re-entrancy guard. room.fallbackWorker is only assigned near the END of this
    // function (after createDirectTransport/consume/fps-sample/
    // relay.start — many awaits). Two callers legitimately race here: the WHIP
    // dtls-connected prewarm and a viewer's fallback-consume-start. Without a
    // SYNCHRONOUS claim, both pass the `fallbackWorker` check during that await
    // window and spawn duplicate FFmpeg pipelines + duplicate transports/intervals
    // (the first set gets orphaned and leaks). Claim the slot before any await.
    if (room.fallbackWorker || (room._mediaPipeline && room._mediaPipeline.state !== 'idle')) return;
    if (!room.whipProducer) return; // no OBS media yet
    if (activeFallbackPipelines >= config.MAX_FALLBACK_PIPELINES) {
        room.fallbackLastError = 'Server fallback pipeline capacity reached.';
        return;
    }
    activeFallbackPipelines += 1;
    const pipeline = room._mediaPipeline || new RoomMediaPipeline(room);
    room._mediaPipeline = pipeline;
    const startGeneration = pipeline.beginStart({
        onClose: () => {
            activeFallbackPipelines = Math.max(0, activeFallbackPipelines - 1);
        },
    });
    const ensureCurrentGeneration = () => pipeline.assertCurrent(startGeneration);
    const relayRuntime = dependencies.relayRuntime || activeRelayRuntime;
    const FALLBACK_INIT_TIMEOUT_MS = 10000;

    try {
        // The codec is assigned only after the WHIP producers are created, so in
        // the connect window it can still be null while whipProducer is set.
        // Checked inside the try block so callers (async socket handlers) never
        // see a synchronous throw, which would become an unhandled rejection.
        if (room.obsVideoCodec !== 'h264') {
            throw new Error(`Fallback relay requires H.264 OBS ingest. Current codec: ${room.obsVideoCodec || 'unknown'}`);
        }
        // Video: consume the OBS producer on a DirectTransport so RTP is delivered
        // straight to Node. We depacketize H.264 ourselves, inject SPS/PPS before
        // every keyframe, and hand FFmpeg whole frames with their RTP timestamps.
        // This avoids UDP loss on large keyframes and FFmpeg's RTP/SDP demuxer
        // quirks with OBS ingest (which emits parameter sets only once at start).
        const videoDirect = await mediasoupRouter.createDirectTransport();
        pipeline.own('videoDirect', videoDirect);
        ensureCurrentGeneration();
        const videoConsumer = await videoDirect.consume({
            producerId: room.whipProducer.id,
            rtpCapabilities: mediasoupRouter.rtpCapabilities,
        });
        pipeline.own('videoConsumer', videoConsumer);
        ensureCurrentGeneration();

        const depacketizer = new H264Depacketizer({
            sps: room.fallbackH264Sps || null,
            pps: room.fallbackH264Pps || null,
        });
        // OBS's keyframe bursts lose packets even on loopback; the retransmissions
        // arrive late and have to be put back in order before depacketizing.
        const reorder = new RtpReorderBuffer({ now: relayRuntime.now });
        const source = createSourceStats();
        room.fallbackSource = source;

        // Feeding state. `relayRef` is the relay once it is ready for frames;
        // `feeding` is true from the keyframe a given FFmpeg process starts on.
        let relayRef = null;
        let feeding = false;
        let lastFedTimestamp = 0;
        let fedTicks = 0;
        // True until an intact keyframe arrives: after packet loss, or after
        // FFmpeg dropped input, the frames in between cannot be decoded.
        let awaitingKeyframe = true;
        // Every frame since the latest keyframe. OBS ignores keyframe requests, so
        // a relay that (re)starts mid-GOP would otherwise show nothing until OBS's
        // next keyframe — seconds away with OBS's default settings. Replaying the
        // GOP lets FFmpeg decode straight away.
        let gop = [];
        let gopBytes = 0;
        // Fragments older than this (seconds on the current process's timeline)
        // only exist because the GOP was replayed; viewers must not get them.
        let liveFromSec = 0;
        // When the current process was first fed, and whether its audio still
        // has to be placed on the video timeline.
        let feedStartedAt = 0;
        let audioStartPending = false;
        const frameTimestamps = [];

        const writeFrame = (frame) => {
            fedTicks += (frame.timestamp - lastFedTimestamp) | 0;
            lastFedTimestamp = frame.timestamp;
            relayRef.writeVideoFrame(frame.data, fedTicks);
        };

        const beginFeeding = () => {
            if (feeding || !relayRef || room.fallbackWorker !== relayRef || gop.length === 0) return;
            feeding = true;
            lastFedTimestamp = gop[0].timestamp;
            fedTicks = 0;
            relayRef.beginBurst?.(gopBytes);
            for (const frame of gop) writeFrame(frame);
            // Audio resumes now, so it belongs after the frames just replayed.
            liveFromSec = gop.length > 1 ? (fedTicks / 90000) + (1 / videoFrameRate) : 0;
            feedStartedAt = relayRuntime.now();
            audioStartPending = true;
            resumeAudioConsumer();
            armInitTimer();
        };

        videoConsumer.on('rtp', (packet) => {
            try {
                for (const ordered of reorder.push(packet)) for (const frame of depacketizer.pushFrames(ordered)) {
                    observeSourceFrame(source, frame, relayRuntime.now());
                    source.lostPackets = reorder.lostPackets;
                    if (frameTimestamps.length < 60) frameTimestamps.push(frame.timestamp);
                    // A frame with packets missing breaks every frame after it up
                    // to the next keyframe. With keyframes a second or two apart,
                    // holding the last good picture until then is cleaner; with
                    // OBS's default 250-frame GOP that would freeze for seconds, so
                    // the decoder is left to conceal the damage instead.
                    if (!frame.intact && source.keyframeIntervalMs > 0
                        && source.keyframeIntervalMs <= FALLBACK_WAIT_FOR_KEYFRAME_MAX_GOP_MS) {
                        awaitingKeyframe = true;
                    }
                    if (frame.keyframe && (frame.intact || !awaitingKeyframe)) {
                        awaitingKeyframe = false;
                        gop = [frame];
                        gopBytes = frame.data.length;
                        if (!feeding) {
                            beginFeeding();
                            continue;
                        }
                        // A bitrate change that was waiting for this keyframe:
                        // the new process starts on it (it is the cached GOP).
                        if (relayRef && room.fallbackWorker === relayRef && switchFallbackBitrate(room, relayRef)) continue;
                    } else if (awaitingKeyframe) {
                        gop = [];
                        gopBytes = 0;
                        continue;
                    } else if (gop.length > 0) {
                        gopBytes += frame.data.length;
                        if (gopBytes > MAX_FALLBACK_GOP_BYTES) {
                            // Too long a GOP to keep; a restart then waits for OBS.
                            gop = [];
                            gopBytes = 0;
                        } else {
                            gop.push(frame);
                        }
                    }
                    if (feeding && relayRef && room.fallbackWorker === relayRef) writeFrame(frame);
                }
            } catch (err) {
                mediaDebugLog(`[Fallback] depacketize error for room ${room.code}: ${err.message}`);
            }
        });
        videoConsumer.requestKeyFrame().catch(() => {});

        // Audio: consume RTP directly in Node, wrap Opus packets in Ogg pages, and
        // feed FFmpeg over an inherited pipe. Node retains ownership end-to-end;
        // there is no UDP probe-to-child-bind window.
        let audioDirect = null;
        let audioConsumer = null;
        if (room.whipAudioProducer) {
            audioDirect = await mediasoupRouter.createDirectTransport();
            pipeline.own('audioDirect', audioDirect);
            ensureCurrentGeneration();
            audioConsumer = await audioDirect.consume({
                producerId: room.whipAudioProducer.id,
                rtpCapabilities: mediasoupRouter.rtpCapabilities,
                paused: true,
            });
            pipeline.own('audioConsumer', audioConsumer);
            audioConsumer.on('rtp', (packet) => {
                if (!feeding || !relayRef || room.fallbackWorker !== relayRef) return;
                if (audioStartPending) {
                    // OBS sends audio and video interleaved in decode order, so
                    // this packet is as far into the stream as the time since the
                    // first video frame was fed (plus whatever was replayed).
                    audioStartPending = false;
                    relayRef.setAudioStartSec?.(liveFromSec + Math.max(0, relayRuntime.now() - feedStartedAt) / 1000);
                }
                relayRef.writeAudioRtp(packet);
            });
            ensureCurrentGeneration();
        }

        // The output frame rate. Prefer the host-configured one (accurate and
        // immediate); otherwise measure the source's cadence. Timing no longer
        // depends on it — frames carry their own timestamps — but the encoder's
        // rate control does.
        let videoFrameRate = (Number.isFinite(room.frameRate) && room.frameRate >= 1 && room.frameRate <= 120)
            ? Math.round(room.frameRate)
            : 0;
        if (videoFrameRate) {
            console.log(`[Fallback] Using configured ${videoFrameRate}fps for room ${room.code}`);
        } else {
            await new Promise((resolve) => {
                const startedAt = Date.now();
                const check = setInterval(() => {
                    if (frameTimestamps.length >= 20 || Date.now() - startedAt > 3000) {
                        clearInterval(check);
                        resolve();
                    }
                }, 40);
            });
            videoFrameRate = frameRateFromRtpTimestamps(frameTimestamps);
            console.log(`[Fallback] Detected ${videoFrameRate}fps for room ${room.code} from ${frameTimestamps.length} sampled frames`);
        }

        const targetVideoKbps = (Number.isFinite(room.relayVideoKbps) && room.relayVideoKbps > 0)
            ? room.relayVideoKbps
            : DEFAULT_FALLBACK_VIDEO_KBPS;
        const audioKbps = audioConsumer ? parseKbps(config.FALLBACK_AUDIO_BITRATE) : 0;
        // The bitrate survives FFmpeg restarts within the room, so an adapted
        // relay is not reset to full quality by a crash recovery.
        if (!room.fallbackBitrate || room.fallbackBitrate.targetKbps !== Math.max(FLOOR_KBPS, Math.round(targetVideoKbps))) {
            room.fallbackBitrate = createBitrateState({
                targetKbps: targetVideoKbps,
                startKbps: startingKbps(targetVideoKbps, { hint: fallbackBitrateHint, capacityKbps: relayCapacityKbps, audioKbps, now: relayRuntime.now() }),
                audioKbps,
            });
        }
        resetFallbackDelivery(room);
        const relay = new RelayClass({
            roomCode: room.code,
            videoCodec: room.obsVideoCodec || 'h264',
            hasAudio: !!audioConsumer,
            videoFrameRate,
            videoBitrateKbps: room.fallbackBitrate.currentKbps,
            // Audio and video carry their own timestamps and start on the same
            // instant, so no offset is needed. FALLBACK_AUDIO_OFFSET_MS stays as a
            // fine-tune (default 0): positive plays audio later, negative earlier.
            audioOffsetSec: config.FALLBACK_AUDIO_OFFSET_MS / 1000,
        });
        pipeline.own('relay', relay, (value) => {
            value.stop();
            if (room.fallbackWorker === value) room.fallbackWorker = null;
        });
        room.fallbackWorker = relay;
        ensureCurrentGeneration();
        let recoveringMissingVideoInit = false;
        let audioResumedForGeneration = false;
        let initTimer = null;
        const isCurrentPipeline = () => room._mediaPipeline === pipeline && !pipeline.closed;

        const clearInitTimer = () => {
            if (!initTimer) return;
            pipeline.release('timer:init');
            initTimer = null;
        };

        function resumeAudioConsumer() {
            if (!audioConsumer || audioResumedForGeneration || room.fallbackWorker !== relay) return;
            audioResumedForGeneration = true;
            audioConsumer.resume().catch((err) => {
                audioResumedForGeneration = false;
                console.warn(`[Fallback] Failed to resume audio consumer for room ${room.code}: ${err.message}`);
            });
        }

        // Runs from the moment FFmpeg has a decodable keyframe: by then it has
        // everything it needs, so no init segment means it is stuck.
        function armInitTimer() {
            clearInitTimer();
            initTimer = setTimeout(() => {
                if (room.fallbackWorker !== relay || room.fallbackAvailable) return;
                console.warn(`[Fallback] Init segment timeout for room ${room.code}; restarting relay (frames=${source.frames} fps=${videoFrameRate} depackHasPS=${depacketizer.hasParameterSets})`);
                relay.restart()
                    .catch((err) => {
                        room.fallbackLastError = err.message;
                        console.error(`[Fallback] Failed to restart relay after init timeout for room ${room.code}:`, err);
                    });
            }, FALLBACK_INIT_TIMEOUT_MS);
            pipeline.setTimer('init', initTimer);
        }

        const pauseConsumer = (consumer) => {
            if (!consumer) return;
            consumer.pause().catch(() => {});
        };

        relay.on('spawn', () => {
            if (!isCurrentPipeline()) return;
            // Each FFmpeg process starts its timeline at zero on a keyframe, with
            // audio resuming on that same frame (see beginFeeding).
            feeding = false;
            liveFromSec = 0;
            if (relayRef) {
                // Until this process has produced its init segment there is
                // nothing to hand a viewer (and the init timer watches for it).
                room.fallbackAvailable = false;
                // Sources that honour keyframe requests (browsers; not OBS) answer
                // faster than their GOP.
                if (gop.length === 0) videoConsumer.requestKeyFrame().catch(() => {});
                beginFeeding();
            }
        });

        relay.on('init', (data) => {
            if (!isCurrentPipeline()) return;
            clearInitTimer();
            if (!initSegmentHasCodec(data.initSegment, 'avc1')) {
                if (recoveringMissingVideoInit) return;
                recoveringMissingVideoInit = true;
                room.fallbackAvailable = false;
                room.fallbackInitSegment = null;
                console.warn(`[Fallback] Init segment for room ${room.code} is missing avc1; requesting keyframe and restarting relay`);
                videoConsumer.requestKeyFrame().catch(() => {});
                const recoveryTimer = setTimeout(() => {
                    if (!isCurrentPipeline()) return;
                    relay.restart()
                        .catch((err) => {
                            room.fallbackLastError = err.message;
                            console.error(`[Fallback] Failed to recover video init for room ${room.code}:`, err);
                        })
                        .finally(() => {
                            recoveringMissingVideoInit = false;
                        });
                }, 250);
                pipeline.setTimer('missing-video-recovery', recoveryTimer);
                return;
            }

            recoveringMissingVideoInit = false;
            mediaDebugLog(`[Fallback] Init segment received for room ${room.code}: ${data.initSegment?.length} bytes, viewers: ${room.fallbackViewers.size}`);
            room.fallbackGeneration++;
            room.fallbackInitSegment = data.initSegment;
            room.fallbackAvailable = true;
            // Viewers begin a new generation on its next keyframe, so none of them
            // is behind on it yet. The congestion hold carries over, though: a
            // bitrate change needs time to show before the next one.
            resetFallbackDelivery(room, { keepCongestion: true });

            // Build MIME type from the actual (transcoded) init segment so the codec
            // string matches what the relay produces, not what OBS negotiated.
            const transcodedProfile = profileLevelIdFromInitSegment(data.initSegment);
            if (transcodedProfile) room.fallbackH264Profile = transcodedProfile;
            const h264Profile = room.fallbackH264Profile || '42e01f';
            const videoMime = `avc1.${h264Profile}`;
            const audioMime = room.fallbackAudioCodec === 'aac' ? ', mp4a.40.2' : '';
            const mimeType = `video/mp4; codecs="${videoMime}${audioMime}"`;

            emitToFallbackAudience(io, room.code, 'media-init', {
                format: 'fmp4',
                mimeType,
                codec: room.obsVideoCodec,
                audioCodec: room.fallbackAudioCodec,
                generation: room.fallbackGeneration,
                tier: 'passthrough',
                initSegment: data.initSegment,
            });
        });

        relay.on('fragment', (data) => {
            if (!isCurrentPipeline()) return;
            if (data.sequence <= 3) {
                mediaDebugLog(
                    `[Fallback] Fragment #${data.sequence} for room ${room.code}: ${data.data?.length} bytes (${data.hasVideo ? 'video' : 'audio-only'})`,
                );
            }
            // What FFmpeg makes of a replayed GOP is already in the past.
            if (Number.isFinite(data.videoTimeSec) && data.videoTimeSec < liveFromSec - REPLAY_DELIVERY_MARGIN_SEC) return;

            deliverFallbackFragment(io, room, relay, {
                format: 'fmp4',
                generation: room.fallbackGeneration,
                tier: 'passthrough',
                sequence: data.sequence,
                keyframeStart: data.keyframeStart === true,
                chunk: data.data,
            }, relayRuntime);
        });

        relay.on('error', (err) => {
            if (!isCurrentPipeline()) return;
            console.error(`[Fallback] Error for room ${room.code}:`, err.message);
            room.fallbackLastError = err.message;
            room.fallbackRestartCount = relay.restartCount;
            // If restart cap exceeded, mark fallback unavailable and notify viewers
            if (relay.restartCount >= (require('../config').FALLBACK_RESTART_CAP || 5)) {
                room.fallbackAvailable = false;
                emitToFallbackAudience(io, room.code, 'fallback-error', { reason: 'worker-failed', message: err.message });
            }
        });

        relay.on('exit', () => {
            if (!isCurrentPipeline()) return;
            clearInitTimer();
            feeding = false;
            room.fallbackAvailable = false;
            room.fallbackRestartCount = relay.restartCount;
            audioResumedForGeneration = false;
            // Video keeps arriving across restarts (it fills the GOP cache); audio
            // is paused until the next process starts on its keyframe.
            pauseConsumer(audioConsumer);
        });

        // FFmpeg's stdin backed up and frames were dropped: nothing after them can
        // be decoded until the next keyframe, and the cached GOP has a hole in it.
        relay.on('video-gap', () => {
            if (!isCurrentPipeline()) return;
            awaitingKeyframe = true;
            gop = [];
            gopBytes = 0;
            videoConsumer.requestKeyFrame().catch(() => {});
        });

        await relay.start();
        ensureCurrentGeneration();

        relayRef = relay;
        room.fallbackStartedAt = Date.now();
        room.fallbackAvailable = false; // will become true once init segment arrives
        const hadBacklog = gop.length > 0;
        beginFeeding();

        // While nothing decodable has arrived, keep asking: sources that honour
        // keyframe requests answer at once, and OBS is simply waited for.
        const kfInterval = setInterval(() => {
            if (!room.fallbackWorker) {
                clearInterval(kfInterval);
                return;
            }
            if (!feeding && gop.length === 0) videoConsumer.requestKeyFrame().catch(() => {});
        }, 2000);
        pipeline.setTimer('keyframe', kfInterval, clearInterval);
        pipeline.markRunning(startGeneration);

        console.log(`[Fallback] Started relay for room ${room.code} (${room.fallbackBitrate.currentKbps}kbps of ${room.fallbackBitrate.targetKbps}kbps target; backlog=${hadBacklog ? 'yes' : 'no'}, audioOffset=${config.FALLBACK_AUDIO_OFFSET_MS}ms)`);
    } catch (err) {
        console.error(`[Fallback] Failed to start relay for room ${room.code}:`, err);
        room.fallbackLastError = err.message;
        stopFallbackRelay(room);
    } finally {
        if (room._mediaPipeline === pipeline && pipeline.state === 'starting') {
            pipeline.closeFallback();
        }
    }
}

function stopFallbackRelay(room) {
    const pipeline = room._mediaPipeline;
    if (pipeline) pipeline.closeFallback();
    else if (room.fallbackWorker) {
        try { room.fallbackWorker.stop(); } catch {}
    }
    room.fallbackWorker = null;
    room.fallbackStarting = false;
    room.fallbackAvailable = false;
    room.fallbackInitSegment = null;
    room.fallbackSource = null;
    room.fallbackStartedAt = null;
    room.fallbackPendingBitrate = null;
    console.log(`[Fallback] Stopped relay for room ${room.code}`);
}

function isPlainObject(value) {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isValidDtlsParameters(dtls) {
    return isPlainObject(dtls)
        && Array.isArray(dtls.fingerprints)
        && dtls.fingerprints.length > 0
        && dtls.fingerprints.every((fp) => isPlainObject(fp)
            && typeof fp.algorithm === 'string'
            && typeof fp.value === 'string');
}

function isValidRtpCapabilities(caps) {
    return isPlainObject(caps) && Array.isArray(caps.codecs);
}

/** Build the success payload returned to a viewer that has (re)joined a room. */
function buildJoinRoomResponse(room, relayAuthorized = true) {
    const { videoProducer: activeVideo, audioProducer: activeAudio } = getActiveRoomProducers(room);
    return {
        success: true,
        hasProducer: !!activeVideo,
        hasAudioProducer: !!activeAudio,
        allowMediaControl: room.allowMediaControl,
        ingestMode: room.ingestMode,
        relaySupported: room.relaySupported,
        relayAllowed: room.relayAllowed && relayAuthorized,
        hasRoomTurnServer: room.hasRoomTurnServer,
        obsVideoCodec: room.obsVideoCodec,
        fallbackAvailable: room.fallbackAvailable,
        fallbackFormat: room.fallbackFormat,
        fallbackCodec: room.fallbackCodec,
        fallbackAudioCodec: room.fallbackAudioCodec,
        fallbackTiers: room.fallbackTiers,
        whipConnected: room.whipConnected,
        whipReconnecting: room.whipReconnecting,
    };
}

function registerSocketHandlers(io, router, options = {}) {
    activeIo = io;
    const resolveClientIp = typeof options.getClientIp === 'function'
        ? options.getClientIp
        : getSocketIp;
    const authorizeCreateRoom = typeof options.authorizeCreateRoom === 'function'
        ? options.authorizeCreateRoom
        : () => true;
    const createSocketWebRtcTransport = typeof options.createWebRtcTransport === 'function'
        ? options.createWebRtcTransport
        : createWebRtcTransport;
    const prepareSocketRoom = typeof options.prepareRoom === 'function'
        ? options.prepareRoom
        : prepareRoom;
    const authorizeRelay = typeof options.authorizeRelay === 'function'
        ? options.authorizeRelay
        : () => true;
    const applyObsEncoderSettings = typeof options.applyObsEncoderSettings === 'function'
        ? options.applyObsEncoderSettings
        : () => ({ ok: false, reason: 'unavailable' });
    const listObsEncoders = typeof options.listObsEncoders === 'function'
        ? options.listObsEncoders
        : () => null;
    const relayRuntime = {
        measureBacklogBytes: typeof options.measureRelayBacklogBytes === 'function'
            ? options.measureRelayBacklogBytes
            : getSocketBufferedBytes,
        now: typeof options.now === 'function' ? options.now : Date.now,
    };
    activeRelayRuntime = relayRuntime;

    io.on('connection', (socket) => {
        console.log(`Client connected: ${socket.id}`);
        runtimeMetrics.totalConnections += 1;
        runtimeMetrics.activeSockets += 1;

        socket.on('create-room', async (data = {}, callback) => {
            let reservation = null;
            try {
                if (authorizeCreateRoom(socket, data) !== true) {
                    runtimeMetrics.createRoomDeniedUnauthorized += 1;
                    safeCallback(callback, {
                        success: false,
                        error: 'Operator authorization is required to create a room from this client.',
                    });
                    return;
                }

                const ip = resolveClientIp(socket);
                if (isRateLimitedAttempt(
                    createRoomAttempts,
                    ip,
                    config.CREATE_ROOM_RATE_LIMIT_MAX,
                    config.CREATE_ROOM_RATE_LIMIT_WINDOW_MS
                )) {
                    runtimeMetrics.createRoomDeniedRateLimit += 1;
                    safeCallback(callback, { success: false, error: 'Too many room creation attempts. Wait 1 minute.' });
                    return;
                }

                const ingestMode = data.ingestMode === 'obs' ? 'obs' : 'browser';
                const passphrase = typeof data.passphrase === 'string' ? data.passphrase : '';
                if (passphrase.length > 128) {
                    safeCallback(callback, { success: false, error: 'Room passphrase must be 128 characters or fewer.' });
                    return;
                }
                const obsAv1Mode = ingestMode === 'obs' && data.obsAv1Mode === true;
                let turnConfig = null;
                if (obsAv1Mode) {
                    const validation = validateRoomTurnConfig(data.turnConfig);
                    if (!validation.valid) {
                        safeCallback(callback, { success: false, error: validation.error });
                        return;
                    }
                    turnConfig = validation.turnConfig;
                }

                const existingRoom = findRoomByHost(socket.id);
                reservation = reserveRoomCreation(socket.id, existingRoom?.code || null);
                if (!reservation.ok) {
                    if (/capacity/i.test(reservation.error)) runtimeMetrics.createRoomDeniedCapacity += 1;
                    safeCallback(callback, { success: false, error: reservation.error });
                    return;
                }

                const room = await prepareSocketRoom(socket.id, {
                    allowMediaControl: config.ALLOW_REMOTE_MEDIA_CONTROL && data.allowMediaControl === true,
                    ingestMode,
                    obsAv1Mode,
                    turnConfig,
                    frameRate: Number(data.frameRate),
                    relayVideoKbps: Number(data.relayVideoKbps),
                    passphrase,
                    reloadRecoveryEnabled: data.reloadRecoveryEnabled === true,
                });
                if (!reservation.active || reservation.cancelled || socket.connected === false) {
                    room._mediaPipeline?.close();
                    return;
                }

                const roomToReplace = findRoomByHost(socket.id);
                if (roomToReplace) {
                    console.warn(`Host ${socket.id} already had room ${roomToReplace.code}. Replacing it.`);
                    destroyRoomWithReason(
                        io,
                        roomToReplace.code,
                        'Host restarted stream',
                        false,
                        ROOM_STATE_CODES.HOST_RESTARTED_STREAM
                    );
                }

                commitRoom(room);
                runtimeMetrics.roomsCreated += 1;
                getOrCreateRoomRelayMetrics(room.code);
                socket.join(room.code);
                console.log(`Room created: ${room.code} by ${socket.id}`);
                safeCallback(callback, {
                    success: true,
                    code: room.code,
                    hostToken: room.hostToken,
                    obsVideoCodec: room.obsVideoCodec,
                    relayAllowed: room.relayAllowed,
                    hasRoomTurnServer: room.hasRoomTurnServer,
                    passphraseProtected: !!room.passphraseHash,
                    reloadRecoveryEnabled: room.reloadRecoveryEnabled,
                });
            } catch (err) {
                console.error('create-room error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            } finally {
                releaseRoomCreation(reservation);
            }
        });

        socket.on('reclaim-host', ({ code, hostToken, reloadRecovery = false } = {}, callback) => {
            try {
                const cleanCode = (typeof code === 'string' ? code : '').trim().toUpperCase().replace(/-/g, '');
                if (!isValidRoomCode(cleanCode) || typeof hostToken !== 'string' || hostToken.length < 16) {
                    safeCallback(callback, {
                        success: false,
                        error: 'Invalid reclaim parameters.',
                        ...createRoomState(ROOM_STATE_CODES.RECLAIM_REJECTED, 'Room reclaim was rejected.'),
                    });
                    return;
                }

                const candidateRoom = findRoomByCode(cleanCode);
                if (reloadRecovery === true && candidateRoom?.reloadRecoveryEnabled !== true) {
                    safeCallback(callback, {
                        success: false,
                        error: 'Reload recovery is not enabled for this room.',
                        ...createRoomState(ROOM_STATE_CODES.RECLAIM_REJECTED, 'Room reclaim was rejected.'),
                    });
                    return;
                }

                const room = reclaimHostRoom(cleanCode, socket.id, hostToken);
                if (!room) {
                    safeCallback(callback, {
                        success: false,
                        error: 'Room not found or token invalid.',
                        ...createRoomState(ROOM_STATE_CODES.RECLAIM_REJECTED, 'The room ended or its reclaim token is no longer valid.'),
                    });
                    return;
                }

                clearHostReconnectTimer(cleanCode);
                if (reloadRecovery === true && room.ingestMode !== 'obs') {
                    try { room.producer?.close(); } catch { }
                    try { room.audioProducer?.close(); } catch { }
                    try { room.hostTransport?.close(); } catch { }
                    room.producer = null;
                    room.audioProducer = null;
                    room.hostTransport = null;
                }
                socket.join(cleanCode);
                io.to(cleanCode).emit('host-reconnected', createRoomState(
                    ROOM_STATE_CODES.HOST_RECONNECTED,
                    'Host reconnected.',
                    true
                ));
                io.to(socket.id).emit('relay-demand-changed', { count: room.relayViewers.size });
                console.log(`Host ${socket.id} reclaimed room ${cleanCode}`);
                safeCallback(callback, {
                    success: true,
                    ...createRoomState(ROOM_STATE_CODES.HOST_RECONNECTED, 'Host reconnected.', true),
                    ingestMode: room.ingestMode,
                    obsVideoCodec: room.obsVideoCodec,
                    hasRoomTurnServer: room.hasRoomTurnServer,
                    reloadRecoveryEnabled: room.reloadRecoveryEnabled,
                });
            } catch (err) {
                console.error('reclaim-host error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('join-room', async ({ code, passphrase } = {}, callback) => {
            try {
                const cleanCode = (typeof code === 'string' ? code : '').trim().toUpperCase().replace(/-/g, '');
                if (!isValidRoomCode(cleanCode)) {
                    safeCallback(callback, { success: false, error: 'Invalid room code format.' });
                    return;
                }

                const existingRoom = findRoomBySocket(socket.id);
                if (existingRoom) {
                    // Idempotent re-join: if this socket is already a VIEWER in the
                    // exact room it's asking for, treat the duplicate as success
                    // rather than an error. This is the common case when a slow-but-
                    // successful first join times out client-side and socketRequest
                    // retries join-room — previously the retry hard-failed with
                    // "Already in a room" even though the viewer was in. A request to
                    // switch to a DIFFERENT room, or from the host socket, still errors.
                    if (existingRoom.code === cleanCode && existingRoom.hostSocketId !== socket.id) {
                        socket.join(existingRoom.code);
                        safeCallback(callback, buildJoinRoomResponse(existingRoom, authorizeRelay(socket)));
                        return;
                    }
                    safeCallback(callback, { success: false, error: 'Already in a room. Leave first.' });
                    return;
                }

                const ip = resolveClientIp(socket);
                if (isRateLimitedAttempt(
                    joinAttempts,
                    ip,
                    config.JOIN_RATE_LIMIT_MAX,
                    config.JOIN_RATE_LIMIT_WINDOW_MS
                )) {
                    runtimeMetrics.joinDeniedRateLimit += 1;
                    safeCallback(callback, { success: false, error: 'Too many attempts. Wait 1 minute.' });
                    return;
                }

                const candidateRoom = findRoomByCode(cleanCode);
                if (candidateRoom) {
                    const passphraseAccepted = await verifyRoomPassphrase(candidateRoom, passphrase);
                    if (!socket.connected) return;
                    if (!passphraseAccepted) {
                        safeCallback(callback, {
                            success: false,
                            error: 'Room passphrase required or incorrect.',
                            requiresPassphrase: true,
                        });
                        return;
                    }
                }

                const room = joinRoom(cleanCode, socket.id);
                if (!room) {
                    safeCallback(callback, { success: false, error: 'Room not found.' });
                    return;
                }
                refreshRoomIceServers(room);

                const combinedViewerCount = room.viewers.size
                    + (room.whepSessions?.size || 0)
                    + (room.whepPendingReservations || 0);
                if (combinedViewerCount > config.MAX_VIEWERS_PER_ROOM) {
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

                safeCallback(callback, buildJoinRoomResponse(room, authorizeRelay(socket)));
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

                const { videoProducer, audioProducer } = getActiveRoomProducers(room);
                const producers = [];
                if (videoProducer) {
                    producers.push({ producerId: videoProducer.id, kind: 'video' });
                }
                if (audioProducer) {
                    producers.push({ producerId: audioProducer.id, kind: 'audio' });
                }
                safeCallback(callback, { success: true, producers });
            } catch (err) {
                console.error('get-producers error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        // The host page configures OBS over OBS's own WebSocket, which has no
        // request for encoder settings. When OBS runs on this machine the server
        // writes them into OBS's profile instead (see lib/obsProfile.js).
        socket.on('obs-encoder-settings', (data, callback) => {
            try {
                const room = findRoomByHost(socket.id);
                if (!room || room.ingestMode !== 'obs') {
                    safeCallback(callback, { success: false, error: 'Not hosting an OBS room.' });
                    return;
                }
                const result = applyObsEncoderSettings(socket, {
                    profileName: typeof data?.profileName === 'string' ? data.profileName.slice(0, 200) : '',
                    settings: data?.settings,
                });
                // OBS then streams what relay viewers need (see canPassSourceThrough).
                room.obsEncoderSettingsApplied = result?.ok === true;
                safeCallback(callback, {
                    success: true,
                    applied: result?.ok === true,
                    reason: result?.ok === true ? null : (result?.reason || 'unavailable'),
                });
            } catch (err) {
                console.error('obs-encoder-settings error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        // Which video encoders OBS has, when OBS runs on this machine: the host
        // page cannot ask OBS that, and can only guess the GPU.
        socket.on('obs-encoders', (data, callback) => {
            try {
                const room = findRoomByHost(socket.id);
                if (!room || room.ingestMode !== 'obs') {
                    safeCallback(callback, { success: false, error: 'Not hosting an OBS room.' });
                    return;
                }
                const encoders = listObsEncoders(socket);
                safeCallback(callback, { success: true, encoders: Array.isArray(encoders) ? encoders : null });
            } catch (err) {
                console.error('obs-encoders error:', err.message);
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

                const summary = getRoomStats(room.code);
                if (!summary) {
                    safeCallback(callback, { success: false, error: 'Room not found.' });
                    return;
                }

                safeCallback(callback, {
                    success: true,
                    metrics: buildHostRoomMetricsPayload({
                        summary,
                        room,
                        relayMetrics: roomRelayMetrics.get(summary.code),
                        eventLoopDelayMs: getEventLoopHealth(),
                        normalizeFallback: true,
                    }),
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

                const { transport, params } = await createSocketWebRtcTransport(router, { purpose: 'host' });
                attachTransportStateHandlers(transport, (kind, state) => {
                    handleHostTransportFailure(io, socket, room.code, transport.id, kind, state);
                });
                room.hostTransport = transport;
                safeCallback(callback, {
                    success: true,
                    params,
                    iceServers: getRoomIceServers(room),
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

                const { transport, params } = await createSocketWebRtcTransport(router, { purpose: 'viewer' });
                attachTransportStateHandlers(transport, (kind, state) => {
                    handleViewerTransportFailure(io, socket, room.code, transport.id, kind, state);
                });

                // A concurrent create-recv-transport for this same socket may have
                // stored a newer viewerData while we were awaiting createWebRtcTransport.
                // Without closing it, that transport + its consumers would be orphaned
                // (last write to the map wins and the previous entry leaks until the
                // room is destroyed). Close whatever is currently there before we
                // overwrite it.
                const raced = room.viewerTransports.get(socket.id);
                if (raced && raced.recvTransport && raced.recvTransport.id !== transport.id) {
                    if (raced.consumers) {
                        raced.consumers.forEach((consumer) => {
                            try { consumer.close(); } catch { }
                        });
                    }
                    markTransportForShutdown(raced.recvTransport);
                    try { raced.recvTransport.close(); } catch { }
                }
                room.viewerTransports.set(socket.id, { recvTransport: transport, consumers: [] });

                safeCallback(callback, {
                    success: true,
                    params,
                    iceServers: getRoomIceServers(room),
                });
            } catch (err) {
                console.error('create-recv-transport error:', err.message);
                safeCallback(callback, { success: false, error: 'Internal error' });
            }
        });

        socket.on('connect-transport', async ({ transportId, dtlsParameters } = {}, callback) => {
            try {
                if (!isValidTransportId(transportId) || !isValidDtlsParameters(dtlsParameters)) {
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
                // mediasoup emits local application-initiated close through the
                // observer. Room teardown calls producer.close() directly, so the
                // transport/close handlers above are not sufficient to keep the
                // process-wide active counter accurate.
                producer.observer?.on('close', () => {
                    activeProducerIds.delete(producer.id);
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
                if (!isValidProducerId(producerId) || !isValidRtpCapabilities(rtpCapabilities)) {
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

                const { videoProducer: activeVP, audioProducer: activeAP } = getActiveRoomProducers(room);
                const roomProducerIds = new Set(
                    [activeVP?.id, activeAP?.id].filter(Boolean)
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
                consumer.observer?.on('close', () => {
                    removeConsumerFromViewer(viewerData, consumer.id);
                    activeConsumerIds.delete(consumer.id);
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

        socket.on('close-viewer-transport', ({ transportId } = {}, callback) => {
            try {
                if (!isValidTransportId(transportId)) {
                    safeCallback(callback, { success: false, error: 'Invalid transport ID.' });
                    return;
                }

                const room = findRoomBySocket(socket.id);
                if (!room) {
                    safeCallback(callback, { success: true });
                    return;
                }

                const viewerData = room.viewerTransports.get(socket.id);
                if (!viewerData?.recvTransport || viewerData.recvTransport.id !== transportId) {
                    safeCallback(callback, { success: true });
                    return;
                }

                if (viewerData.consumers) {
                    viewerData.consumers.forEach((consumer) => {
                        try { consumer.close(); } catch { }
                    });
                    viewerData.consumers = [];
                }

                markTransportForShutdown(viewerData.recvTransport);
                try { viewerData.recvTransport.close(); } catch { }
                viewerData.recvTransport = null;

                emitHostMetrics(io, room.code);
                safeCallback(callback, { success: true });
            } catch (err) {
                console.error('close-viewer-transport error:', err.message);
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

                if (!room.relayAllowed) {
                    safeCallback(callback, { success: false, error: 'Relay mode is unavailable for AV1 rooms.' });
                    return;
                }
                if (authorizeRelay(socket) !== true) {
                    safeCallback(callback, { success: false, error: 'Relay requires HTTPS or an explicitly trusted LAN.' });
                    return;
                }

                runtimeMetrics.relayStartRequests += 1;
                setViewerRelayMode(io, room, socket.id, true);
                emitHostMetrics(io, room.code);
                safeCallback(callback, {
                    success: true,
                    relayViewerCount: room.relayViewers.size,
                    initAvailable: !!room.mediaInit,
                    bootstrapComplete: room.mediaBootstrapComplete !== false,
                    // One concatenated buffer: socket.io-parser drops a client
                    // whose packet carries more than 10 binary attachments.
                    bootstrapChunks: buildRelayBootstrap(room),
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
            try {
                const room = findRoomBySocket(socket.id);
                if (!room || room.ingestMode !== 'obs') {
                    return safeCallback(callback, { error: 'Not an OBS room' });
                }
                if (!room.relayAllowed) {
                    return safeCallback(callback, { error: 'Relay mode is unavailable for AV1 rooms.' });
                }
                if (authorizeRelay(socket) !== true) {
                    return safeCallback(callback, { error: 'Relay requires HTTPS or an explicitly trusted LAN.' });
                }
                if (room.obsVideoCodec && room.obsVideoCodec !== 'h264') {
                    return safeCallback(callback, { error: 'OBS relay currently requires H.264 ingest.' });
                }

                const alreadyFallbackViewer = room.fallbackViewers.has(socket.id);
                if (!alreadyFallbackViewer && room.fallbackViewers.size >= config.MAX_FALLBACK_VIEWERS) {
                    return safeCallback(callback, { error: 'Relay viewer limit reached. Please try again shortly.' });
                }

                room.fallbackViewers.add(socket.id);
                updateFallbackAudienceMembership(io, room.code, socket.id, true);
                room.fallbackViewerCount = room.fallbackViewers.size;

                // Start relay on first demand as soon as the OBS producer exists
                // AND the codec is confirmed H.264. During the WHIP connect window
                // the producer can exist while obsVideoCodec is still null; in that
                // case the viewer stays registered and the WHIP-side prewarm (or a
                // client retry) starts the relay moments later.
                // `whipConnected` can briefly lag during reconnect edges while the
                // producer is already present and consumable.
                if (!room.fallbackWorker && room.whipProducer && room.obsVideoCodec === 'h264') {
                    await startFallbackRelay(room, router, io);
                }

                safeCallback(callback, { ok: true, fallbackAvailable: room.fallbackAvailable });
            } catch (err) {
                console.error('fallback-consume-start error:', err.message);
                safeCallback(callback, { error: 'Internal error' });
            }
        });

        socket.on('relay-ack', (data) => {
            const room = findRoomBySocket(socket.id);
            if (room?.fallbackDelivery) recordFallbackAck(room, socket.id, data, relayRuntime.now());
        });

        socket.on('fallback-consume-stop', () => {
            const room = findRoomBySocket(socket.id);
            if (!room) return;

            room.fallbackViewers.delete(socket.id);
            room.fallbackDelivery?.delete(socket.id);
            updateFallbackAudienceMembership(io, room.code, socket.id, false);
            room.fallbackViewerCount = room.fallbackViewers.size;

            // Keep the relay running while OBS is connected: it is prewarmed at
            // WHIP-connect to catch OBS's one-time keyframe, so tearing it down when
            // the last viewer leaves would mean the next viewer (a late start) never
            // receives video. It is stopped when the WHIP session ends or the room
            // is destroyed. Only stop here if OBS is already gone.
            if (room.fallbackViewers.size === 0 && room.fallbackWorker && !room.whipConnected) {
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

                if (!config.ALLOW_REMOTE_MEDIA_CONTROL || !room.allowMediaControl) {
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

            const generation = Number(data?.generation);
            if (!Number.isSafeInteger(generation) || generation <= 0 || generation !== room.mediaGeneration) return;
            const chunk = data?.chunk;

            const size = chunk instanceof Buffer
                ? chunk.length
                : chunk instanceof ArrayBuffer
                    ? chunk.byteLength
                    : chunk?.byteLength || chunk?.size || 0;

            if (size <= 0) return;
            if (size > MAX_CHUNK_SIZE) {
                runtimeMetrics.relayChunksDroppedOversized += 1;
                const relayMetric = getOrCreateRoomRelayMetrics(room.code);
                relayMetric.droppedOversized += 1;
                console.warn(`[Nextra] Dropped oversized media chunk (${size} bytes, limit ${MAX_CHUNK_SIZE}).`);
                return;
            }

            if (room.relayMp4) {
                if (room.relayViewers.size > 0) {
                    runtimeMetrics.relayChunksReceived += 1;
                    runtimeMetrics.relayBytesReceived += size;
                    const relayMetric = getOrCreateRoomRelayMetrics(room.code);
                    relayMetric.chunksReceived += 1;
                    relayMetric.bytesReceived += size;
                }
                // Parse even without viewers (prewarm) so the init segment and
                // current GOP are ready for whoever joins next.
                room.relayMp4.push(chunk);
                return;
            }

            // Always capture the first chunk after a media-init — it contains the
            // WebM initialization segment (EBML header + Tracks) needed by new
            // viewers, even if no relay viewers are connected yet (prewarm mode).
            if (!room.initChunk) {
                room.initChunk = chunk;
            }

            // MediaRecorder timeslices can split WebM elements at arbitrary byte
            // offsets. A later viewer therefore needs the active generation from
            // its beginning, not just the EBML header. Keep that bootstrap bounded
            // to the same byte ceiling enforced by the browser playback queue.
            if (room.mediaBootstrapComplete !== false) {
                const nextBootstrapBytes = (room.mediaBootstrapBytes || 0) + size;
                if (nextBootstrapBytes <= MAX_RELAY_BOOTSTRAP_BYTES) {
                    room.mediaBootstrapChunks.push(chunk);
                    room.mediaBootstrapBytes = nextBootstrapBytes;
                } else {
                    room.mediaBootstrapChunks = [];
                    room.mediaBootstrapBytes = 0;
                    room.mediaBootstrapComplete = false;
                }
            }

            if (room.relayViewers.size === 0) return;
            const relayMetric = getOrCreateRoomRelayMetrics(room.code);

            runtimeMetrics.relayChunksReceived += 1;
            runtimeMetrics.relayBytesReceived += size;
            relayMetric.chunksReceived += 1;
            relayMetric.bytesReceived += size;

            const delivered = emitToRelayViewers(io, room, 'media-chunk', { generation, chunk });
            runtimeMetrics.relayChunksForwarded += delivered;
            runtimeMetrics.relayBytesForwarded += (size * delivered);
            relayMetric.chunksForwarded += delivered;
            relayMetric.bytesForwarded += (size * delivered);
        });

        socket.on('media-init', (data) => {
            const room = findRoomByHost(socket.id);
            if (!room) return;
            if (!data || typeof data.mimeType !== 'string' || data.mimeType.length > 100) return;
            const generation = Number(data.generation);
            if (!Number.isSafeInteger(generation) || generation <= 0) return;
            if (room.mediaGeneration != null && generation <= room.mediaGeneration) return;

            room.mediaGeneration = generation;
            room.mediaInit = { mimeType: data.mimeType, generation };
            room.initChunk = null;
            room.mediaBootstrapChunks = [];
            room.mediaBootstrapBytes = 0;
            room.mediaBootstrapComplete = true;
            resetMp4Relay(room, { keepCongestion: true });
            if (data.mimeType.startsWith('video/mp4')) {
                let parseErrorLogged = false;
                const deliver = (unit) => {
                    const delivered = deliverMp4RelayUnit(io, room, generation, unit, relayRuntime);
                    if (delivered === 0) return;
                    const relayMetric = getOrCreateRoomRelayMetrics(room.code);
                    runtimeMetrics.relayChunksForwarded += delivered;
                    runtimeMetrics.relayBytesForwarded += unit.data.length * delivered;
                    relayMetric.chunksForwarded += delivered;
                    relayMetric.bytesForwarded += unit.data.length * delivered;
                };
                room.relayMp4 = createMp4RelayStream({
                    onInit: (initSegment) => {
                        room.initChunk = initSegment;
                        deliver({ init: true, data: initSegment });
                    },
                    onFragment: ({ data: fragment, keyframe }) => {
                        // Recorder fragments span ~1 s (the keyframe interval), so
                        // bytes per arrival interval tracks the relay bitrate.
                        const now = relayRuntime.now();
                        const intervalSec = room.relayLastFragmentAt
                            ? Math.min(5, Math.max(0.2, (now - room.relayLastFragmentAt) / 1000))
                            : 1;
                        room.relayLastFragmentAt = now;
                        const sampleBps = (fragment.length * 8) / intervalSec;
                        room.relayIngestBps = room.relayIngestBps
                            ? (room.relayIngestBps * 0.8) + (sampleBps * 0.2)
                            : sampleBps;
                        if (keyframe) {
                            room.relayGop = [fragment];
                            room.relayGopBytes = fragment.length;
                            room.mediaBootstrapComplete = true;
                        } else if (room.relayGopBytes + fragment.length <= MAX_RELAY_BOOTSTRAP_BYTES) {
                            room.relayGop.push(fragment);
                            room.relayGopBytes += fragment.length;
                        } else {
                            room.mediaBootstrapComplete = false;
                        }
                        deliver({ data: fragment, keyframe });
                    },
                    // Unframeable MP4 would leave relay viewers silent. Stop parsing
                    // this generation and have the host restart on its VP8
                    // recorder, which viewers then pick up as a new generation.
                    onError: (err) => {
                        if (parseErrorLogged) return;
                        parseErrorLogged = true;
                        console.warn(`[Nextra] MP4 relay parse error in room ${room.code}: ${err.message}; asking host to fall back to VP8.`);
                        room.relayMp4 = { push() {} };
                        io.to(room.hostSocketId).emit('relay-mp4-failed', { generation });
                    },
                });
            }
            emitToRelayViewers(io, room, 'media-init', room.mediaInit);
        });

        socket.on('get-media-init', (data, callback) => {
            // Handle fMP4 format request (OBS fallback)
            if (data?.format === 'fmp4') {
                const room = findRoomBySocket(socket.id);
                if (!room || !room.fallbackInitSegment) {
                    safeCallback(callback, {
                        success: false,
                        reason: !room ? 'no-room' : 'fallback-starting',
                    });
                    return;
                }

                const h264Profile = room.fallbackH264Profile || '640032';
                const videoMime = `avc1.${h264Profile}`;
                const audioMime = room.fallbackAudioCodec === 'aac' ? ', mp4a.40.2' : '';

                safeCallback(callback, {
                    success: true,
                    init: {
                        format: 'fmp4',
                        mimeType: `video/mp4; codecs="${videoMime}${audioMime}"`,
                        codec: room.obsVideoCodec,
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
            destroyRoomWithReason(io, room.code, 'Host stopped sharing', false, ROOM_STATE_CODES.HOST_STOPPED);
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
                    destroyRoomWithReason(io, room.code, 'Host left room', false, ROOM_STATE_CODES.HOST_LEFT);
                    safeCallback(callback, { success: true });
                    return;
                }

                const wasRelayViewer = room.relayViewers.has(socket.id);
                if (wasRelayViewer) {
                    setViewerRelayMode(io, room, socket.id, false);
                }
                if (room.fallbackViewers?.has(socket.id)) {
                    updateFallbackAudienceMembership(io, room.code, socket.id, false);
                }
                markViewerTransportForShutdown(room, socket.id);
                const updatedRoom = removeViewer(socket.id);
                if (updatedRoom) {
                    socket.leave(updatedRoom.code);
                    console.log(`Viewer ${socket.id} left room ${updatedRoom.code} (${updatedRoom.viewers.size} viewers)`);
                    io.to(updatedRoom.hostSocketId).emit('viewer-count', { count: updatedRoom.viewers.size });
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
            cancelPendingRoomCreation(socket.id);

            const hostRoom = findRoomByHost(socket.id);
            if (hostRoom) {
                const roomCode = hostRoom.code;
                const oldHostSocketId = socket.id;
                console.log(`Host disconnected from room ${roomCode} - waiting for reconnect`);
                emitHostDisconnected(
                    io,
                    roomCode,
                    'Host connection lost. Attempting reconnect...',
                    true,
                    ROOM_STATE_CODES.HOST_DISCONNECTED
                );

                // If OBS room and WHIP was connected, notify fallback viewers
                if (hostRoom.ingestMode === 'obs') {
                    io.to(getFallbackAudienceRoom(hostRoom.code)).emit('whip-status', {
                        connected: hostRoom.whipConnected,
                        reconnecting: hostRoom.whipReconnecting,
                    });
                }

                clearHostReconnectTimer(roomCode);
                const timer = setTimeout(() => {
                    const currentRoom = findRoomByCode(roomCode);
                    if (currentRoom && currentRoom.hostSocketId === oldHostSocketId) {
                        console.log(`Host reconnect timeout for room ${roomCode} - destroying room`);
                        destroyRoomWithReason(
                            io,
                            roomCode,
                            'Host reconnect window expired. The room ended.',
                            false,
                            ROOM_STATE_CODES.HOST_RECONNECT_TIMEOUT
                        );
                    }
                    hostReconnectTimers.delete(roomCode);
                }, config.HOST_RECONNECT_GRACE_MS);

                hostReconnectTimers.set(roomCode, timer);
                return;
            }

            const roomBeforeRemoval = findRoomBySocket(socket.id);
            const wasRelayViewer = !!roomBeforeRemoval?.relayViewers?.has(socket.id);
            if (wasRelayViewer) {
                setViewerRelayMode(io, roomBeforeRemoval, socket.id, false);
            }
            if (roomBeforeRemoval?.fallbackViewers?.has(socket.id)) {
                updateFallbackAudienceMembership(io, roomBeforeRemoval.code, socket.id, false);
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
                emitHostMetrics(io, room.code);

                // Keep the prewarmed relay alive while OBS is still connected — it
                // holds the one keyframe OBS sent at stream start, so tearing it down
                // when the last viewer leaves would leave the next viewer (a late
                // start) with no keyframe. Only stop it once OBS is gone.
                if (room.fallbackViewers && room.fallbackViewers.size === 0
                    && room.fallbackWorker && !room.whipConnected) {
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

        for (const [ip, record] of createRoomAttempts) {
            if (now > record.resetAt) createRoomAttempts.delete(ip);
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
        if (activeIo) {
            emitAllHostsMetrics(activeIo);
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

    createRoomAttempts.clear();
    for (const reservation of pendingRoomCreations.values()) {
        releaseRoomCreation(reservation, { cancelled: true });
    }
    pendingRoomCreations.clear();
    for (const timer of hostReconnectTimers.values()) {
        clearTimeout(timer);
    }
    hostReconnectTimers.clear();
    lastToggleByViewer.clear();
    ignoredTransportIds.clear();
    activeIo = null;
}

module.exports = {
    registerSocketHandlers,
    startJoinCleanup,
    stopJoinCleanup,
    getSocketRuntimeMetrics: getRuntimeMetricsSnapshot,
    emitAllHostsMetrics,
    destroyRoomWithReason,
    startFallbackRelay,
    recordFallbackAck,
    stopFallbackRelay,
    setRelayCapacityKbps,
    emitHostMetrics,
    __testing: {
        handleViewerTransportFailure,
        getSocketBufferedBytes,
        resetEngineWriteBufferWarning() {
            warnedMissingEngineWriteBuffer = false;
        },
        getPendingRoomCreationCount() {
            return pendingRoomCreations.size;
        },
        reserveRoomCreation,
        releaseRoomCreation,
        getIgnoredTransportCount() {
            return ignoredTransportIds.size;
        },
        EMPTY_RELAY_METRICS,
    },
};
