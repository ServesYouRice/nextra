'use strict';

// Decides how the process ends. Three kinds of stop go through one coordinator and
// one exit funnel:
//
// - graceful: a signal or the test endpoint. Rooms are told the server stopped,
//   resources are released, the listener closes, and the process exits 0.
// - fatal: an uncaught exception or unhandled rejection. Rooms are told the server
//   stopped unexpectedly, resources are released, and the process exits 1 for an
//   external supervisor to restart.
// - restart: the media worker died and no supervisor was declared. Rooms are told,
//   resources and the listener are released, a replacement process is started, and
//   this process waits for it and exits with its exit code. A stop signal during
//   that wait is passed on to the replacement.
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
const PHASE_RESTART = 'restart';

const DEFAULT_FLUSH_MS = 150;
const DEFAULT_FORCE_EXIT_MS = 5000;
// How long a restart waits for the listener to close before it starts the
// replacement anyway (an open connection can delay the close callback; the port is
// released as soon as close() is called).
const DEFAULT_RESTART_CLOSE_WAIT_MS = 2000;

/**
 * @param {object} options
 * @param {(kind: 'graceful' | 'fatal' | 'restart') => boolean | void} [options.notifyRoomsEnded]
 *   Tells connected clients their room ended. Returns true when it sent something,
 *   so the coordinator waits flushMs for it to leave before it tears down. A caller
 *   of requestFatal or requestRestart can pass its own notice (notifyRooms) instead.
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
 * @param {number} [options.restartForceExitMs] Ends the process with 1 when a
 *   restart has not started its replacement by then.
 * @param {number} [options.restartCloseWaitMs]
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
    restartForceExitMs = DEFAULT_FORCE_EXIT_MS,
    restartCloseWaitMs = DEFAULT_RESTART_CLOSE_WAIT_MS,
} = {}) {
    if (typeof cleanup !== 'function') throw new TypeError('cleanup must be a function');
    if (typeof closeServer !== 'function') throw new TypeError('closeServer must be a function');
    if (typeof exit !== 'function') throw new TypeError('exit must be a function');

    let phase = PHASE_RUNNING;
    let exitRequested = false;
    let roomsNotified = false;
    // The running replacement of a restart, and a stop requested before it started.
    let replacement = null;
    let stopRequestedDuringRestart = null;

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
     * even when it arrives in the middle of a graceful shutdown or a restart.
     * @param {string} reason
     * @param {object} [options]
     * @param {() => boolean | void} [options.notifyRooms] Tells rooms in place of
     *   the default fatal notice, and returns true when it sent something.
     */
    async function requestFatal(reason, { notifyRooms } = {}) {
        if (phase === PHASE_FATAL) return;
        phase = PHASE_FATAL;
        // Armed before the first await, and independent of everything below.
        setTimer(() => finish(1), fatalForceExitMs);
        startShutdown();
        // A replacement of a restart must not outlive this process: a supervisor
        // restarting Nextra after this exit would otherwise meet a second instance.
        try { replacement?.stop(); } catch { }

        // A graceful shutdown has told the rooms already; do not wait for a second
        // notice, or for the rest of its own flush.
        if (!roomsNotified) {
            try {
                if (notifyRooms ? notifyRooms() : notifyRoomsEnded('fatal')) {
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
        if (phase === PHASE_RESTART) {
            // Nothing of this process is left to stop: pass the request on to the
            // replacement, or, before there is one, do not start it.
            if (replacement) replacement.forwardSignal(signal);
            else stopRequestedDuringRestart = signal;
            return;
        }
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

    /**
     * The media worker died and no supervisor restarts Nextra: tell rooms, release
     * resources and the listener, start a replacement and wait for it. The process
     * ends with the replacement's exit code, with 1 if the replacement could not be
     * started, and with 1 if anything in the teardown fails (handled as a fatal
     * error). Resolves once the replacement is running or the process is ending; it
     * rejects only for a missing launcher.
     * @param {string} reason Why the restart was needed (named in a failure's log).
     * @param {object} options
     * @param {(handlers: { onExit: (code: number) => void, onFailed: (err: Error) => void }) => { forwardSignal: (signal: string) => void, stop: () => void }} options.launchReplacement
     *   Starts the replacement process.
     * @param {() => boolean | void} [options.notifyRooms] Tells rooms in place of
     *   the default notice, and returns true when it sent something.
     */
    async function requestRestart(reason, { launchReplacement, notifyRooms } = {}) {
        if (typeof launchReplacement !== 'function') throw new TypeError('launchReplacement must be a function');
        if (phase !== PHASE_RUNNING) return;
        phase = PHASE_RESTART;
        // Armed before the first await, and before anything that can throw: if the
        // teardown never gets to start the replacement, the process still ends, and
        // with a failure, because nothing is running.
        setTimer(() => { if (!replacement) finish(1); }, restartForceExitMs);

        try {
            startShutdown();
            if (notifyRooms ? notifyRooms() : notifyRoomsEnded('restart')) {
                roomsNotified = true;
                await sleep(flushMs);
            }
            // A fatal error that arrived while rooms were being flushed has taken over.
            if (phase !== PHASE_RESTART) return;
            cleanup();
            // The listener has to be closed before the replacement binds the port.
            await new Promise((resolve) => {
                setTimer(resolve, restartCloseWaitMs);
                closeServer(() => resolve());
            });
            if (phase !== PHASE_RESTART) return;
            if (stopRequestedDuringRestart) {
                log.log(`[recovery] ${stopRequestedDuringRestart} received during the restart; not starting a replacement.`);
                finish(0);
                return;
            }
            replacement = launchReplacement({
                onExit: (code) => finish(code),
                onFailed: () => finish(1),
            });
        } catch (err) {
            log.error(`[fatal] Restart after ${reason} failed:`, describe(err));
            await requestFatal('restart-failed');
        }
    }

    return {
        requestGraceful,
        requestFatal,
        requestRestart,
        getPhase: () => phase,
        isShuttingDown: () => phase !== PHASE_RUNNING,
    };
}

module.exports = { createShutdownCoordinator };
