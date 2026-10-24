// Reload recovery on the host page: after a reload, HostView reclaims the room
// kept in sessionStorage ({ code, hostToken, ingestMode }). The server holds the
// room for HOST_RECONNECT_GRACE_MS (30 s by default) after the old page's socket
// went away, so a failed reclaim is retried inside that window and the session
// is ended only when the failure is final. No React and no socket here: HostView
// supplies the request, the cancel flag and the timer.

/** How long a reload's reclaim keeps trying, from its first attempt. The room is held for 30 s from the old page's disconnect, and the reload itself has used some of that. */
export const RECLAIM_RETRY_WINDOW_MS = 25_000;
/** Longest one attempt waits for the socket to connect, and again for the acknowledgement. */
export const RECLAIM_ATTEMPT_TIMEOUT_MS = 5_000;
/** Shortest timeout handed to an attempt near the end of the window (socketRequest treats 0 as "use the default"). */
export const RECLAIM_MIN_ATTEMPT_TIMEOUT_MS = 1_000;
export const RECLAIM_MAX_ATTEMPTS = 10;
const RECLAIM_FIRST_DELAY_MS = 500;
const RECLAIM_MAX_DELAY_MS = 4_000;

/**
 * Whether a failed reclaim-host ends the session ('terminal') or may be tried
 * again ('transient').
 *
 * The server tags every rejection that means the room is gone (invalid
 * parameters, reload recovery not enabled, room not found or token invalid)
 * with `terminal: true`. Timeouts, a socket that never connected, a connection
 * lost after the emit, an 'Internal error' answer and anything unrecognised
 * carry no such flag: they say nothing about the room, so they are transient.
 * This is the same rule onReconnect applies (`err.terminal === true`).
 *
 * @param {unknown} err
 * @returns {'terminal' | 'transient'}
 */
export function classifyReclaimFailure(err) {
    return /** @type {any} */ (err)?.terminal === true ? 'terminal' : 'transient';
}

/**
 * After the reclaim of a stored room finally failed: whether OBS may still be
 * streaming at that room and needs a stop. A pagehide that keeps the room for
 * recovery deliberately leaves OBS running and records the ingest mode, but a
 * fresh page starts with ingest mode 'browser', so the stored value is the only
 * place that says OBS was in use.
 *
 * @param {{ ingestMode?: unknown } | null | undefined} stored
 */
export function shouldStopObsAfterFailedReclaim(stored) {
    return stored?.ingestMode === 'obs';
}

/**
 * Pause before the next attempt, after `failedAttempts` failures: 0.5 s, 1 s,
 * 2 s, then 4 s.
 *
 * @param {number} failedAttempts
 */
export function reclaimRetryDelayMs(failedAttempts) {
    const doublings = Math.max(0, failedAttempts - 1);
    return Math.min(RECLAIM_FIRST_DELAY_MS * (2 ** doublings), RECLAIM_MAX_DELAY_MS);
}

/**
 * A pause that can be cut short. cancel() clears the timer and wakes the
 * waiter at once, so a retry loop that was sleeping when the effect was cleaned
 * up notices the cancellation instead of holding a timer open.
 *
 * @param {object} [timers]
 * @param {(callback: () => void, ms: number) => unknown} [timers.setTimer]
 * @param {(handle: unknown) => void} [timers.clearTimer]
 */
export function createCancellableWait({
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (handle) => clearTimeout(/** @type {any} */ (handle)),
} = {}) {
    /** @type {Set<() => void>} */
    const pending = new Set();
    return {
        /** @param {number} ms @returns {Promise<void>} */
        wait(ms) {
            return new Promise((resolve) => {
                const finish = () => {
                    pending.delete(finish);
                    clearTimer(timer);
                    resolve();
                };
                const timer = setTimer(finish, ms);
                pending.add(finish);
            });
        },
        cancel() {
            for (const finish of [...pending]) finish();
        },
        /** Timers still waiting; zero once everything has fired or been cancelled. */
        get pendingCount() {
            return pending.size;
        },
    };
}

/**
 * @typedef {object} ReclaimAttemptOptions
 * @property {number} timeoutMs Acknowledgement timeout for this attempt.
 * @property {number} connectTimeoutMs How long this attempt waits for a disconnected socket to connect.
 * @property {number} maxAttempts Always 1: the retrying is done here, within the window.
 */

/**
 * @typedef {{ status: 'reclaimed', response: any, attempts: number }
 *   | { status: 'cancelled', attempts: number }
 *   | { status: 'gave-up', attempts: number }
 *   | { status: 'failed', error: unknown, terminal: boolean, attempts: number }} ReclaimOutcome
 */

/**
 * Reclaim the stored room, retrying transient failures with a growing pause
 * until the window or the attempt bound runs out. A terminal failure returns at
 * once. `request` should be socketRequest with these options: it waits for the
 * socket to connect when it is down.
 *
 * `isCancelled` is the effect's cleanup flag: nothing more is sent after it,
 * and whatever a request in flight returns is ignored. `shouldGiveUp` is
 * checked only before an attempt and before a pause (the host started a room of
 * their own, which retrying must not disturb); a response that arrives is still
 * delivered.
 *
 * @param {object} options
 * @param {(attempt: ReclaimAttemptOptions) => Promise<any>} options.request
 * @param {() => boolean} options.isCancelled
 * @param {(ms: number) => Promise<void>} options.wait
 * @param {() => boolean} [options.shouldGiveUp]
 * @param {() => number} [options.now]
 * @param {number} [options.windowMs]
 * @param {number} [options.attemptTimeoutMs]
 * @param {number} [options.maxAttempts]
 * @param {(failedAttempts: number) => number} [options.delayMs]
 * @param {(attempts: number, error: unknown) => void} [options.onRetry]
 * @returns {Promise<ReclaimOutcome>}
 */
export async function reclaimWithRetry({
    request,
    isCancelled,
    wait,
    shouldGiveUp = () => false,
    now = Date.now,
    windowMs = RECLAIM_RETRY_WINDOW_MS,
    attemptTimeoutMs = RECLAIM_ATTEMPT_TIMEOUT_MS,
    maxAttempts = RECLAIM_MAX_ATTEMPTS,
    delayMs = reclaimRetryDelayMs,
    onRetry = () => {},
}) {
    const deadline = now() + windowMs;
    let attempts = 0;
    for (;;) {
        if (isCancelled()) return { status: 'cancelled', attempts };
        if (attempts > 0 && shouldGiveUp()) return { status: 'gave-up', attempts };

        // The last attempts get what is left of the window, never less than a
        // second and never more than a normal attempt.
        const timeoutMs = Math.min(
            attemptTimeoutMs,
            Math.max(RECLAIM_MIN_ATTEMPT_TIMEOUT_MS, deadline - now()),
        );
        attempts += 1;
        try {
            const response = await request({ timeoutMs, connectTimeoutMs: timeoutMs, maxAttempts: 1 });
            if (isCancelled()) return { status: 'cancelled', attempts };
            return { status: 'reclaimed', response, attempts };
        } catch (error) {
            if (isCancelled()) return { status: 'cancelled', attempts };
            if (classifyReclaimFailure(error) === 'terminal') {
                return { status: 'failed', error, terminal: true, attempts };
            }
            const pause = delayMs(attempts);
            if (attempts >= maxAttempts || now() + pause >= deadline) {
                return { status: 'failed', error, terminal: false, attempts };
            }
            onRetry(attempts, error);
            if (shouldGiveUp()) return { status: 'gave-up', attempts };
            await wait(pause);
        }
    }
}

/**
 * The steps of a Start (or Resume) Sharing, in order. A failure is attributed
 * to the step it happened in.
 * - preflight: the TURN form and the preflight blockers
 * - capture: the screen picker and installing its stream
 * - room: creating the room, or taking over the reclaimed one
 * - media: send transport and producers
 * - obs: OBS auto-configuration
 */
export const START_PHASES = Object.freeze({
    PREFLIGHT: 'preflight',
    CAPTURE: 'capture',
    ROOM: 'room',
    MEDIA: 'media',
    OBS: 'obs',
});

/**
 * Whether a failed start ends the room (host-stopped and the full cleanup).
 *
 * A fresh room always is. A room reclaimed after a reload is the one viewers
 * are waiting in, and until the start has taken it over nothing of it is in
 * use: a preflight blocker or a cancelled or failed picker gives back only the
 * capture, and the room, its token and the stored record stay for another
 * Resume Sharing. From the room step on, a failure ends it as before.
 *
 * @param {{ resumed: boolean, phase: string | undefined }} failure
 */
export function shouldTeardownAfterStartFailure({ resumed, phase }) {
    if (!resumed) return true;
    return phase !== START_PHASES.PREFLIGHT && phase !== START_PHASES.CAPTURE;
}

/**
 * The ingest mode of a room reclaimed after a reload, from the server's
 * reclaim-host answer. The server keeps a room's mode for its lifetime.
 *
 * @param {{ ingestMode?: unknown } | null | undefined} room
 * @returns {'obs' | 'browser'}
 */
export function recoveredRoomIngestMode(room) {
    return room?.ingestMode === 'obs' ? 'obs' : 'browser';
}

/**
 * Whether `ingestMode` differs from the mode of the reclaimed room that waits
 * for Resume Sharing. Resuming reuses that room without a create-room, so the
 * server would never hear of another mode; with no room waiting, any mode is
 * fine for the next fresh room.
 *
 * @param {{ recoveredRoom: { ingestMode?: unknown } | null | undefined, ingestMode: string }} state
 */
export function isIngestModeMismatch({ recoveredRoom, ingestMode }) {
    return recoveredRoom != null && recoveredRoomIngestMode(recoveredRoom) !== ingestMode;
}
