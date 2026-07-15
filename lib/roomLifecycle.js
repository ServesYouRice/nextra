'use strict';

// Route modules register their protocol-specific cleanup here. This keeps the
// room and Socket.IO layers independent from Express route modules and avoids
// lazy require() cycles during teardown.
let closeWhipSessionHandler = null;
let closeAllWhepSessionsHandler = null;

function setWhipSessionCloser(handler) {
    closeWhipSessionHandler = typeof handler === 'function' ? handler : null;
}

function setWhepSessionsCloser(handler) {
    closeAllWhepSessionsHandler = typeof handler === 'function' ? handler : null;
}

function closeWhipSession(room) {
    if (!room) return;
    if (closeWhipSessionHandler) {
        closeWhipSessionHandler(room);
        return;
    }

    if (room.whipGraceTimer) clearTimeout(room.whipGraceTimer);
    for (const resource of [room.whipProducer, room.whipAudioProducer, room.whipTransport]) {
        try { resource?.close(); } catch { }
    }
    room.whipGraceTimer = null;
    room.whipProducer = null;
    room.whipAudioProducer = null;
    room.whipTransport = null;
    room.whipConnected = false;
}

function closeAllWhepSessions(room) {
    if (!room?.whepSessions) return;
    if (closeAllWhepSessionsHandler) {
        closeAllWhepSessionsHandler(room);
        return;
    }

    for (const session of room.whepSessions.values()) {
        if (session.connectTimer) clearTimeout(session.connectTimer);
        try { session.consumer?.close(); } catch { }
        try { session.audioConsumer?.close(); } catch { }
        try { session.transport?.close(); } catch { }
    }
    room.whepSessions.clear();
    room.whepViewerCount = 0;
}

module.exports = {
    setWhipSessionCloser,
    setWhepSessionsCloser,
    closeWhipSession,
    closeAllWhepSessions,
};
