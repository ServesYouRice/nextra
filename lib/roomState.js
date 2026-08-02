'use strict';

const ROOM_STATE_CODES = Object.freeze({
    HOST_DISCONNECTED: 'host-disconnected',
    HOST_RECONNECTED: 'host-reconnected',
    HOST_RECONNECT_TIMEOUT: 'host-reconnect-timeout',
    HOST_STOPPED: 'host-stopped',
    HOST_LEFT: 'host-left',
    HOST_MEDIA_FAILED: 'host-media-failed',
    HOST_RESTARTED_STREAM: 'host-restarted-stream',
    ROOM_TIMED_OUT: 'room-timed-out',
    RECLAIM_REJECTED: 'reclaim-rejected',
    SERVER_SHUTDOWN: 'server-shutdown',
    MEDIA_WORKER_FATAL: 'media-worker-fatal',
    SERVER_FATAL: 'server-fatal',
    VIEWER_TRANSPORT_FAILED: 'viewer-transport-failed',
    RELAY_BACKPRESSURE: 'relay-backpressure',
});

function createRoomState(code, reason, recoverable = false) {
    return {
        code,
        reason,
        recoverable: recoverable === true,
        terminal: recoverable !== true,
    };
}

module.exports = { ROOM_STATE_CODES, createRoomState };
