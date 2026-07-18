'use strict';

const crypto = require('node:crypto');

class SessionRegistry {
    constructor() {
        this.rooms = new Map();
        this.socketToRoom = new Map();
        this.whipResources = new Map();
        this.whepSessions = new Map();
        this.pendingWhepGlobal = 0;
        this.pendingWhepByRoom = new Map();
    }

    createUniqueRoomCode(chars, length = 6) {
        let code;
        do {
            code = '';
            for (let i = 0; i < length; i += 1) code += chars[crypto.randomInt(chars.length)];
        } while (this.rooms.has(code));
        return code;
    }

    mapSocket(socketId, roomCode) {
        this.socketToRoom.set(socketId, roomCode);
    }

    unmapSocket(socketId) {
        this.socketToRoom.delete(socketId);
    }

    roomForSocket(socketId) {
        const code = this.socketToRoom.get(socketId);
        return code ? this.rooms.get(code) || null : null;
    }

    registerWhipResource(resourceId, roomCode) {
        this.whipResources.set(resourceId, roomCode);
    }

    unregisterWhipResource(resourceId) {
        this.whipResources.delete(resourceId);
    }

    roomCodeForWhipResource(resourceId) {
        return this.whipResources.get(resourceId) || null;
    }

    tryReserveWhep({ roomCode, socketViewers, activeRoomSessions, globalLimit, roomLimit }) {
        if (this.whepSessions.size + this.pendingWhepGlobal >= globalLimit) {
            return { ok: false, reason: 'global-capacity' };
        }
        const pendingForRoom = this.pendingWhepByRoom.get(roomCode) || 0;
        if (socketViewers + activeRoomSessions + pendingForRoom >= roomLimit) {
            return { ok: false, reason: 'room-capacity' };
        }
        this.pendingWhepGlobal += 1;
        this.pendingWhepByRoom.set(roomCode, pendingForRoom + 1);
        let released = false;
        return {
            ok: true,
            release: () => {
                if (released) return false;
                released = true;
                this.pendingWhepGlobal = Math.max(0, this.pendingWhepGlobal - 1);
                const remaining = Math.max(0, (this.pendingWhepByRoom.get(roomCode) || 1) - 1);
                if (remaining === 0) this.pendingWhepByRoom.delete(roomCode);
                else this.pendingWhepByRoom.set(roomCode, remaining);
                return true;
            },
        };
    }

    registerWhepSession(sessionId, session) {
        this.whepSessions.set(sessionId, session);
    }

    getWhepSession(sessionId) {
        return this.whepSessions.get(sessionId) || null;
    }

    unregisterWhepSession(sessionId) {
        this.whepSessions.delete(sessionId);
    }

    clearRoomMappings(room) {
        for (const socketId of room.viewers || []) this.unmapSocket(socketId);
        this.unmapSocket(room.hostSocketId);
        if (room.whipResourceId) this.unregisterWhipResource(room.whipResourceId);
    }
}

const sessionRegistry = new SessionRegistry();

module.exports = { SessionRegistry, sessionRegistry };
