// src/lib/mediasoupClient.js - Shared helpers for mediasoup-client

let deviceInstance = null;

// Events that get a second attempt by default; shouldRetry decides per failure whether it is made.
const RETRYABLE_EVENTS = new Set([
    'create-room',
    'join-room',
    'reclaim-host',
    'leave-room',
    'get-media-init',
]);

// A repeat of these gives the same result or a harmless no-op on the server: get-media-init only reads,
// reclaim-host rechecks the host token for the same room, and leave-room with no room answers success.
// create-room (a second room) and join-room (a second viewer) are not in this set.
const IDEMPOTENT_EVENTS = new Set([
    'reclaim-host',
    'leave-room',
    'get-media-init',
]);

// Every failure of a request carries the phase it happened in, and the phase (never the message text)
// decides whether sending the request again is safe:
//   'connect'                the socket never connected, so nothing was sent: retry any event.
//   'ack-timeout'            the request may have reached the server; the late ack is dropped.
//   'disconnect-after-emit'  same: retry only events the server can handle twice (IDEMPOTENT_EVENTS).
//   'server'                 the server answered with an error: never retry, whatever the message says.
function tagPhase(error, phase) {
    error.phase = phase;
    return error;
}

export async function getDevice() {
    if (deviceInstance) return deviceInstance;
    const { Device } = await import('mediasoup-client');
    deviceInstance = new Device();
    return deviceInstance;
}

export function resetDevice() {
    deviceInstance = null;
}

function getSocketEndpointLabel() {
    if (typeof window === 'undefined') return '/socket.io';
    return `${window.location.origin.replace(/\/$/, '')}/socket.io`;
}

function formatSocketConnectError(err) {
    const rawMessage = err?.message || 'unknown error';
    const lowerMessage = rawMessage.toLowerCase();
    if (
        lowerMessage.includes('xhr poll error')
        || lowerMessage.includes('websocket error')
        || lowerMessage.includes('timeout')
    ) {
        return `Socket connect failed: cannot reach the Nextra server at ${getSocketEndpointLabel()}. Make sure the backend is running; in source/dev, use npm run dev.`;
    }

    return `Socket connect failed: ${rawMessage}`;
}

function waitForSocketConnect(socket, timeoutMs = 10000) {
    if (socket.connected) return Promise.resolve();

    return new Promise((resolve, reject) => {
        let lastConnectError = null;
        const timer = setTimeout(() => {
            cleanup();
            reject(tagPhase(lastConnectError || new Error('Socket is not connected'), 'connect'));
        }, timeoutMs);

        const onConnect = () => {
            cleanup();
            resolve();
        };

        const onConnectError = (err) => {
            lastConnectError = new Error(formatSocketConnectError(err));
        };

        const cleanup = () => {
            clearTimeout(timer);
            socket.off('connect', onConnect);
            socket.off('connect_error', onConnectError);
        };

        socket.on('connect', onConnect);
        socket.on('connect_error', onConnectError);
        socket.connect();
    });
}

function emitWithAck(socket, event, data, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(tagPhase(
                new Error(`Request "${event}" timed out after ${Math.round(timeoutMs / 1000)}s`),
                'ack-timeout',
            ));
        }, timeoutMs);

        const onDisconnect = (reason) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(tagPhase(
                new Error(`Connection lost while waiting for "${event}" (${reason})`),
                'disconnect-after-emit',
            ));
        };

        const cleanup = () => {
            clearTimeout(timer);
            socket.off('disconnect', onDisconnect);
        };

        socket.on('disconnect', onDisconnect);
        socket.emit(event, data, (response) => {
            if (settled) return;
            settled = true;
            cleanup();

            if (!response) {
                reject(tagPhase(new Error(`Request "${event}" failed (empty response)`), 'server'));
                return;
            }

            if (response.success) {
                resolve(response);
                return;
            }

            const error = new Error(response.error || response.message || 'Unknown error');
            Object.assign(error, response);
            // After the assign, so a field named `phase` in the server's response cannot change the class.
            reject(tagPhase(error, 'server'));
        });
    });
}

function shouldRetry(event, err) {
    switch (err?.phase) {
        case 'connect':
            return true;
        case 'ack-timeout':
        case 'disconnect-after-emit':
            return IDEMPOTENT_EVENTS.has(event);
        default:
            return false;
    }
}

export async function socketRequest(socket, event, data = {}, options = {}) {
    const timeoutMs = options.timeoutMs || 15000;
    const connectTimeoutMs = options.connectTimeoutMs || 10000;
    const maxAttempts = options.maxAttempts || (RETRYABLE_EVENTS.has(event) ? 2 : 1);

    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            await waitForSocketConnect(socket, connectTimeoutMs);
            return await emitWithAck(socket, event, data, timeoutMs);
        } catch (err) {
            lastError = err;
            if (attempt >= maxAttempts || !shouldRetry(event, err)) {
                throw err;
            }
            socket.connect();
        }
    }

    throw lastError || new Error('Unknown socket request error');
}
