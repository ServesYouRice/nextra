// @ts-check

// OBS has one stream output, and a host page drives it over obs-websocket from
// several places: the configure of Start Sharing and of Retry Auto-Configure,
// and the stop of every teardown. Each of them takes its own connection, so
// two of them running at once interleave on OBS: a stop sent while a configure
// runs lands before that configure's start-stream step, and the configure of a
// session that was already torn down can overwrite a newer session's target.
//
// So every one of them (apart from the stop frame an unloading page writes on
// its open control channel, which cannot wait) runs here, one at a time, in
// the order they were asked for. The queue also records which session owns
// OBS's output: a session's configure claims it when it begins, and a stop
// gives it back. A stop sent on behalf of a session that no longer owns the
// output would stop whatever a newer session started, so the record is
// checked when the stop runs, not when it was asked for.
//
// Sessions are named by tokens the caller compares with `isCurrent`; HostView
// uses its start-operation ids (src/lib/startOperationGuard.mjs). The module
// has no React and no OBS code: HostView hands in the OBS calls, and the unit
// tests drive the same code with promises they settle by hand.

/**
 * @typedef {object} ObsOwnership
 * @property {unknown} owner The session whose configure claimed OBS's output, or null.
 * @property {(token: unknown) => void} claim
 * @property {(token: unknown) => boolean} release Clears the record if it names `token`.
 */

/**
 * @typedef {object} ConfigureEntry
 * @property {boolean} owesStop Its session was torn down while it was queued
 *   or running, and the teardown left its stop to it.
 */

/** @param {() => Promise<unknown>} stop */
async function stopIgnoringErrors(stop) {
    try {
        await stop();
    } catch {
        // Best effort, as every teardown stop is: OBS may be closed.
    }
}

export function createObsOperationQueue() {
    /** @type {Promise<void>} */
    let tail = Promise.resolve();
    let pending = 0;
    /** @type {unknown} */
    let owner = null;
    /** @type {Map<unknown, ConfigureEntry[]>} */
    const configures = new Map();

    /**
     * Run `operation` once every operation enqueued before it has settled. A
     * rejection reaches only this operation's caller; the next one runs anyway.
     * The ownership record can be changed only through the handle the
     * operation gets, and only until the operation settles.
     * @template T
     * @param {(ownership: ObsOwnership) => Promise<T> | T} operation
     * @returns {Promise<T>}
     */
    function enqueue(operation) {
        pending += 1;
        const run = async () => {
            let open = true;
            const assertOpen = () => {
                if (!open) throw new Error('The OBS ownership record changes only inside a running queued operation.');
            };
            /** @type {ObsOwnership} */
            const ownership = {
                get owner() { return owner; },
                claim(token) {
                    assertOpen();
                    owner = token;
                },
                release(token) {
                    assertOpen();
                    if (owner !== token) return false;
                    owner = null;
                    return true;
                },
            };
            try {
                return await operation(ownership);
            } finally {
                open = false;
                pending -= 1;
            }
        };
        const result = tail.then(run);
        tail = result.then(() => {}, () => {});
        return result;
    }

    /**
     * The stop of a teardown: sent unless a session other than `token` owns
     * OBS's output and is still live (a newer one, then). An owner that is not
     * live left the output to nobody, so the stop goes ahead and clears it.
     * @param {ObsOwnership} ownership
     * @param {{ token: unknown, isCurrent: (token: unknown) => boolean, stop: () => Promise<unknown> }} request
     */
    async function teardownStop(ownership, { token, isCurrent, stop }) {
        const holder = ownership.owner;
        if (holder !== null && holder !== token && isCurrent(holder)) return false;
        await stopIgnoringErrors(stop);
        if (holder !== null) ownership.release(holder);
        return true;
    }

    /** @param {unknown} token @param {ConfigureEntry} entry */
    function forgetConfigure(token, entry) {
        const entries = configures.get(token);
        if (!entries) return;
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
        if (entries.length === 0) configures.delete(token);
    }

    return {
        enqueue,

        /** The session whose configure claimed OBS's output, or null. */
        get owner() {
            return owner;
        },

        /** Operations queued or running. */
        get pending() {
            return pending;
        },

        /**
         * Queue a session's configure. When its turn comes it runs only if
         * the session is still current; it then claims OBS's output, awaits
         * `configure`, and checks the session again. A current session gets
         * the result; the caller goes on as before. A stale one never sees it:
         * if the session still owns the output, this operation stops OBS
         * (when `shouldCompensate(result)` says the configure may have left it
         * streaming, or when the session's teardown left its stop to this
         * operation) and gives the output back. A configure whose session
         * ended before its turn sends nothing but the stop its teardown left
         * to it, if any.
         * @template R
         * @param {object} request
         * @param {unknown} request.token The session this configure belongs to.
         * @param {(token: unknown) => boolean} request.isCurrent
         * @param {() => Promise<R>} request.configure
         * @param {(result: R | null) => boolean} [request.shouldCompensate]
         * @param {() => Promise<unknown>} request.stop
         * @param {() => void} [request.onStart] Called when its turn comes and the session is current.
         * @returns {Promise<{ stale: false, result: R } | { stale: true, result: R | null }>}
         */
        configure({ token, isCurrent, configure, shouldCompensate = () => true, stop, onStart = () => {} }) {
            /** @type {ConfigureEntry} */
            const entry = { owesStop: false };
            const entries = configures.get(token) ?? [];
            entries.push(entry);
            configures.set(token, entries);
            return enqueue(async (ownership) => {
                try {
                    if (!isCurrent(token)) {
                        if (entry.owesStop) await teardownStop(ownership, { token, isCurrent, stop });
                        return { stale: true, result: null };
                    }
                    onStart();
                    ownership.claim(token);
                    /** @type {R | null} */
                    let result = null;
                    try {
                        result = await configure();
                    } catch (error) {
                        if (isCurrent(token)) throw error;
                    }
                    if (isCurrent(token)) return { stale: false, result: /** @type {R} */ (result) };
                    if (ownership.owner === token) {
                        if (entry.owesStop || shouldCompensate(result)) await stopIgnoringErrors(stop);
                        ownership.release(token);
                    }
                    return { stale: true, result };
                } finally {
                    forgetConfigure(token, entry);
                }
            });
        },

        /**
         * A teardown of `token`'s session calls this first. While a configure
         * of that session is queued or running, its stop belongs to that
         * configure, which sends it once it has finished with OBS (a stop sent
         * now could land before the configure starts the stream): the last
         * such configure takes it over and true is returned. Otherwise false,
         * and the caller queues the stop with `stop()`.
         * @param {unknown} token
         */
        deferStopToConfigure(token) {
            const entries = configures.get(token);
            if (!entries || entries.length === 0) return false;
            entries[entries.length - 1].owesStop = true;
            return true;
        },

        /**
         * Queue a teardown stop for `token`'s session. When it runs it is sent
         * unless a newer, still live session owns OBS's output; it then gives
         * the output back. Resolves to whether the stop was sent.
         * @param {{ token: unknown, isCurrent: (token: unknown) => boolean, stop: () => Promise<unknown> }} request
         * @returns {Promise<boolean>}
         */
        stop(request) {
            return enqueue((ownership) => teardownStop(ownership, request));
        },
    };
}

/** @typedef {ReturnType<typeof createObsOperationQueue>} ObsOperationQueue */

/**
 * The page's one queue. Module scope, so that a host view that unmounted while
 * its configure ran still orders that configure, and its stop, before the
 * next host view's.
 */
export const obsOperationQueue = createObsOperationQueue();
