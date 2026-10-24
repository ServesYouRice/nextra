// @ts-check

// One request with an acknowledgement, sent once, that a lost answer cannot leave
// waiting for good.
//
// socketRequest (mediasoupClient.js) is not usable for every event. It treats an
// answer as a success only when it carries `success: true`, retries transient
// errors and may call socket.connect(), while a few server events answer with
// their own shape (fallback-consume-start answers `{ ok: true, fallbackAvailable }`
// or `{ error }`). This helper does none of that interpreting: it resolves with
// the raw answer and leaves reading it to the caller.
//
// - While the socket is disconnected nothing is emitted: socket.io-client
//   buffers emits made then and sends them on the next connection, under a new
//   socket.id, long after the caller gave up on them.
// - The request is emitted once. It is never retried and never reconnects the
//   socket.
// - It rejects with an AckTimeoutError after `timeoutMs`, and with an
//   AckDisconnectError when the connection drops first (socket.io-client then
//   never calls the acknowledgement of a packet it had already sent).
// - Once settled, the timer and the disconnect listener are gone and a late
//   answer is ignored.
// - The returned promise takes onAnswer listeners, which get the answer in the
//   dispatch of the answer itself. socket.io-client dispatches each packet it
//   decodes in a microtask of its own, in order; the packets of one transport
//   frame (HTTP long-polling carries several) are queued together, so whatever
//   awaits the promise runs only after the events that followed the answer. A
//   caller that must tell the events before the answer from those after it
//   (the relay start: the live chunks after it continue its bootstrap) reads
//   the answer in onAnswer.
//
// No React here, so the unit tests drive the same code with a fake socket.

/** The ack timeout of fallback-consume-start (section-49e0545c60d121dd3e784d86/Q-004). */
export const DEFAULT_ACK_TIMEOUT_MS = 10000;

export class SocketNotConnectedError extends Error {
    /** @param {string} event */
    constructor(event) {
        super(`Not connected to the server, so "${event}" was not sent. Try again in a moment.`);
        this.name = 'SocketNotConnectedError';
    }
}

export class AckTimeoutError extends Error {
    /**
     * @param {string} event
     * @param {number} timeoutMs
     */
    constructor(event, timeoutMs) {
        super(`Request "${event}" timed out after ${Math.round(timeoutMs / 1000)}s`);
        this.name = 'AckTimeoutError';
    }
}

export class AckDisconnectError extends Error {
    /**
     * @param {string} event
     * @param {unknown} reason
     */
    constructor(event, reason) {
        super(`Connection lost while waiting for "${event}" (${String(reason)})`);
        this.name = 'AckDisconnectError';
    }
}

/** @param {unknown} err */
export const isSocketNotConnectedError = (err) => err instanceof SocketNotConnectedError;
/** @param {unknown} err */
export const isAckTimeoutError = (err) => err instanceof AckTimeoutError;
/** @param {unknown} err */
export const isAckDisconnectError = (err) => err instanceof AckDisconnectError;

/**
 * @typedef {object} AckSocket
 * @property {boolean} connected
 * @property {(event: string, ...args: any[]) => unknown} emit
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} [on]
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} [off]
 */

/**
 * @typedef {Promise<any> & { onAnswer: (listener: (answer: any) => void) => AnsweredRequest }} AnsweredRequest
 * The request's promise. `onAnswer(listener)` (it returns the same promise)
 * registers a listener that gets the answer in the answer's own dispatch, before
 * the events that follow it on the connection and before anything awaiting the
 * promise. It is not called for an answer that comes after the request settled
 * (timed out, disconnected). A listener must not throw.
 */

/**
 * Emits `event` once and resolves with the raw acknowledgement.
 *
 * The emit happens before this returns (the promise executor runs at once), so
 * a caller can record what it is about to send in the same synchronous block.
 *
 * @param {AckSocket} socket
 * @param {string} event
 * @param {unknown} [payload]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {AnsweredRequest}
 */
export function emitWithTimedAck(socket, event, payload = {}, { timeoutMs = DEFAULT_ACK_TIMEOUT_MS } = {}) {
    /** @type {Array<(answer: any) => void>} */
    const answerListeners = [];
    const request = new Promise((resolve, reject) => {
        if (!socket || socket.connected !== true) {
            reject(new SocketNotConnectedError(event));
            return;
        }

        let settled = false;
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;

        const finish = () => {
            settled = true;
            clearTimeout(timer);
            socket.off?.('disconnect', onDisconnect);
        };
        const onDisconnect = (/** @type {unknown} */ reason) => {
            if (settled) return;
            finish();
            reject(new AckDisconnectError(event, reason));
        };

        timer = setTimeout(() => {
            if (settled) return;
            finish();
            reject(new AckTimeoutError(event, timeoutMs));
        }, timeoutMs);
        socket.on?.('disconnect', onDisconnect);

        try {
            socket.emit(event, payload, (/** @type {unknown} */ response) => {
                if (settled) return;
                finish();
                resolve(response);
                for (const listener of answerListeners) listener(response);
            });
        } catch (err) {
            if (settled) return;
            finish();
            reject(err);
        }
    });
    /** @type {AnsweredRequest} */
    const answered = Object.assign(request, {
        /** @param {(answer: any) => void} listener */
        onAnswer(listener) {
            answerListeners.push(listener);
            return answered;
        },
    });
    return answered;
}
