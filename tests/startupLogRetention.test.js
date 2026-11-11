'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    DEFAULT_KEEP_SESSIONS,
    SESSION_LOG_PATTERN,
    pruneOldLogs,
} = require('../lib/startupLogRetention');

const repoRoot = path.resolve(__dirname, '..');

function makeLogDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-startup-logs-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// Session n (1 = oldest). The stem sorts by date, then time, then pid.
function sessionStem(n) {
    const day = String(n).padStart(2, '0');
    return `startup-202001${day}-120000-${4000 + n}`;
}

function touch(dir, name) {
    fs.writeFileSync(path.join(dir, name), `${name}\n`);
}

// A session that rotated twice leaves .log, .log.1 and .log.2.
function writeSession(dir, n, generations = 2) {
    const stem = sessionStem(n);
    touch(dir, `${stem}.log`);
    for (let generation = 1; generation <= generations; generation++) {
        touch(dir, `${stem}.log.${generation}`);
    }
}

function listLogDir(dir) {
    return fs.readdirSync(dir).sort();
}

test('the retention count is still ten sessions', () => {
    assert.equal(DEFAULT_KEEP_SESSIONS, 10);
});

test('pruning removes the .log, .log.1 and .log.2 of every session beyond the newest ten', (t) => {
    const dir = makeLogDir(t);
    for (let n = 1; n <= 13; n++) writeSession(dir, n);

    pruneOldLogs(dir);

    const left = listLogDir(dir);
    for (const n of [1, 2, 3]) {
        const stem = sessionStem(n);
        for (const name of [`${stem}.log`, `${stem}.log.1`, `${stem}.log.2`]) {
            assert.ok(!left.includes(name), `${name} should have been pruned with its session`);
        }
    }
    assert.equal(left.length, 10 * 3, 'ten sessions with three files each remain');
});

test('the newest ten sessions keep every generation', (t) => {
    const dir = makeLogDir(t);
    for (let n = 1; n <= 13; n++) writeSession(dir, n);

    pruneOldLogs(dir);

    const left = listLogDir(dir);
    for (let n = 4; n <= 13; n++) {
        const stem = sessionStem(n);
        for (const name of [`${stem}.log`, `${stem}.log.1`, `${stem}.log.2`]) {
            assert.ok(left.includes(name), `${name} belongs to a retained session`);
        }
    }
});

test('a pruned session whose primary file is already gone loses its leftover generations', (t) => {
    const dir = makeLogDir(t);
    for (let n = 1; n <= 11; n++) writeSession(dir, n);
    // What the old pruning left behind: it removed only the primary file of a session.
    fs.rmSync(path.join(dir, `${sessionStem(1)}.log`));

    const removed = pruneOldLogs(dir);

    const left = listLogDir(dir);
    assert.ok(!left.includes(`${sessionStem(1)}.log.1`));
    assert.ok(!left.includes(`${sessionStem(1)}.log.2`));
    assert.deepEqual(removed.sort(), [`${sessionStem(1)}.log.1`, `${sessionStem(1)}.log.2`]);
});

test('sessions that rotated a different number of times are grouped by their stem', (t) => {
    const dir = makeLogDir(t);
    writeSession(dir, 1, 5);
    writeSession(dir, 2, 0);
    writeSession(dir, 3, 1);
    for (let n = 4; n <= 13; n++) writeSession(dir, n, 0);

    pruneOldLogs(dir);

    assert.deepEqual(listLogDir(dir), Array.from({ length: 10 }, (_, i) => `${sessionStem(i + 4)}.log`));
});

test('startup-latest.log, its generations and unrelated files are never pruned', (t) => {
    const dir = makeLogDir(t);
    for (let n = 1; n <= 12; n++) writeSession(dir, n);
    const others = [
        'startup-latest.log',
        'startup-latest.log.1',
        'startup-latest.log.5',
        'startup-20200101-120000-4001.log.bak',
        'startup-20200101-120000-4001.log.1.old',
        'startup-20200101-120000-4001.txt',
        'startup-2020-120000-4001.log',
        'startup-20200101-120000-.log',
        'old-startup-20200101-120000-4001.log',
        'server.log',
        'notes.txt',
    ];
    for (const name of others) touch(dir, name);

    pruneOldLogs(dir);

    const left = listLogDir(dir);
    for (const name of others) assert.ok(left.includes(name), `${name} is not a session log`);
    assert.ok(!left.includes(`${sessionStem(1)}.log.2`));
    assert.ok(!left.includes(`${sessionStem(2)}.log`));
});

test('ten sessions or fewer, including rotated ones, are all kept', (t) => {
    const dir = makeLogDir(t);
    for (let n = 1; n <= 10; n++) writeSession(dir, n);
    const before = listLogDir(dir);

    const removed = pruneOldLogs(dir);

    assert.deepEqual(listLogDir(dir), before);
    assert.deepEqual(removed, []);
});

test('the keep option sets how many sessions stay', (t) => {
    const dir = makeLogDir(t);
    for (let n = 1; n <= 5; n++) writeSession(dir, n);

    pruneOldLogs(dir, { keep: 2 });

    assert.deepEqual(
        listLogDir(dir),
        [4, 5].flatMap((n) => [`${sessionStem(n)}.log`, `${sessionStem(n)}.log.1`, `${sessionStem(n)}.log.2`]).sort()
    );
});

test('the session pattern captures the stem and an optional numeric generation', () => {
    const stem = 'startup-20261024-101530-4242';
    assert.equal(SESSION_LOG_PATTERN.exec(`${stem}.log`)[1], stem);
    assert.equal(SESSION_LOG_PATTERN.exec(`${stem}.log.1`)[1], stem);
    assert.equal(SESSION_LOG_PATTERN.exec(`${stem}.log.12`)[1], stem);
    assert.equal(SESSION_LOG_PATTERN.exec(`${stem}.log.`), null);
    assert.equal(SESSION_LOG_PATTERN.exec(`${stem}.log.x`), null);
    assert.equal(SESSION_LOG_PATTERN.exec('startup-latest.log'), null);
    assert.equal(SESSION_LOG_PATTERN.exec('startup-latest.log.1'), null);
});

test('an empty or missing log directory is a no-op', (t) => {
    const dir = makeLogDir(t);
    assert.deepEqual(pruneOldLogs(dir), []);
    assert.deepEqual(pruneOldLogs(''), []);
    assert.deepEqual(pruneOldLogs(path.join(dir, 'does-not-exist')), []);
});

test('pruning failures are swallowed and the other files are still removed', () => {
    const names = [];
    for (let n = 1; n <= 12; n++) {
        names.push(`${sessionStem(n)}.log`, `${sessionStem(n)}.log.1`);
    }
    const attempted = [];
    const fakeFs = {
        readdirSync: () => names.slice(),
        unlinkSync: (file) => {
            attempted.push(path.basename(file));
            if (path.basename(file) === `${sessionStem(1)}.log`) throw new Error('EBUSY');
        },
    };

    let removed;
    assert.doesNotThrow(() => { removed = pruneOldLogs('/logs', { fs: fakeFs }); });

    assert.deepEqual(attempted.sort(), [
        `${sessionStem(1)}.log`,
        `${sessionStem(1)}.log.1`,
        `${sessionStem(2)}.log`,
        `${sessionStem(2)}.log.1`,
    ]);
    assert.deepEqual(removed.sort(), [
        `${sessionStem(1)}.log.1`,
        `${sessionStem(2)}.log`,
        `${sessionStem(2)}.log.1`,
    ]);

    const unreadable = { readdirSync: () => { throw new Error('EACCES'); }, unlinkSync: () => {} };
    assert.doesNotThrow(() => pruneOldLogs('/logs', { fs: unreadable }));
});

test('lib/startupRuntime.js prunes with the helper when it starts', (t) => {
    const dir = makeLogDir(t);
    for (let n = 1; n <= 12; n++) writeSession(dir, n);
    touch(dir, 'startup-latest.log.1');

    // startupRuntime installs itself when required, so it runs in a child process.
    const result = spawnSync(
        process.execPath,
        ['-r', path.join(repoRoot, 'lib', 'startupRuntime.js'), '-e', 'void 0'],
        {
            cwd: dir,
            env: { ...process.env, NEXTRA_LOG_DIR: dir },
            encoding: 'utf8',
            windowsHide: true,
            timeout: 30000,
        }
    );
    assert.equal(result.status, 0, result.stderr);

    const left = listLogDir(dir);
    for (const n of [1, 2]) {
        for (const suffix of ['.log', '.log.1', '.log.2']) {
            assert.ok(!left.includes(`${sessionStem(n)}${suffix}`), `${sessionStem(n)}${suffix} should be pruned`);
        }
    }
    for (let n = 3; n <= 12; n++) {
        for (const suffix of ['.log', '.log.1', '.log.2']) {
            assert.ok(left.includes(`${sessionStem(n)}${suffix}`), `${sessionStem(n)}${suffix} should stay`);
        }
    }
    assert.ok(left.includes('startup-latest.log.1'));
    assert.ok(left.includes('startup-latest.log'), 'the new run writes its own latest log');
});

test('the helper ships with the packaged app: it sits in lib/, which the packager copies whole, and needs only Node', () => {
    const packager = fs.readFileSync(path.join(repoRoot, 'scripts', 'package-app.js'), 'utf8');
    const sourceEntries = /const sourceEntries = \[([^\]]*)\]/.exec(packager);
    assert.ok(sourceEntries, 'package-app.js lists sourceEntries');
    assert.match(sourceEntries[1], /'lib'/, 'lib/ is copied as a directory, so startupLogRetention.js is included');
    assert.ok(!/startupLogRetention/.test(packager), 'no per-file list that would need the new module');

    const runtime = fs.readFileSync(path.join(repoRoot, 'lib', 'startupRuntime.js'), 'utf8');
    assert.match(runtime, /require\('\.\/startupLogRetention'\)/);

    const helper = fs.readFileSync(path.join(repoRoot, 'lib', 'startupLogRetention.js'), 'utf8');
    const required = [...helper.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
    assert.deepEqual(required.sort(), ['fs', 'path']);
});
