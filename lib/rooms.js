// lib/rooms.js - Room management: code generation, host/viewer tracking, heartbeat cleanup
const crypto = require('crypto');
const config = require('../config');

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

const rooms = new Map();
const socketToRoom = new Map();

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
    };

    rooms.set(code, room);
    socketToRoom.set(hostSocketId, code);
    return room;
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
    return {
        code: room.code,
        hostSocketId: room.hostSocketId,
        viewerCount: room.viewers.size,
        relayViewerCount: room.relayViewers.size,
        mediasoupConsumerCount,
        hasProducer: !!room.producer,
        hasAudioProducer: !!room.audioProducer,
        createdAt: room.createdAt,
        lastHeartbeat: room.lastHeartbeat,
    };
}

function getAllRoomStats() {
    return Array.from(rooms.keys()).map((code) => getRoomStats(code)).filter(Boolean);
}

let cleanupInterval = null;

function startRoomCleanup() {
    cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [code, room] of rooms) {
            if (now - room.lastHeartbeat > config.ROOM_STALE_TIMEOUT_MS) {
                const staleForSec = Math.round((now - room.lastHeartbeat) / 1000);
                console.log(`Cleaning stale room ${code} (no heartbeat for ${staleForSec}s)`);
                destroyRoom(code);
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
    startRoomCleanup,
    stopRoomCleanup,
    touchRoom,
};
