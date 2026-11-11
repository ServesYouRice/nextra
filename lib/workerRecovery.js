'use strict';

const childProcess = require('node:child_process');

// What the process does when the mediasoup worker subprocess dies.
//
// - 'ignore': the process is already stopping on purpose.
// - 'exit': the worker died during startup. Exit 1 and do not restart, so a worker
//   that cannot start never turns into a crash loop.
// - 'exit-for-supervisor': the worker died after a stable start and the operator
//   declared an external supervisor (EXTERNAL_SUPERVISOR). Exit 1 and let the
//   supervisor restart Nextra. Starting a copy here as well would leave two
//   instances once the supervisor reacts, so the two recoveries never combine.
// - 'restart': the same, with no supervisor declared. Nextra starts its own
//   replacement (see launchReplacementProcess) so a desktop user keeps a working app.
function decideWorkerDeathAction({
    isShuttingDown = false,
    uptimeSeconds = 0,
    minimumUptimeSeconds = 30,
    supervised = false,
} = {}) {
    if (isShuttingDown) return 'ignore';
    if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < minimumUptimeSeconds) return 'exit';
    return supervised ? 'exit-for-supervisor' : 'restart';
}

// Signals a POSIX original process passes on to the replacement. A terminal's Ctrl+C
// or a closed terminal reaches both processes by itself (they share a process
// group); passing them on matters for `kill <pid>` aimed at the original alone. The
// replacement treats a second stop request like the first.
const FORWARDED_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP']);

/**
 * Starts the replacement Nextra after a mediasoup worker death. The replacement is
 * an ordinary child of this process, not a detached one:
 *
 * - it shares the console: its output is the original's output (stdio is inherited,
 *   so a startup failure is printed where the user or the launcher looks), and a
 *   console Ctrl+C, Ctrl+Break or window close reaches it;
 * - this process stays alive while it runs, so the PID a launcher or supervisor
 *   tracks is still the running server, and it ends with the replacement's own exit
 *   code: a replacement that fails is reported as a failure, never as success.
 *
 * Signals sent to this process alone: on POSIX they are passed on to the
 * replacement (forwardSignal). On Windows there is no signal to pass on: Ctrl+C,
 * Ctrl+Break and a closing console window go to every process on the console, the
 * replacement included, and ending this process with TerminateProcess does not stop
 * it; use `taskkill /T` to stop the pair by PID. A SIGKILL of this process on POSIX
 * leaves the replacement running, which no code in this process can prevent.
 *
 * @param {object} options
 * @param {(code: number) => void} options.onExit Called once with the code this
 *   process should end with, when the replacement has ended.
 * @param {(err: Error) => void} options.onFailed Called once when the replacement
 *   could not be started at all.
 * @returns {{ pid: number | undefined, forwardSignal: (signal: string) => void, stop: () => void }}
 */
function launchReplacementProcess({
    onExit,
    onFailed,
    spawn = childProcess.spawn,
    execPath = process.execPath,
    args = [...process.execArgv, ...process.argv.slice(1)],
    cwd = process.cwd(),
    env = process.env,
    platform = process.platform,
    ownPid = process.pid,
    log = console,
} = {}) {
    if (typeof onExit !== 'function') throw new TypeError('onExit must be a function');
    if (typeof onFailed !== 'function') throw new TypeError('onFailed must be a function');

    let started = false;
    let ended = false;

    const failed = (err) => {
        if (ended) return;
        ended = true;
        log.error(`[recovery] Failed to relaunch automatically: ${err?.message || err}`);
        onFailed(err);
    };

    let replacement;
    try {
        replacement = spawn(execPath, args, { cwd, env, stdio: 'inherit' });
    } catch (err) {
        failed(err);
        return { pid: undefined, forwardSignal() {}, stop() {} };
    }

    replacement.once('spawn', () => {
        started = true;
        log.warn(`[recovery] Started replacement Nextra (PID ${replacement.pid}). This process (PID ${ownPid}) stays until it ends and exits with its exit code.`);
    });
    replacement.once('error', (err) => {
        if (!started) {
            failed(err);
            return;
        }
        log.error(`[recovery] Replacement Nextra (PID ${replacement.pid}) reported an error: ${err?.message || err}`);
    });
    replacement.once('exit', (code, signal) => {
        if (ended) return;
        ended = true;
        const exitCode = (signal || !Number.isInteger(code)) ? 1 : code;
        if (exitCode === 0) {
            log.log(`[recovery] Replacement Nextra (PID ${replacement.pid}) exited normally.`);
        } else {
            const how = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
            log.error(`[recovery] Replacement Nextra (PID ${replacement.pid}) ${how}; exiting with code ${exitCode}.`);
        }
        onExit(exitCode);
    });

    return {
        pid: replacement.pid,
        forwardSignal(signal) {
            if (ended || platform === 'win32') return;
            try { replacement.kill(FORWARDED_SIGNALS.has(signal) ? signal : 'SIGTERM'); } catch { }
        },
        // Ends the replacement because this process has to end first (a fatal
        // error), so no unattended second instance is left behind.
        stop() {
            if (ended) return;
            try { replacement.kill('SIGTERM'); } catch { }
        },
    };
}

module.exports = { decideWorkerDeathAction, launchReplacementProcess };
