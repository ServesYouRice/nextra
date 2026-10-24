// @ts-check

// Ownership of a viewer playback attempt, and one recovery at a time.
//
// WatchView starts playback through one attempt at a time. Every start takes
// an id from a shared counter (activePlaybackAttemptRef); cleanupPlayback and
// every newer start move the counter on, which supersedes the attempt. After
// each await an attempt asks whether it is still current. A superseded attempt
// writes no shared ref and leaves the video element alone: it disposes only
// the resources it created itself and rejects with a SupersededAttemptError,
// which its callers ignore (the newer owner decides what the viewer sees).
//
// A start that nothing else bounds runs under withDeadline, and the wait for a
// transport's ICE connection (waitForTransportConnected) is a timed event wait
// that nothing else, such as video playback, can hold up.
//
// No React here, so the unit tests drive the same code.

export class SupersededAttemptError extends Error {
    constructor(message = 'A newer playback attempt replaced this one.') {
        super(message);
        this.name = 'SupersededAttemptError';
    }
}

/** @param {unknown} err */
export function isSupersededAttemptError(err) {
    return err instanceof SupersededAttemptError;
}

/**
 * @param {number} attemptId
 * @param {{ current: number }} attemptRef
 */
export function isAttemptCurrent(attemptId, attemptRef) {
    return attemptRef.current === attemptId;
}

/**
 * Throws a SupersededAttemptError when a newer attempt or a cleanup has moved
 * the counter on since this attempt began.
 * @param {number} attemptId
 * @param {{ current: number }} attemptRef
 */
export function assertAttemptCurrent(attemptId, attemptRef) {
    if (!isAttemptCurrent(attemptId, attemptRef)) throw new SupersededAttemptError();
}

/**
 * Begins an attempt: supersedes any older one and tracks what this one creates.
 * @param {{ current: number }} attemptRef
 */
export function beginPlaybackAttempt(attemptRef) {
    attemptRef.current += 1;
    const id = attemptRef.current;
    /** @type {Array<() => void>} */
    const disposers = [];
    let disposed = false;

    const runDisposer = (/** @type {() => void} */ dispose) => {
        try { dispose(); } catch { /* one failed release must not stop the others */ }
    };

    const attempt = {
        id,
        isCurrent: () => isAttemptCurrent(id, attemptRef),
        assertCurrent: () => assertAttemptCurrent(id, attemptRef),
        /**
         * Gives this attempt up: moves the counter on if the attempt is still the
         * current one. A newer attempt's counter value is left alone.
         */
        supersede() {
            if (isAttemptCurrent(id, attemptRef)) attemptRef.current += 1;
        },
        /**
         * Records how to release a resource this attempt created (its transport,
         * object URL, ...). Releasing must not touch shared refs. A resource
         * created after dispose() is released at once.
         * @param {() => void} dispose
         */
        own(dispose) {
            if (disposed) runDisposer(dispose);
            else disposers.push(dispose);
        },
        /** Releases this attempt's own resources, newest first, once. */
        dispose() {
            if (disposed) return;
            disposed = true;
            while (disposers.length) runDisposer(/** @type {() => void} */ (disposers.pop()));
        },
        /**
         * What the attempt's caller should see for a failure: a current attempt
         * passes its error on; a superseded one releases its own resources and
         * reports a SupersededAttemptError, whatever went wrong after it lost
         * ownership.
         * @param {unknown} err
         */
        settleFailure(err) {
            if (isAttemptCurrent(id, attemptRef)) return err;
            attempt.dispose();
            return isSupersededAttemptError(err) ? err : new SupersededAttemptError();
        },
    };
    return attempt;
}

/** @typedef {ReturnType<typeof beginPlaybackAttempt>} PlaybackAttempt */

/** The overall deadline of a playback start that has no safety timer of its own. */
export const PLAYBACK_DEADLINE_MS = 40000;

export class PlaybackDeadlineError extends Error {
    constructor(message = 'Connection timed out. Check your network or try again.') {
        super(message);
        this.name = 'PlaybackDeadlineError';
    }
}

/**
 * Runs a playback start under an overall deadline, so a start that waits on
 * something that never settles cannot hold the viewer in "Connecting..." for
 * good (handleWatch has its own 40 s timer; Try WebRTC and the recovery paths
 * do not).
 *
 * The attempt is begun here and handed to `start`, which must run as that
 * attempt: the deadline needs to know which attempt it may give up. If `start`
 * settles first, its outcome passes through. At the deadline an attempt that is
 * still current is superseded, its own resources are released, and the result
 * rejects with a PlaybackDeadlineError, which the caller reports like any
 * other failure (and cleanupPlayback releases the rest). An attempt that a
 * newer owner replaced meanwhile rejects with a SupersededAttemptError
 * instead, so the caller leaves the session to that owner. Whatever `start`
 * does after the deadline is ignored.
 *
 * @template T
 * @param {{ current: number }} attemptRef
 * @param {(attempt: PlaybackAttempt) => Promise<T>} start
 * @param {{ ms?: number, message?: string }} [options]
 * @returns {Promise<T>}
 */
export function withDeadline(attemptRef, start, { ms = PLAYBACK_DEADLINE_MS, message } = {}) {
    const attempt = beginPlaybackAttempt(attemptRef);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const owned = attempt.isCurrent();
            attempt.supersede();
            attempt.dispose();
            reject(owned ? new PlaybackDeadlineError(message) : new SupersededAttemptError());
        }, ms);

        /** @type {Promise<T>} */
        let running;
        try {
            running = Promise.resolve(start(attempt));
        } catch (err) {
            running = Promise.reject(err);
        }
        running.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

/**
 * @typedef {object} ConnectableTransport
 * @property {string} connectionState
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} off
 * @property {{ on: (event: string, listener: (...args: any[]) => void) => unknown, off: (event: string, listener: (...args: any[]) => void) => unknown }} [observer]
 */

/**
 * Waits for a mediasoup transport's ICE/DTLS connection, for at most
 * `timeoutMs`. It ends at once when the transport connects, fails or closes,
 * and a transport closed by cleanupPlayback (which supersedes the attempt
 * waiting on it) must end it too: mediasoup-client's close() changes
 * connectionState to 'closed' but emits no connectionstatechange, only the
 * transport observer's 'close'. Nothing here waits on video playback.
 *
 * @param {ConnectableTransport} transport
 * @param {{ timeoutMs: number, timeoutMessage: string, onStateChange?: (state: string) => void }} options
 * @returns {Promise<void>}
 */
export function waitForTransportConnected(transport, { timeoutMs, timeoutMessage, onStateChange }) {
    return new Promise((resolve, reject) => {
        const initial = transport.connectionState;
        if (initial === 'connected') {
            resolve();
            return;
        }
        if (initial === 'failed' || initial === 'closed') {
            reject(new Error(`WebRTC connection ${initial}.`));
            return;
        }

        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(timeoutMessage));
        }, timeoutMs);

        const cleanup = () => {
            clearTimeout(timeout);
            transport.off('connectionstatechange', onConnectionStateChange);
            transport.observer?.off('close', onClosed);
        };

        /** @param {string} state */
        const onConnectionStateChange = (state) => {
            onStateChange?.(state);
            if (state === 'connected') {
                cleanup();
                resolve();
            } else if (state === 'failed' || state === 'closed') {
                cleanup();
                reject(new Error(`WebRTC connection ${state}.`));
            }
        };

        const onClosed = () => {
            cleanup();
            reject(new Error('WebRTC connection closed.'));
        };

        transport.on('connectionstatechange', onConnectionStateChange);
        transport.observer?.on('close', onClosed);
    });
}

/**
 * One viewer recovery (transport-failed or socket reconnect) at a time.
 *
 * A trigger that arrives while a recovery runs is dropped, unless it asks for
 * a follow-up: then it replaces any follow-up already queued and runs once the
 * active recovery has settled. A reconnect asks for one, because it must rejoin
 * the room on the new socket.id; a transport failure does not, because the
 * running recovery replaces the transport anyway.
 *
 * A recovery and its follow-ups share the intent captured when the first one
 * began: by the time a follow-up runs, the first recovery's own resets have
 * changed what the refs say about the session the viewer had.
 *
 * @param {{ onError?: (err: unknown) => void }} [options]
 */
export function createRecoveryGuard({
    onError = (err) => console.error('[Nextra] Viewer recovery failed:', err),
} = {}) {
    /** @type {string | null} */
    let activeKind = null;
    /** @type {{ kind: string, task: (intent: any) => unknown } | null} */
    let followUp = null;
    /** @type {any} */
    let intent;

    /**
     * @param {string} kind
     * @param {(intent: any) => unknown} task
     */
    const drain = async (kind, task) => {
        /** @type {{ kind: string, task: (intent: any) => unknown } | null} */
        let next = { kind, task };
        try {
            while (next) {
                activeKind = next.kind;
                try {
                    await next.task(intent);
                } catch (err) {
                    onError(err);
                }
                next = followUp;
                followUp = null;
            }
        } finally {
            activeKind = null;
            intent = undefined;
        }
    };

    return {
        /** The kind of the recovery that is running, or null. */
        get activeKind() {
            return activeKind;
        },

        /** The kind of the queued follow-up, or null. */
        get followUpKind() {
            return followUp ? followUp.kind : null;
        },

        /**
         * Runs the recovery now, or queues or drops it while another one runs.
         * Resolves true once the chain this call started (with its follow-ups)
         * has settled, or false at once for a trigger that did not start.
         * @param {string} kind
         * @param {(intent: any) => unknown} task
         * @param {{ followUp?: boolean, captureIntent?: () => unknown }} [options]
         * @returns {Promise<boolean>}
         */
        run(kind, task, { followUp: wantsFollowUp = false, captureIntent } = {}) {
            if (activeKind !== null) {
                if (wantsFollowUp) followUp = { kind, task };
                return Promise.resolve(false);
            }
            intent = captureIntent ? captureIntent() : undefined;
            return drain(kind, task).then(() => true);
        },

        /** Drops a queued follow-up (the session it would resume has ended). */
        clearFollowUp() {
            followUp = null;
        },
    };
}

/** @typedef {ReturnType<typeof createRecoveryGuard>} RecoveryGuard */
