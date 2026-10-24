'use strict';

// Decides how the process ends. Two kinds of stop go through one coordinator and
// one exit funnel:
//
// - graceful: a signal or the test endpoint. Rooms are told the server stopped,
//   resources are released, the listener closes, and the process exits 0.
// - fatal: an uncaught exception or unhandled rejection. Rooms are told the server
//   stopped unexpectedly, resources are released, and the process exits 1 for an
//   external supervisor to restart.
//
// A fatal error that arrives while a graceful shutdown is running takes over: it
// releases what is left and exits 1 at once. A graceful shutdown that throws turns
// into the same fatal path. Both kinds arm a force-exit timer before anything that
// can throw or wait, so no ordering of errors and signals leaves the process alive
// and half torn down. The side effects are injected so the ordering can be tested
// without ending the test process.

const PHASE_RUNNING = 'running';
const PHASE_GRACEFUL = 'graceful';
const PHASE_FATAL = 'fatal';

const DEFAULT_FLUSH_MS = 150;
const DEFAULT_FORCE_EXIT_MS = 5000;

/**
 * @param {object} options
 * @param {(kind: 'graceful' | 'fatal') => boolean | void} [options.notifyRoomsEnded]
 *   Tells connected clients their room ended. Returns true when it sent something,
 *   so the coordinator waits flushMs for it to leave before it tears down.
 * @param {() => void} [options.onShutdownStart] Runs once when either phase begins
 *   (readiness goes false).
 * @param {() => void} options.cleanup Releases process-wide resources. It may be
 *   called more than once.
 * @param {(onClosed: () => void) => void} options.closeServer Stops the listener and
 *   calls onClosed when it has closed.
 * @param {(code: number) => void} options.exit Ends the process.
 * @param {(callback: () => void, ms: number) => unknown} [options.setTimer]
 * @param {{ log: Function, error: Function }} [options.log]
 * @param {number} [options.flushMs]
 * @param {number} [options.gracefulForceExitMs]
 * @param {number} [options.fatalForceExitMs]
 */
function createShutdownCoordinator({
    notifyRoomsEnded = () => false,
    onShutdownStart = () => {},
    cleanup,
    closeServer,
    exit,
    setTimer = setTimeout,
    log = console,
    flushMs = DEFAULT_FLUSH_MS,
    gracefulForceExitMs = DEFAULT_FORCE_EXIT_MS,
    fatalForceExitMs = DEFAULT_FORCE_EXIT_MS,
} = {}) {
    if (typeof cleanup !== 'function') throw new TypeError('cleanup must be a function');
    if (typeof closeServer !== 'function') throw new TypeError('closeServer must be a function');
    if (typeof exit !== 'function') throw new TypeError('exit must be a function');

    let phase = PHASE_RUNNING;
    let exitRequested = false;
    let roomsNotified = false;

    const describe = (err) => err?.stack || err?.message || err;
    const sleep = (ms) => new Promise((resolve) => { setTimer(resolve, ms); });

    // The only place the process is ended. It runs once, and a fatal phase always
    // wins: a late "exit 0" from the graceful path becomes exit 1.
    function finish(code) {
        if (exitRequested) return;
        exitRequested = true;
        exit(phase === PHASE_FATAL ? 1 : code);
    }

    function runCleanup() {
        try {
            cleanup();
        } catch (err) {
            log.error('[fatal] Cleanup failed:', describe(err));
        }
    }

    function startShutdown() {
        try {
            onShutdownStart();
        } catch (err) {
            log.error('[fatal] Shutdown start hook failed:', describe(err));
        }
    }

    /**
     * A fatal error: tell rooms (when they were not told already), release
     * resources and exit 1. Never throws on its own failures. It ends the process
     * even when it arrives in the middle of a graceful shutdown.
     * @param {string} reason
     */
    async function requestFatal(reason) {
        if (phase === PHASE_FATAL) return;
        phase = PHASE_FATAL;
        // Armed before the first await, and independent of everything below.
        setTimer(() => finish(1), fatalForceExitMs);
        startShutdown();

        // A graceful shutdown has told the rooms already; do not wait for a second
        // notice, or for the rest of its own flush.
        if (!roomsNotified) {
            try {
                if (notifyRoomsEnded('fatal')) {
                    roomsNotified = true;
                    await sleep(flushMs);
                }
            } catch (err) {
                log.error('[fatal] Could not tell rooms the server stopped:', describe(err));
            }
        }

        runCleanup();
        log.error(`[fatal] exiting after ${reason}; an external supervisor must restart Nextra.`);
        finish(1);
    }

    /**
     * A requested stop (signal, test endpoint). Resolves once the shutdown has been
     * set up; the exit itself comes from the listener closing or the force timer.
     * An error inside it is handled as a fatal error, so this does not reject.
     * @param {string} signal
     */
    async function requestGraceful(signal) {
        if (phase !== PHASE_RUNNING) return;
        phase = PHASE_GRACEFUL;
        // Armed before the first await, and before anything that can throw: if the
        // listener never closes (open sockets, the prewarmed relay) or a step below
        // fails, the process still ends. An intentional stop exits 0; a non-zero
        // code is misreported as a startup failure.
        setTimer(() => finish(0), gracefulForceExitMs);

        try {
            startShutdown();
            log.log(`\n${signal} received. Shutting down gracefully...`);
            if (notifyRoomsEnded('graceful')) {
                roomsNotified = true;
                await sleep(flushMs);
            }
            // A fatal error that arrived while rooms were being flushed has already
            // cleaned up and ended the process.
            if (phase !== PHASE_GRACEFUL) return;
            cleanup();
            closeServer(() => {
                log.log('Server closed.');
                finish(0);
            });
        } catch (err) {
            log.error('[fatal] Graceful shutdown failed:', describe(err));
            await requestFatal('graceful-shutdown-failed');
        }
    }

    return {
        requestGraceful,
        requestFatal,
        getPhase: () => phase,
        isShuttingDown: () => phase !== PHASE_RUNNING,
    };
}

module.exports = { createShutdownCoordinator };
