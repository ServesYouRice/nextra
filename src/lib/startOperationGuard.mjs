// @ts-check

// HostView's Start Sharing runs many awaits (capture picker, room request,
// transport, producers, OBS auto-configuration), and the session can be torn
// down or a newer Start can begin during any of them. Each start is an
// operation with an id. After every await the operation asks whether it is
// still current. A stale one releases what it acquired itself and touches
// nothing a successor may own.
//
// Two effects are shared rather than per operation: host-stopped acts on
// whatever room the socket hosts, and the OBS stop acts on OBS's single
// output. A stale operation may send them only while no other start operation
// owns the session (activeOperation is empty) and the teardown was not a
// reload-preserving pagehide. Room requests (leave-room, create-room) run in
// start order, so a stale operation's compensating host-stopped is on the
// socket before a successor's room request (socket.io keeps emit order).
//
// No React here: HostView holds one guard per socket, and the unit tests drive
// the same code with deterministic promises.

/** Teardown reason of a pagehide that keeps the room for reload recovery. */
export const RELOAD_PRESERVE = 'reload-preserve';
/** Reason recorded for an operation replaced by a newer begin(). */
export const SUPERSEDED = 'superseded';

/**
 * @typedef {object} OperationRecord
 * @property {string | null} staleReason Why the operation stopped being current.
 * @property {'none' | 'pending' | 'settled'} roomRequest
 * @property {Promise<void>} prior Settles once every earlier operation's room request has.
 * @property {Promise<void>} settled This operation's own room settle.
 * @property {() => void} resolveSettled
 * @property {boolean} isSettled
 */

/**
 * @param {object} [options]
 * @param {number} [options.settleTimeoutMs] Upper bound on waiting for an
 *   earlier operation's room request; Infinity waits for it to settle.
 * @param {(callback: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(handle: unknown) => void} [options.clearTimer]
 */
export function createStartOperationGuard({
    settleTimeoutMs = Infinity,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (handle) => clearTimeout(/** @type {any} */ (handle)),
} = {}) {
    let latest = 0;
    /** @type {number | null} */
    let activeOperation = null;
    /** @type {string | null} */
    let lastReason = null;
    let newestRoomRequest = 0;
    /** @type {Promise<void>} */
    let roomTail = Promise.resolve();
    /** @type {Map<number, OperationRecord>} */
    const records = new Map();

    /** @param {OperationRecord} record */
    const settle = (record) => {
        record.roomRequest = 'settled';
        if (record.isSettled) return;
        record.isSettled = true;
        record.resolveSettled();
    };

    /** @param {number} op @param {string} reason */
    const markStale = (op, reason) => {
        const record = records.get(op);
        if (!record || record.staleReason !== null) return;
        record.staleReason = reason;
        // A stale operation never sends a room request, so one that has not
        // sent it yet has nothing a successor needs to wait for.
        if (record.roomRequest === 'none') settle(record);
    };

    return {
        /** Start an operation; it owns the host session until invalidated or superseded. */
        begin() {
            if (activeOperation !== null) markStale(activeOperation, SUPERSEDED);
            latest += 1;
            const op = latest;
            /** @type {() => void} */
            let resolveSettled = () => {};
            /** @type {Promise<void>} */
            const settled = new Promise((resolve) => { resolveSettled = resolve; });
            const prior = roomTail;
            roomTail = Promise.all([prior, settled]).then(() => {});
            records.set(op, {
                staleReason: null,
                roomRequest: 'none',
                prior,
                settled,
                resolveSettled,
                isSettled: false,
            });
            activeOperation = op;
            return op;
        },

        /** @param {number} op */
        isCurrent(op) {
            return op === latest;
        },

        /**
         * End the current operation, if any: every pending continuation is
         * stale from here on, and no operation owns the session.
         * @param {string} [reason]
         */
        invalidate(reason = 'teardown') {
            lastReason = reason;
            if (activeOperation !== null) markStale(activeOperation, reason);
            latest += 1;
            activeOperation = null;
        },

        /** The operation that owns the socket's host session and the OBS output, or null. */
        get activeOperation() {
            return activeOperation;
        },

        /** @param {number} op */
        staleReason(op) {
            return records.get(op)?.staleReason ?? null;
        },

        /**
         * Whether a stale operation may send host-stopped or stop OBS: only when
         * no other operation owns the session and neither its own teardown nor
         * the latest one kept the room for reload recovery.
         * @param {number} op
         */
        mayCompensateShared(op) {
            const record = records.get(op);
            if (!record || op === latest) return false;
            if (activeOperation !== null) return false;
            return record.staleReason !== RELOAD_PRESERVE && lastReason !== RELOAD_PRESERVE;
        },

        /**
         * Resolves true once every earlier operation's room request has settled
         * (and any compensation it sent is on the socket), or false when the
         * bound ran out first.
         * @param {number} op
         * @returns {Promise<boolean>}
         */
        awaitPriorRoomSettle(op) {
            const record = records.get(op);
            if (!record) return Promise.resolve(true);
            if (!Number.isFinite(settleTimeoutMs)) return record.prior.then(() => true);
            return new Promise((resolve) => {
                const timer = setTimer(() => resolve(false), settleTimeoutMs);
                record.prior.then(() => {
                    clearTimer(timer);
                    resolve(true);
                });
            });
        },

        /**
         * Mark the operation's room request as in flight. Refused (false) for a
         * stale operation, which must not send one.
         * @param {number} op
         */
        claimRoomRequest(op) {
            const record = records.get(op);
            if (!record || op !== latest || record.roomRequest !== 'none') return false;
            record.roomRequest = 'pending';
            newestRoomRequest = Math.max(newestRoomRequest, op);
            return true;
        },

        /**
         * The operation's room request is over and any compensation is sent;
         * later operations may send theirs. Idempotent.
         * @param {number} op
         */
        settleRoom(op) {
            const record = records.get(op);
            if (record) settle(record);
        },

        /** @param {number} op */
        roomSettled(op) {
            return records.get(op)?.settled ?? Promise.resolve();
        },

        /**
         * Whether a later operation already sent its room request, which the
         * ordering should rule out unless the settle bound ran out.
         * @param {number} op
         */
        roomRequestOvertaken(op) {
            return newestRoomRequest > op;
        },
    };
}

/** @typedef {ReturnType<typeof createStartOperationGuard>} StartOperationGuard */

/** @type {WeakMap<object, StartOperationGuard>} */
const guardsByKey = new WeakMap();

/**
 * One guard per host socket, kept across HostView unmount and remount: a start
 * left pending by an unmounted view still shares the socket with the next one.
 * @param {object} key
 * @param {Parameters<typeof createStartOperationGuard>[0]} [options] Used when the guard is created.
 */
export function startOperationGuardFor(key, options) {
    let guard = guardsByKey.get(key);
    if (!guard) {
        guard = createStartOperationGuard(options);
        guardsByKey.set(key, guard);
    }
    return guard;
}

/**
 * @typedef {object} StopTrackLike
 * @property {() => void} stop
 * @typedef {object} StreamLike
 * @property {() => StopTrackLike[]} getTracks
 * @typedef {object} ClosableLike
 * @property {() => void} close
 */

/**
 * One start operation: begins it on the guard, tracks the capture, transports
 * and producers it acquires, and gives its continuations one stale exit.
 * @param {StartOperationGuard} guard
 * @param {object} effects
 * @param {() => void} effects.emitHostStopped Send host-stopped on the socket.
 * @param {() => void} [effects.stopObsOutput] The stopObsStream fallback.
 * @param {(message: string) => void} [effects.escalate] Reports a state the ordering should rule out.
 */
export function createStartAttempt(guard, {
    emitHostStopped,
    stopObsOutput = () => {},
    escalate = () => {},
}) {
    const op = guard.begin();
    /** @type {StreamLike[]} */
    const streams = [];
    /** @type {ClosableLike[]} */
    const closables = [];
    let createdRoom = false;
    let obsConfigureStarted = false;
    let abandoned = false;

    const releaseOwnResources = () => {
        for (const resource of closables.splice(0).reverse()) {
            try { resource.close(); } catch { /* already closed */ }
        }
        for (const stream of streams.splice(0)) {
            for (const track of stream.getTracks()) {
                try { track.stop(); } catch { /* already stopped */ }
            }
        }
    };

    /**
     * Call after every await. False while the operation is current. Otherwise
     * (once) release what this operation acquired, compensate on shared state
     * only where no successor exists, settle its room request after that, and
     * return true: the caller returns without touching refs or state.
     */
    const abandonIfStale = () => {
        if (guard.isCurrent(op)) return false;
        if (abandoned) return true;
        abandoned = true;
        releaseOwnResources();
        if (guard.mayCompensateShared(op)) {
            if (obsConfigureStarted) stopObsOutput();
            if (createdRoom) emitHostStopped();
        }
        guard.settleRoom(op);
        return true;
    };

    return {
        op,
        isCurrent: () => guard.isCurrent(op),
        abandonIfStale,
        /** @template {StreamLike} T @param {T} stream @returns {T} */
        ownStream(stream) {
            streams.push(stream);
            return stream;
        },
        /** @template {ClosableLike} T @param {T} resource @returns {T} */
        own(resource) {
            closables.push(resource);
            return resource;
        },
        /** Configuring OBS may leave its single output streaming. */
        obsConfigureStarted() {
            obsConfigureStarted = true;
        },
        /**
         * The room step. Waits until every earlier start's room request has
         * settled, then sends leave-room and create-room unless the operation
         * went stale first. Without `create` (a resumed room) nothing is sent.
         * A create-room rejection propagates; the caller's catch and finally
         * deal with it.
         * @template R
         * @param {{ leave?: () => Promise<unknown>, create?: () => Promise<R> }} [requests]
         * @returns {Promise<{ stale: true } | { stale: false, room: R | null }>}
         */
        async requestRoom({ leave, create } = {}) {
            if (!(await guard.awaitPriorRoomSettle(op))) {
                escalate('An earlier start\'s room request did not settle within its timeout; continuing without it.');
            }
            if (abandonIfStale()) return { stale: true };
            if (!create) {
                guard.settleRoom(op);
                return { stale: false, room: null };
            }
            guard.claimRoomRequest(op);
            if (leave) {
                try { await leave(); } catch { /* best effort */ }
                if (abandonIfStale()) return { stale: true };
            }
            const room = await create();
            createdRoom = true;
            if (guard.roomRequestOvertaken(op)) {
                // Only a successor whose settle wait ran out can get here. Its
                // room request may already have replaced this room on the
                // server, and a host-stopped now could end the successor's.
                escalate('A start that was torn down received its room after a newer start had sent its room request.');
            }
            if (abandonIfStale()) return { stale: true };
            guard.settleRoom(op);
            return { stale: false, room };
        },
        /** Settle the room request on every exit path; idempotent. */
        settleRoom() {
            guard.settleRoom(op);
        },
    };
}
