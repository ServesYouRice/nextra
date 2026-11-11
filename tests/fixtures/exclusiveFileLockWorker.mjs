// Child process for tests/exclusiveFileLock.test.js. It is configured through the
// EXCLUSIVE_LOCK_FIXTURE environment variable (a JSON object) and has two modes.
//
// contend: for each round, wait until every worker has finished the round before and
//   then for a fixed gap, so all workers arrive at the same moment, take the lock,
//   append "enter" to the shared log, hold for a random time, append "exit", release.
//   The test replays the log in file order; two workers inside at once is a
//   mutual-exclusion violation. Appends are atomic and each "exit" is written before
//   the release that lets the next holder in, so the log can never show an overlap
//   that did not happen.
//
// hold: take the lock once, report it on stdout, and keep it until a line arrives
//   on stdin (or the parent kills the process, which leaves the lock behind).
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const config = JSON.parse(process.env.EXCLUSIVE_LOCK_FIXTURE);
const { acquire } = await import(config.helperUrl);

function log(event, round) {
    const line = JSON.stringify({
        event,
        round,
        workerIndex: config.workerIndex,
        pid: process.pid,
        at: Date.now(),
    });
    fs.appendFileSync(config.logPath, `${line}\n`);
}

function readEvents() {
    const events = [];
    for (const line of fs.readFileSync(config.logPath, 'utf8').split('\n')) {
        try {
            events.push(JSON.parse(line));
        } catch {
            // an empty line or a line still being appended
        }
    }
    return events;
}

async function waitUntil(time) {
    const coarse = time - Date.now() - 3;
    if (coarse > 0) await sleep(coarse);
    while (Date.now() < time) { /* spin the last few milliseconds so workers start together */ }
}

// Every worker computes the same arrival time for a round from the log: the last
// "exit" of the round before plus a fixed gap.
async function waitForRound(round) {
    if (round === 0) {
        await waitUntil(config.startAt);
        return;
    }
    const deadline = Date.now() + config.gateTimeoutMs;
    for (;;) {
        const exits = readEvents().filter((event) => event.event === 'exit' && event.round === round - 1);
        if (exits.length >= config.workerCount) {
            await waitUntil(Math.max(...exits.map((event) => event.at)) + config.gapMs);
            return;
        }
        if (Date.now() > deadline) throw new Error(`round ${round - 1} never finished in every worker`);
        await sleep(1);
    }
}

const acquireOptions = {
    directory: config.directory,
    workerIndex: config.workerIndex,
    pollMs: config.pollMs,
    timeoutMs: config.timeoutMs,
};

if (config.mode === 'hold') {
    const lock = await acquire(acquireOptions);
    process.stdout.write(`${JSON.stringify({ event: 'acquired', pid: process.pid, token: lock.token })}\n`);
    await new Promise((resolve) => process.stdin.once('data', resolve));
    await lock.release();
    process.stdout.write(`${JSON.stringify({ event: 'released' })}\n`);
    process.exit(0);
} else {
    for (let round = 0; round < config.rounds; round += 1) {
        await waitForRound(round);
        const lock = await acquire(acquireOptions);
        log('enter', round);
        await sleep(config.holdMinMs + Math.random() * (config.holdMaxMs - config.holdMinMs));
        log('exit', round);
        await lock.release();
    }
}
