// @ts-check

// Which relay-consume-start (or fallback-consume-start) this viewer sent last.
//
// The server's stop handlers are socket-wide: relay-consume-stop removes this
// socket.id from the relay audience whichever start subscribed it, and carries
// no attempt identity. A stop sent by an old attempt after a newer attempt's
// start would therefore remove the newer subscription. Socket.IO delivers one
// connection's emits in order, so the client can keep ownership itself:
//
// - every start records a claim (attempt token, socket.id) in the same
//   synchronous block as its emit, so the latest claim of a kind is always the
//   last start this client sent;
// - a stop is sent only for the latest claim, only while the socket is
//   connected, and only on the socket.id the start went out on. Otherwise a
//   newer start on this connection owns the subscription, or the connection the
//   start used is gone and the server dropped the subscription with it.
//
// socket.io-client buffers emits made while disconnected and sends them on the
// next connection under a new socket.id, so neither a start nor a stop is ever
// emitted while the socket is disconnected.
//
// Pure module with no React dependency; the unit tests drive it with a fake socket.

/** @typedef {'relay' | 'fallback'} SubscriptionKind */
/** @typedef {{ readonly kind: SubscriptionKind, readonly token: unknown, readonly socketId: string }} SubscriptionClaim */
/**
 * @typedef {object} LedgerSocket
 * @property {boolean} connected
 * @property {string | undefined} [id]
 * @property {(event: string, ...args: any[]) => unknown} emit
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} [on]
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} [off]
 */

const KINDS = new Set(['relay', 'fallback']);

/** @param {unknown} kind */
function assertKind(kind) {
    if (!KINDS.has(/** @type {string} */ (kind))) {
        throw new TypeError(`Unknown subscription kind: ${String(kind)}`);
    }
}

export function createSubscriptionLedger() {
    /** @type {Map<SubscriptionKind, SubscriptionClaim>} */
    const latest = new Map();

    return {
        /**
         * Records a start that is being emitted now and returns its claim.
         * Call it in the same synchronous block as the emit.
         * @param {SubscriptionKind} kind
         * @param {unknown} token The attempt that sends the start.
         * @param {string} socketId The socket.id the start goes out on.
         * @returns {SubscriptionClaim}
         */
        claim(kind, token, socketId) {
            assertKind(kind);
            const claim = Object.freeze({ kind, token, socketId });
            latest.set(kind, claim);
            return claim;
        },

        /**
         * @param {SubscriptionKind} kind
         * @returns {SubscriptionClaim | null}
         */
        latest(kind) {
            assertKind(kind);
            return latest.get(kind) ?? null;
        },

        /**
         * True only when a stop for this claim cannot remove anyone else's
         * subscription: it is still the latest claim of its kind, the socket is
         * connected, and socket.id is the one the start was emitted on.
         * @param {SubscriptionKind} kind
         * @param {SubscriptionClaim | null | undefined} claim
         * @param {LedgerSocket | null | undefined} socket
         */
        canRelease(kind, claim, socket) {
            assertKind(kind);
            if (!claim || latest.get(kind) !== claim) return false;
            if (!socket || socket.connected !== true) return false;
            return typeof socket.id === 'string' && socket.id === claim.socketId;
        },

        /**
         * Forgets the claim if it is still the latest one; a newer claim stays.
         * @param {SubscriptionKind} kind
         * @param {SubscriptionClaim | null | undefined} claim
         * @returns {boolean} Whether the claim was the latest.
         */
        release(kind, claim) {
            assertKind(kind);
            if (!claim || latest.get(kind) !== claim) return false;
            latest.delete(kind);
            return true;
        },
    };
}

/** @typedef {ReturnType<typeof createSubscriptionLedger>} SubscriptionLedger */

export class SocketNotConnectedError extends Error {
    /** @param {string} event */
    constructor(event) {
        super(`Not connected to the server, so "${event}" was not sent. Try again in a moment.`);
        this.name = 'SocketNotConnectedError';
    }
}

/**
 * Emits a subscription start with its ack and records the claim in the same
 * synchronous block. Throws a SocketNotConnectedError, claiming and emitting
 * nothing, while the socket is disconnected. The promise resolves with the raw
 * acknowledgement and rejects on a timeout or a disconnect; nothing is retried.
 * @param {SubscriptionLedger} ledger
 * @param {SubscriptionKind} kind
 * @param {unknown} token
 * @param {LedgerSocket} socket
 * @param {string} event
 * @param {unknown} [payload]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{ claim: SubscriptionClaim, acknowledged: Promise<any> }}
 */
export function emitClaimedStart(ledger, kind, token, socket, event, payload = {}, { timeoutMs = 15000 } = {}) {
    if (!socket || socket.connected !== true || typeof socket.id !== 'string') {
        throw new SocketNotConnectedError(event);
    }
    const claim = ledger.claim(kind, token, socket.id);
    const acknowledged = new Promise((resolve, reject) => {
        let settled = false;
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        const onDisconnect = (/** @type {unknown} */ reason) => {
            if (settled) return;
            finish();
            reject(new Error(`Connection lost while waiting for "${event}" (${String(reason)})`));
        };
        const finish = () => {
            settled = true;
            clearTimeout(timer);
            socket.off?.('disconnect', onDisconnect);
        };
        timer = setTimeout(() => {
            if (settled) return;
            finish();
            reject(new Error(`Request "${event}" timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        socket.on?.('disconnect', onDisconnect);
        socket.emit(event, payload, (/** @type {unknown} */ response) => {
            if (settled) return;
            finish();
            resolve(response);
        });
    });
    return { claim, acknowledged };
}

/**
 * Sends the stop for a claim when ledger.canRelease allows it, then releases
 * the claim (a newer claim is kept). Returns whether the stop was emitted.
 * @param {SubscriptionLedger} ledger
 * @param {SubscriptionKind} kind
 * @param {SubscriptionClaim | null | undefined} claim
 * @param {LedgerSocket} socket
 * @param {string} stopEvent
 */
export function releaseSubscription(ledger, kind, claim, socket, stopEvent) {
    if (!claim) return false;
    const mayStop = ledger.canRelease(kind, claim, socket);
    if (mayStop) socket.emit(stopEvent);
    ledger.release(kind, claim);
    return mayStop;
}
