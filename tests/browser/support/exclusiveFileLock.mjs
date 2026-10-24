// Cross-process mutual exclusion for tests/browser/media-flow.spec.mjs: those tests
// share one server and one room, so at most one of them may run at a time, across
// every Playwright worker.
//
// The lock is one file, <directory>/lock, holding the owner's record
// { pid, hostname, workerIndex, token, acquiredAt }. It is published whole: the
// record is written to a private temp file and fs.link() gives it the lock name, so
// the link fails with EEXIST while anyone holds the lock and a reader never sees a
// half-written record.
//
// A lock is taken over from its owner only when the owner is provably dead: same
// hostname and process.kill(pid, 0) fails with ESRCH. Age never counts, so a
// holder that is merely slow keeps its lock. An unreadable record, another host,
// EPERM, or any other doubt means "alive": acquisition then stalls, and the bounded
// wait turns the stall into a diagnostic. It never lets a second holder in.
//
// Taking over a dead owner's lock (token T) goes through a marker, reclaim-T,
// created exclusively with fs.link(). The lock file for T can only be removed by T's
// owner (release; it is dead) or by the one reclaimer holding reclaim-T, which reads
// the lock again while holding the marker and unlinks it only if it still holds T.
// A reclaimer that acted on an old observation therefore either fails to get the
// marker, or gets it after the first reclaimer finished, sees another token, and
// leaves that owner's lock alone. The lock path is never moved.
//
// If a reclaimer dies while it holds reclaim-T, the lock is left in place and the
// marker blocks every other reclaimer; the wait ends in a diagnostic that names both
// files (delete the lock directory by hand). Recovering from that automatically
// would need the recursive reclamation this design avoids on purpose.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const LOCK_FILE_NAME = 'lock';
// Playwright's test timeout (60 s) includes beforeEach, so the wait must end first
// to be reported as a lock problem rather than as a hook timeout.
export const DEFAULT_TIMEOUT_MS = 45_000;
export const DEFAULT_POLL_MS = 25;

// Tokens become file names (reclaim-<token>), so a record naming anything else is
// treated as unreadable instead of being trusted.
const TOKEN_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
// fs.link() failures that can pass on retry (a file held open by a scanner); any
// other code, such as a filesystem without hard links, is a real error.
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

const noop = async () => {};

export class LockTimeoutError extends Error {
    constructor(message, details) {
        super(message);
        this.name = 'LockTimeoutError';
        this.code = 'ELOCKTIMEOUT';
        this.details = details;
    }
}

export class LockExclusivityError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LockExclusivityError';
        this.code = 'ELOCKEXCLUSIVITY';
    }
}

function parseRecord(text) {
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (!value || typeof value !== 'object') return null;
    if (typeof value.token !== 'string' || !TOKEN_PATTERN.test(value.token)) return null;
    if (typeof value.hostname !== 'string' || !Number.isSafeInteger(value.pid)) return null;
    return value;
}

// { state: 'missing' } | { state: 'record', record, raw } | { state: 'invalid', raw }
// | { state: 'error', error }
async function readRecordFile(filePath) {
    let raw;
    try {
        raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return { state: 'missing' };
        return { state: 'error', error };
    }
    const record = parseRecord(raw);
    return record ? { state: 'record', record, raw } : { state: 'invalid', raw };
}

// True only when the record names this host and a process that does not exist.
function isOwnerDead(record) {
    if (record.hostname !== os.hostname()) return false;
    if (record.pid <= 0) return false; // pid 0 and negative pids would signal groups
    try {
        process.kill(record.pid, 0);
        return false;
    } catch (error) {
        return error.code === 'ESRCH';
    }
}

function describeRecordFile(file) {
    if (file.state === 'record') return file.raw.trim();
    if (file.state === 'invalid') return `an unreadable record (${JSON.stringify(file.raw.slice(0, 200))})`;
    if (file.state === 'error') return `a file that could not be read (${file.error.code ?? file.error.message})`;
    return 'no record (the file vanished)';
}

function describeOwner(file) {
    if (file.state !== 'record') return 'its owner cannot be determined';
    const { pid, hostname } = file.record;
    if (hostname !== os.hostname()) {
        return `pid ${pid} runs on host ${hostname}, not on this host (${os.hostname()}), so it cannot be checked`;
    }
    return isOwnerDead(file.record) ? `pid ${pid} on this host is not running` : `pid ${pid} on this host is running`;
}

async function releaseLockFile(lockPath, token) {
    let current = await readRecordFile(lockPath);
    for (let attempt = 0; current.state === 'error' && attempt < 5; attempt += 1) {
        await sleep(20);
        current = await readRecordFile(lockPath);
    }
    if (current.state === 'record' && current.record.token === token) {
        // Only the owner removes a live owner's lock and nobody else may take it over,
        // so the record cannot change between this read and the unlink.
        await fs.unlink(lockPath);
        return;
    }
    if (current.state === 'error') {
        throw new Error(`Cannot read the lock ${lockPath} to release it: ${current.error.message}`);
    }
    throw new LockExclusivityError(
        `Exclusivity was violated: releasing lock ${token} but ${lockPath} holds ${describeRecordFile(current)}. `
        + 'Another test may have run at the same time as this one.',
    );
}

/**
 * Waits for the lock in `directory` and returns a handle { token, record, lockPath,
 * release() }. release() removes the lock only if it still holds this handle's token
 * and otherwise rejects with a LockExclusivityError (a second call reports the same
 * outcome again). Rejects with a LockTimeoutError naming the holder after `timeoutMs`,
 * and with an AbortError if `signal` aborts; in both cases nothing is held and no
 * file of this call is left behind.
 *
 * `hooks` exist for tests that need a fixed interleaving: afterHolderRead(file),
 * afterMarkerBusy({ stale, markerPath }), afterMarkerAcquired({ stale, markerPath }),
 * beforeUnlink({ stale, current }) and afterLinked(record). Each may return a promise.
 */
export async function acquire({
    directory,
    workerIndex = 0,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
    signal,
    hooks = {},
} = {}) {
    const {
        afterHolderRead = noop,
        afterMarkerBusy = noop,
        afterMarkerAcquired = noop,
        beforeUnlink = noop,
        afterLinked = noop,
    } = hooks;
    const lockPath = path.join(directory, LOCK_FILE_NAME);
    const base = { pid: process.pid, hostname: os.hostname(), workerIndex, token: crypto.randomUUID() };
    const tempPath = path.join(directory, `acquire-${base.token}.tmp`);
    const deadline = Date.now() + timeoutMs;

    // The temp file is written anew for every attempt that can succeed, so the
    // record's acquiredAt is the moment of acquisition, not of arrival. It is removed
    // first because the previous write may have been linked as a marker.
    async function writeTempRecord() {
        const record = { ...base, acquiredAt: new Date().toISOString() };
        await fs.rm(tempPath, { force: true });
        await fs.writeFile(tempPath, `${JSON.stringify(record)}\n`, { flag: 'wx' });
        return record;
    }

    // 'done' when the stale lock was dealt with (removed, or already gone or replaced),
    // 'busy' when another reclaimer holds the marker, 'blocked' when that reclaimer died.
    async function reclaim(stale) {
        const markerPath = path.join(directory, `reclaim-${stale.token}`);
        await writeTempRecord();
        try {
            await fs.link(tempPath, markerPath);
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            await afterMarkerBusy({ stale, markerPath });
            const marker = await readRecordFile(markerPath);
            const dead = marker.state === 'record' && isOwnerDead(marker.record);
            return { status: dead ? 'blocked' : 'busy', markerPath, marker };
        }
        try {
            await afterMarkerAcquired({ stale, markerPath });
            const current = await readRecordFile(lockPath);
            if (current.state === 'record' && current.record.token === stale.token) {
                await beforeUnlink({ stale, current: current.record });
                await fs.unlink(lockPath);
            }
        } finally {
            await fs.rm(markerPath, { force: true });
        }
        return { status: 'done', markerPath };
    }

    function timeoutError(observation) {
        const lines = [`Timed out after ${timeoutMs} ms waiting for the lock ${lockPath}.`];
        if (observation.holder) {
            lines.push(`It holds ${describeRecordFile(observation.holder)}; ${describeOwner(observation.holder)}.`);
        }
        if (observation.blocked) {
            lines.push(
                `A reclaimer died while it held ${observation.blocked.markerPath} `
                + `(${describeRecordFile(observation.blocked.marker)}), `
                + 'so the dead owner\'s lock is not taken over automatically.',
            );
        }
        if (observation.linkError) {
            lines.push(`The last attempt to publish the lock failed with ${observation.linkError.code}: ${observation.linkError.message}`);
        }
        lines.push(
            'A live owner is never displaced. If no media-flow test is running, delete '
            + `${directory} (it is under test-results) and run again.`,
        );
        return new LockTimeoutError(lines.join(' '), { lockPath, ...observation });
    }

    await fs.mkdir(directory, { recursive: true });
    let observation = {};
    try {
        for (let attempt = 0; ; attempt += 1) {
            signal?.throwIfAborted();
            if (attempt > 0 && Date.now() >= deadline) throw timeoutError(observation);

            const holder = await readRecordFile(lockPath);
            if (holder.state === 'missing') {
                const record = await writeTempRecord();
                try {
                    await fs.link(tempPath, lockPath);
                } catch (error) {
                    if (error.code === 'EEXIST') continue; // lost the race: look at the winner
                    if (!TRANSIENT_CODES.has(error.code)) throw error;
                    observation = { linkError: error };
                    await sleep(pollMs, undefined, { signal });
                    continue;
                }
                try {
                    await afterLinked(record);
                    // The caller stopped waiting (for example its hook timed out) while the
                    // link landed: give the lock straight back instead of leaking it.
                    signal?.throwIfAborted();
                } catch (error) {
                    await releaseLockFile(lockPath, base.token);
                    throw error;
                }
                let released = null;
                return {
                    token: base.token,
                    record,
                    lockPath,
                    release() {
                        released ??= releaseLockFile(lockPath, base.token);
                        return released;
                    },
                };
            }

            observation = { holder };
            await afterHolderRead(holder);
            if (holder.state === 'record' && isOwnerDead(holder.record)) {
                const outcome = await reclaim(holder.record);
                if (outcome.status === 'done') continue;
                if (outcome.status === 'blocked') observation = { holder, blocked: outcome };
            }
            await sleep(pollMs, undefined, { signal });
        }
    } finally {
        await fs.rm(tempPath, { force: true });
    }
}

/**
 * One test's use of the lock, for a beforeEach/afterEach pair. acquire() waits for
 * the lock; release() may be called at any time, also while acquire() is still
 * waiting, after it timed out, or without it ever having run. That matters when
 * Playwright times out a beforeEach: it abandons the hook function, which keeps
 * waiting, and afterEach is the only code that still runs. release() cancels the
 * wait, so a late acquisition cannot leak the lock, and releases whatever was
 * acquired. cancel() only stops the wait at once (release() calls it), and
 * `cancelled` tells an abandoned hook that it must not carry on.
 */
export function createLockSession(options) {
    const controller = new AbortController();
    let acquiring = null;
    let lock = null;
    const cancel = () => controller.abort();
    return {
        get cancelled() {
            return controller.signal.aborted;
        },
        cancel,
        acquire() {
            acquiring = acquire({ ...options, signal: controller.signal }).then((acquired) => {
                lock = acquired;
                return acquired;
            });
            return acquiring;
        },
        async release() {
            cancel();
            if (acquiring) {
                try {
                    await acquiring;
                } catch {
                    // aborted, timed out or failed: acquire() reported that, and nothing is held
                }
            }
            if (lock) await lock.release();
        },
    };
}
