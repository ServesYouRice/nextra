// @ts-check

// Which viewer session a room join belongs to.
//
// WatchView's joins (the Join button, and the rejoin after a socket reconnect)
// each begin a session; Leave Room, a terminal transport failure, a room that
// ended and the view unmounting end it. A join checks after every await that
// its session is still the current one, and commits no ref or state otherwise,
// so a stale completion cannot put the viewer back in a room it has left or
// start playback there. (Playback attempts have their own ownership, see
// playbackAttempt.mjs; this one is about the room membership they run in.)
//
// The server keeps one room per socket, so the one thing a stale join may
// still do is undo its own join-room (abandonStaleJoin).
//
// No React here, so the unit tests drive the same code.

export class StaleViewerSessionError extends Error {
    constructor(message = 'The viewer session this join belonged to has ended.') {
        super(message);
        this.name = 'StaleViewerSessionError';
    }
}

/** @param {unknown} err */
export function isStaleViewerSessionError(err) {
    return err instanceof StaleViewerSessionError;
}

export function createViewerSession() {
    // Moves on for every begin and every end of a session.
    let generation = 0;
    // The generation of the latest begin(); an end moves `generation` past it.
    let latestJoin = 0;
    // The view is gone: the socket may belong to someone else now.
    let closed = false;

    /** @param {number} joinGeneration */
    const tokenFor = (joinGeneration) => ({
        generation: joinGeneration,
        isCurrent: () => generation === joinGeneration,
        /** Throws a StaleViewerSessionError once this session has ended or a newer one began. */
        assertCurrent() {
            if (generation !== joinGeneration) throw new StaleViewerSessionError();
        },
        /** Whether a join began after this session did. */
        hasNewerJoin: () => latestJoin > joinGeneration,
        /**
         * Whether this session, if it has ended, may still undo its join on the
         * server: no join began after it (the server's one room per socket now
         * belongs to that join) and the view is still there.
         */
        mayUndoJoin: () => generation !== joinGeneration && latestJoin === joinGeneration && !closed,
    });

    return {
        /** Starts a session; every earlier one is stale from now on. */
        begin() {
            generation += 1;
            latestJoin = generation;
            closed = false;
            return tokenFor(generation);
        },

        /** Ends the session in progress (Leave Room, a room that ended, ...) so its pending joins go stale. */
        invalidate() {
            generation += 1;
        },

        /** Ends it for good: the view is unmounting and takes no part in the socket from here. */
        close() {
            generation += 1;
            closed = true;
        },

        /** Whether a session has begun and nothing has ended it since. */
        get active() {
            return latestJoin !== 0 && generation === latestJoin;
        },

        /**
         * The session in progress, for work that runs inside it without having
         * begun it (the relay fallback start asks at entry), or null when none is.
         */
        current() {
            return latestJoin !== 0 && generation === latestJoin ? tokenFor(generation) : null;
        },
    };
}

/** @typedef {ReturnType<typeof createViewerSession>} ViewerSession */
/** @typedef {ReturnType<ViewerSession['begin']>} ViewerSessionToken */

/**
 * What a join does when it finds its session over: it asks the server to drop
 * the viewer it may have put in the room, and returns the error to throw.
 *
 * The leave is sent only when the server may hold the viewer (the join-room
 * was not refused) and no newer join began since the session ended: the server
 * has one room per socket, so a leave then could remove the newer join.
 *
 * @param {ViewerSessionToken} token
 * @param {{ mayBeInRoom: boolean, leaveRoom: () => void }} options
 * @returns {StaleViewerSessionError}
 */
export function abandonStaleJoin(token, { mayBeInRoom, leaveRoom }) {
    if (mayBeInRoom && token.mayUndoJoin()) {
        try { leaveRoom(); } catch { /* the socket went away: so did its room membership */ }
    }
    return new StaleViewerSessionError();
}
