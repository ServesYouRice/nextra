'use strict';

// The lock that serialises tests/browser/media-flow.spec.mjs: one holder at a time
// across Playwright workers, and a lock is taken from its owner only when the
// owner process is provably dead.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const HELPER_URL = pathToFileURL(path.join(__dirname, 'browser', 'support', 'exclusiveFileLock.mjs')).href;
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'exclusiveFileLockWorker.mjs');
const SPEC_PATH = path.join(__dirname, 'browser', 'media-flow.spec.mjs');

function loadHelper() {
    return import(HELPER_URL);
}

async function makeScratch(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nextra-lock-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, '.media-flow-lock');
    return {
        directory,
        lockPath: path.join(directory, 'lock'),
        logPath: path.join(root, 'events.log'),
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
        await sleep(5);
    }
}

async function listDirectory(directory) {
    try {
        return (await fs.readdir(directory)).sort();
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function readLockToken(lockPath) {
    return JSON.parse(await fs.readFile(lockPath, 'utf8')).token;
}

// The pid of a process that has exited, so it names no running process.
async function deadPid() {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve) => child.once('exit', resolve));
    return child.pid;
}

function makeRecord(overrides = {}) {
    return {
        pid: process.pid,
        hostname: os.hostname(),
        workerIndex: 7,
        token: crypto.randomUUID(),
        acquiredAt: new Date().toISOString(),
        ...overrides,
    };
}

async function writeLockFile(scratch, content) {
    await fs.mkdir(scratch.directory, { recursive: true });
    const text = typeof content === 'string' ? content : `${JSON.stringify(content)}\n`;
    await fs.writeFile(scratch.lockPath, text);
    return text;
}

function spawnFixture(t, config) {
    const child = spawn(process.execPath, [FIXTURE_PATH], {
        env: {
            ...process.env,
            EXCLUSIVE_LOCK_FIXTURE: JSON.stringify({ helperUrl: HELPER_URL, ...config }),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const exited = new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
    });
    t.after(() => child.kill());
    return { child, exited, output: () => stdout };
}

function replayLog(text) {
    const events = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    let holders = 0;
    let maxHolders = 0;
    let firstOverlap = null;
    for (const event of events) {
        holders += event.event === 'enter' ? 1 : -1;
        if (holders > maxHolders) {
            maxHolders = holders;
            if (holders > 1 && !firstOverlap) firstOverlap = event;
        }
    }
    return {
        enters: events.filter((event) => event.event === 'enter').length,
        maxHolders,
        firstOverlap,
    };
}

function contendConfig(scratch, overrides) {
    return {
        mode: 'contend',
        directory: scratch.directory,
        logPath: scratch.logPath,
        gapMs: 15,
        gateTimeoutMs: 20_000,
        holdMinMs: 8,
        holdMaxMs: 20,
        pollMs: 5,
        timeoutMs: 30_000,
        ...overrides,
    };
}

test('workers that arrive together never hold the lock at the same time', { timeout: 60_000 }, async (t) => {
    const scratch = await makeScratch(t);
    const workerCount = 4;
    const rounds = 20;
    const startAt = Date.now() + 1_200;
    const workers = [];
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
        workers.push(spawnFixture(t, contendConfig(scratch, { workerIndex, workerCount, rounds, startAt })));
    }
    for (const result of await Promise.all(workers.map((worker) => worker.exited))) {
        assert.equal(result.code, 0, `worker failed: ${result.stderr}`);
    }

    const replay = replayLog(await fs.readFile(scratch.logPath, 'utf8'));
    assert.equal(replay.enters, workerCount * rounds);
    assert.equal(replay.maxHolders, 1, `two holders at once; the second entered at ${JSON.stringify(replay.firstOverlap)}`);
    assert.deepEqual(await listDirectory(scratch.directory), [], 'no lock, ticket, marker or temp file is left behind');
});

test('a live holder keeps the lock however old it looks, and a waiter is admitted only after the release', { timeout: 30_000 }, async (t) => {
    const { acquire, LockTimeoutError } = await loadHelper();
    const scratch = await makeScratch(t);
    const holder = spawnFixture(t, { mode: 'hold', directory: scratch.directory, workerIndex: 3, pollMs: 5, timeoutMs: 10_000 });
    await waitFor(() => holder.output().includes('"acquired"'), 'the holder to take the lock');
    const holderToken = await readLockToken(scratch.lockPath);

    // Far older than any threshold an age-based rule could use.
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await fs.utimes(scratch.lockPath, longAgo, longAgo);

    await assert.rejects(
        acquire({ directory: scratch.directory, workerIndex: 1, pollMs: 10, timeoutMs: 600 }),
        (error) => {
            assert.ok(error instanceof LockTimeoutError);
            assert.match(error.message, new RegExp(`"pid":${holder.child.pid}\\b`), 'names the holder record');
            assert.match(error.message, /is running/);
            assert.match(error.message, /delete .*\.media-flow-lock/);
            return true;
        },
    );
    assert.equal(await readLockToken(scratch.lockPath), holderToken, 'the live holder keeps its lock');
    assert.deepEqual(await listDirectory(scratch.directory), ['lock'], 'a timed-out waiter leaves no file behind');

    const waiter = acquire({ directory: scratch.directory, workerIndex: 2, pollMs: 10, timeoutMs: 10_000 });
    let admitted = false;
    waiter.then(() => { admitted = true; }, () => {});
    await sleep(200);
    assert.equal(admitted, false, 'the waiter is not admitted while the holder lives');
    holder.child.stdin.write('release\n');
    const lock = await waiter;
    assert.notEqual(lock.token, holderToken);
    assert.equal((await holder.exited).code, 0);
    await lock.release();
    assert.deepEqual(await listDirectory(scratch.directory), []);
});

test('a lock whose owner process has exited is reclaimed', async (t) => {
    const { acquire } = await loadHelper();
    const scratch = await makeScratch(t);
    const stale = makeRecord({ pid: await deadPid() });
    await writeLockFile(scratch, stale);

    const lock = await acquire({ directory: scratch.directory, workerIndex: 1, pollMs: 10, timeoutMs: 5_000 });
    assert.notEqual(lock.token, stale.token);
    assert.equal(await readLockToken(scratch.lockPath), lock.token);
    assert.deepEqual(await listDirectory(scratch.directory), ['lock'], 'the reclaim marker and temp file are gone');
    await lock.release();
    assert.deepEqual(await listDirectory(scratch.directory), []);
});

test('a lock left behind by a killed holder process is reclaimed', { timeout: 30_000 }, async (t) => {
    const { acquire } = await loadHelper();
    const scratch = await makeScratch(t);
    const holder = spawnFixture(t, { mode: 'hold', directory: scratch.directory, workerIndex: 3, pollMs: 5, timeoutMs: 10_000 });
    await waitFor(() => holder.output().includes('"acquired"'), 'the holder to take the lock');
    const holderToken = await readLockToken(scratch.lockPath);

    holder.child.kill('SIGKILL');
    await holder.exited;
    assert.equal(await readLockToken(scratch.lockPath), holderToken, 'the killed holder could not release');

    const lock = await acquire({ directory: scratch.directory, workerIndex: 1, pollMs: 10, timeoutMs: 5_000 });
    assert.notEqual(lock.token, holderToken);
    await lock.release();
});

test('a reclaimer that paused after reading a stale lock does not remove the replacement owner\'s lock', async (t) => {
    const { acquire } = await loadHelper();
    const scratch = await makeScratch(t);
    const stale = makeRecord({ pid: await deadPid() });
    await writeLockFile(scratch, stale);
    const markerPath = path.join(scratch.directory, `reclaim-${stale.token}`);

    const events = [];
    let paused = false;
    let reachedPause;
    const reached = new Promise((resolve) => { reachedPause = resolve; });
    let resume;
    const gate = new Promise((resolve) => { resume = resolve; });
    const slow = acquire({
        directory: scratch.directory,
        workerIndex: 2,
        pollMs: 10,
        timeoutMs: 10_000,
        hooks: {
            async afterHolderRead(file) {
                if (file.state !== 'record' || file.record.token !== stale.token || paused) return;
                paused = true;
                reachedPause();
                await gate;
            },
            async afterMarkerAcquired({ stale: seen }) {
                events.push(`marker:${seen.token}`);
            },
            async beforeUnlink() {
                events.push('unlink');
            },
        },
    });
    await reached;

    // R1 reclaims the stale lock and becomes the new owner, T2.
    const fast = await acquire({ directory: scratch.directory, workerIndex: 1, pollMs: 10, timeoutMs: 5_000 });
    assert.equal(await readLockToken(scratch.lockPath), fast.token);

    // R2 resumes with its stale observation: it gets the marker for T again, because
    // R1 deleted it, and must see that the lock no longer holds T.
    resume();
    await waitFor(() => events.includes(`marker:${stale.token}`), 'the resumed reclaimer to reach the marker');
    await waitFor(async () => !(await listDirectory(scratch.directory)).includes(path.basename(markerPath)), 'its marker to be deleted');
    assert.deepEqual(events, [`marker:${stale.token}`], 'the resumed reclaimer never unlinked');
    assert.equal(await readLockToken(scratch.lockPath), fast.token, 'the lock still holds the replacement owner');

    await fast.release();
    const lock = await slow;
    assert.notEqual(lock.token, fast.token);
    await lock.release();
    assert.deepEqual(await listDirectory(scratch.directory), []);
});

test('two reclaimers of the same dead owner\'s lock produce one marker winner and one removal', async (t) => {
    const { acquire } = await loadHelper();
    const scratch = await makeScratch(t);
    const stale = makeRecord({ pid: await deadPid() });
    await writeLockFile(scratch, stale);

    const winners = [];
    const losers = [];
    const unlinks = [];
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const hooksFor = (name) => ({
        async afterMarkerAcquired() {
            winners.push(name);
            await gate; // keep the marker while the other reclaimer tries
        },
        async afterMarkerBusy() {
            losers.push(name);
        },
        async beforeUnlink() {
            unlinks.push(name);
        },
    });
    const settled = [];
    const start = (name, workerIndex) => acquire({
        directory: scratch.directory,
        workerIndex,
        pollMs: 10,
        timeoutMs: 10_000,
        hooks: hooksFor(name),
    }).then((lock) => {
        settled.push(name);
        return lock;
    });
    const a = start('a', 1);
    const b = start('b', 2);

    await waitFor(() => winners.length >= 1 && losers.length >= 1, 'both reclaimers to try the marker');
    await sleep(100); // the loser keeps retrying while the winner holds the marker
    assert.equal(winners.length, 1, 'exactly one reclaimer holds the marker');
    assert.notEqual(winners[0], losers[0]);
    assert.ok((await listDirectory(scratch.directory)).includes(`reclaim-${stale.token}`));
    assert.equal(unlinks.length, 0);

    open();
    await waitFor(() => settled.length === 1, 'the first reclaimer to take the lock');
    // The loser may now win the marker for the same token too, but it reads the lock
    // again, finds the winner's or none, and removes nothing (unlinks is checked below).
    const first = settled[0] === 'a' ? await a : await b;
    assert.equal(await readLockToken(scratch.lockPath), first.token);
    await first.release();
    const second = settled[0] === 'a' ? await b : await a;
    await second.release();
    assert.equal(unlinks.length, 1, 'the stale lock was removed once');
    assert.deepEqual(await listDirectory(scratch.directory), []);
});

test('processes that race to reclaim one dead owner\'s lock are admitted one at a time', { timeout: 30_000 }, async (t) => {
    const scratch = await makeScratch(t);
    await writeLockFile(scratch, makeRecord({ pid: await deadPid() }));
    const workerCount = 4;
    const startAt = Date.now() + 1_000;
    const workers = [];
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
        workers.push(spawnFixture(t, contendConfig(scratch, { workerIndex, workerCount, rounds: 1, startAt })));
    }
    for (const result of await Promise.all(workers.map((worker) => worker.exited))) {
        assert.equal(result.code, 0, `worker failed: ${result.stderr}`);
    }
    const replay = replayLog(await fs.readFile(scratch.logPath, 'utf8'));
    assert.equal(replay.enters, workerCount);
    assert.equal(replay.maxHolders, 1);
    assert.deepEqual(await listDirectory(scratch.directory), []);
});

test('release with a token the lock does not hold throws and leaves the lock alone', async (t) => {
    const { acquire, LockExclusivityError } = await loadHelper();
    const scratch = await makeScratch(t);

    const lock = await acquire({ directory: scratch.directory, workerIndex: 1 });
    const foreign = await writeLockFile(scratch, makeRecord({ workerIndex: 9 }));
    await assert.rejects(lock.release(), (error) => {
        assert.ok(error instanceof LockExclusivityError);
        assert.match(error.message, /Exclusivity was violated/);
        return true;
    });
    assert.equal(await fs.readFile(scratch.lockPath, 'utf8'), foreign, 'the other owner\'s lock is untouched');
    await assert.rejects(lock.release(), /Exclusivity was violated/, 'a second release reports it again');

    await fs.rm(scratch.lockPath);
    const second = await acquire({ directory: scratch.directory, workerIndex: 1 });
    await fs.rm(scratch.lockPath);
    await assert.rejects(second.release(), /Exclusivity was violated/, 'a lock that vanished is a violation too');
});

test('a record from another host or one that cannot be read is never reclaimed', async (t) => {
    const { acquire, LockTimeoutError } = await loadHelper();
    const pid = await deadPid();
    const cases = [
        ['another host, dead pid', JSON.stringify(makeRecord({ pid, hostname: `${os.hostname()}-elsewhere` })), /not on this host/],
        ['not JSON', 'not json{', /unreadable record/],
        ['empty', '', /unreadable record/],
        ['no pid', JSON.stringify({ hostname: os.hostname(), token: crypto.randomUUID() }), /unreadable record/],
        ['token that is not a file name', JSON.stringify(makeRecord({ pid, token: '../../escape' })), /unreadable record/],
        ['pid 0', JSON.stringify(makeRecord({ pid: 0 })), /unreadable record|pid 0/],
    ];
    for (const [name, content, expected] of cases) {
        const scratch = await makeScratch(t);
        await writeLockFile(scratch, content);
        await assert.rejects(
            acquire({ directory: scratch.directory, workerIndex: 1, pollMs: 10, timeoutMs: 150 }),
            (error) => {
                assert.ok(error instanceof LockTimeoutError, name);
                assert.ok(error.message.includes(scratch.lockPath), `${name}: names the lock`);
                assert.match(error.message, expected, name);
                assert.match(error.message, /delete .*\.media-flow-lock/, name);
                return true;
            },
        );
        assert.equal(await fs.readFile(scratch.lockPath, 'utf8'), content, `${name}: the record is untouched`);
        assert.deepEqual(await listDirectory(scratch.directory), ['lock'], `${name}: no marker or temp file`);
    }
});

test('when the reclaimer of a dead owner\'s lock died too, acquisition fails closed and names both files', async (t) => {
    const { acquire, LockTimeoutError } = await loadHelper();
    const scratch = await makeScratch(t);
    const pid = await deadPid();
    const stale = makeRecord({ pid });
    await writeLockFile(scratch, stale);
    const markerPath = path.join(scratch.directory, `reclaim-${stale.token}`);
    await fs.writeFile(markerPath, `${JSON.stringify(makeRecord({ pid }))}\n`);

    await assert.rejects(
        acquire({ directory: scratch.directory, workerIndex: 1, pollMs: 10, timeoutMs: 150 }),
        (error) => {
            assert.ok(error instanceof LockTimeoutError);
            assert.ok(error.message.includes(scratch.lockPath));
            assert.ok(error.message.includes(markerPath));
            assert.match(error.message, /delete .*\.media-flow-lock/);
            return true;
        },
    );
    assert.equal(await readLockToken(scratch.lockPath), stale.token, 'the lock was not taken over');
    assert.deepEqual(await listDirectory(scratch.directory), [`reclaim-${stale.token}`, 'lock'].sort());
});

test('aborting a waiting acquire leaves the holder\'s lock and none of its own files', async (t) => {
    const { acquire } = await loadHelper();
    const scratch = await makeScratch(t);
    const holder = await acquire({ directory: scratch.directory, workerIndex: 1 });

    const controller = new AbortController();
    const waiting = acquire({ directory: scratch.directory, workerIndex: 2, pollMs: 10, timeoutMs: 10_000, signal: controller.signal });
    await sleep(60);
    controller.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.equal(await readLockToken(scratch.lockPath), holder.token);
    assert.deepEqual(await listDirectory(scratch.directory), ['lock']);
    await holder.release();
});

test('an abort that lands just after the link gives the lock straight back', async (t) => {
    const { acquire } = await loadHelper();
    const scratch = await makeScratch(t);
    const controller = new AbortController();

    await assert.rejects(
        acquire({
            directory: scratch.directory,
            workerIndex: 1,
            signal: controller.signal,
            hooks: { afterLinked: async () => controller.abort() },
        }),
        { name: 'AbortError' },
    );
    assert.deepEqual(await listDirectory(scratch.directory), [], 'the lock was released');
    const lock = await acquire({ directory: scratch.directory, workerIndex: 2, timeoutMs: 500 });
    await lock.release();
});

test('a session released while its acquire is still waiting never takes the lock afterwards', async (t) => {
    const { acquire, createLockSession } = await loadHelper();
    const scratch = await makeScratch(t);
    const holder = await acquire({ directory: scratch.directory, workerIndex: 1 });

    // What a beforeEach that Playwright timed out looks like: acquire() is still
    // waiting, and only afterEach runs.
    const session = createLockSession({ directory: scratch.directory, workerIndex: 2, pollMs: 10, timeoutMs: 10_000 });
    const abandoned = session.acquire();
    abandoned.catch(() => {});
    await sleep(60);
    assert.equal(session.cancelled, false);
    session.cancel(); // what afterEach does first, so the hook cannot carry on meanwhile
    assert.equal(session.cancelled, true);
    await assert.rejects(abandoned, { name: 'AbortError' });
    await session.release();

    await holder.release();
    await sleep(100); // long enough for a leaked poll loop to take the free lock
    assert.deepEqual(await listDirectory(scratch.directory), [], 'the abandoned acquire did not take the lock');
});

test('a session releases a lock it holds, once, and a session that never acquired releases nothing', async (t) => {
    const { createLockSession, LockExclusivityError } = await loadHelper();
    const scratch = await makeScratch(t);

    const session = createLockSession({ directory: scratch.directory, workerIndex: 1 });
    const lock = await session.acquire();
    assert.equal(await readLockToken(scratch.lockPath), lock.token);
    await session.release();
    await session.release();
    assert.deepEqual(await listDirectory(scratch.directory), []);

    await createLockSession({ directory: scratch.directory, workerIndex: 2 }).release();

    const broken = createLockSession({ directory: scratch.directory, workerIndex: 3 });
    await broken.acquire();
    await writeLockFile(scratch, makeRecord());
    await assert.rejects(broken.release(), LockExclusivityError, 'a stolen lock fails the release visibly');
});

test('a session whose acquire timed out releases without error and without touching the holder', async (t) => {
    const { acquire, createLockSession, LockTimeoutError } = await loadHelper();
    const scratch = await makeScratch(t);
    const holder = await acquire({ directory: scratch.directory, workerIndex: 1 });

    const session = createLockSession({ directory: scratch.directory, workerIndex: 2, pollMs: 10, timeoutMs: 100 });
    await assert.rejects(session.acquire(), LockTimeoutError);
    await session.release();
    assert.equal(await readLockToken(scratch.lockPath), holder.token);
    await holder.release();
});

test('media-flow.spec.mjs takes its lock from the helper and keeps no ticket files', async () => {
    const source = await fs.readFile(SPEC_PATH, 'utf8');
    assert.match(source, /support\/exclusiveFileLock\.mjs/);
    assert.doesNotMatch(source, /\.ticket|tickets/);
});
