// src/lib/mediasoupClient.js - Shared helpers for mediasoup-client

let deviceInstance = null;

const RETRYABLE_EVENTS = new Set([
    'create-room',
    'join-room',
    'reclaim-host',
    'leave-room',
    'get-media-init',
]);

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
            reject(lastConnectError || new Error('Socket is not connected'));
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
            reject(new Error(`Request "${event}" timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);

        const onDisconnect = (reason) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(`Connection lost while waiting for "${event}" (${reason})`));
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
                reject(new Error(`Request "${event}" failed (empty response)`));
                return;
            }

            if (response.success) {
                resolve(response);
                return;
            }

            reject(new Error(response.error || response.message || 'Unknown error'));
        });
    });
}

function isTransientError(err) {
    const message = (err?.message || '').toLowerCase();
    return (
        message.includes('timed out')
        || message.includes('socket is not connected')
        || message.includes('connection lost')
        || message.includes('socket connect failed')
    );
}

export async function socketRequest(socket, event, data = {}, options = {}) {
    const timeoutMs = options.timeoutMs || 15000;
    const maxAttempts = options.maxAttempts || (RETRYABLE_EVENTS.has(event) ? 2 : 1);

    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            await waitForSocketConnect(socket, 10000);
            return await emitWithAck(socket, event, data, timeoutMs);
        } catch (err) {
            lastError = err;
            if (attempt >= maxAttempts || !isTransientError(err)) {
                throw err;
            }
            socket.connect();
        }
    }

    throw lastError || new Error('Unknown socket request error');
}
