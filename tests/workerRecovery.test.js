const test = require('node:test');
const assert = require('node:assert/strict');

const { EventEmitter } = require('node:events');
const { decideWorkerDeathAction, launchReplacementProcess } = require('../lib/workerRecovery');

test('worker death is ignored during intentional shutdown', () => {
    assert.equal(decideWorkerDeathAction({ isShuttingDown: true, uptimeSeconds: 120 }), 'ignore');
});

test('worker death during startup exits without entering a restart loop', () => {
    assert.equal(decideWorkerDeathAction({ uptimeSeconds: 0 }), 'exit');
    assert.equal(decideWorkerDeathAction({ uptimeSeconds: 29.99 }), 'exit');
    assert.equal(decideWorkerDeathAction({ uptimeSeconds: Number.NaN }), 'exit');
});

test('worker death after stable uptime restarts the process', () => {
    assert.equal(decideWorkerDeathAction({ uptimeSeconds: 30 }), 'restart');
    assert.equal(decideWorkerDeathAction({ uptimeSeconds: 600 }), 'restart');
    assert.equal(decideWorkerDeathAction({ uptimeSeconds: 600, supervised: false }), 'restart');
});

test('worker death after stable uptime under a declared supervisor exits for it to restart Nextra', () => {
    assert.equal(decideWorkerDeathAction({ uptimeSeconds: 30, supervised: true }), 'exit-for-supervisor');
    assert.equal(decideWorkerDeathAction({ uptimeSeconds: 600, supervised: true }), 'exit-for-supervisor');
});

test('a declared supervisor changes neither the startup-crash exit nor the intentional-shutdown ignore', () => {
    assert.equal(decideWorkerDeathAction({ uptimeSeconds: 0, supervised: true }), 'exit');
    assert.equal(decideWorkerDeathAction({ uptimeSeconds: Number.NaN, supervised: true }), 'exit');
    assert.equal(decideWorkerDeathAction({ isShuttingDown: true, uptimeSeconds: 120, supervised: true }), 'ignore');
});

// A child process that only records what it is asked, and ends when the test says so.
function createFakeSpawn({ throwOnSpawn = null } = {}) {
    const calls = [];
    const spawn = (command, args, options) => {
        if (throwOnSpawn) throw throwOnSpawn;
        const child = new EventEmitter();
        child.pid = 4242;
        child.killed = [];
        child.kill = (signal) => { child.killed.push(signal); return true; };
        calls.push({ command, args, options, child });
        return child;
    };
    return { spawn, calls };
}

function createRecordingLog() {
    const entries = [];
    return {
        entries,
        log: (...args) => entries.push(['log', ...args]),
        warn: (...args) => entries.push(['warn', ...args]),
        error: (...args) => entries.push(['error', ...args]),
    };
}

function launch(overrides = {}) {
    const fake = overrides.fake || createFakeSpawn();
    const log = createRecordingLog();
    const outcomes = { exits: [], failures: [] };
    const handle = launchReplacementProcess({
        onExit: (code) => outcomes.exits.push(code),
        onFailed: (err) => outcomes.failures.push(err),
        spawn: fake.spawn,
        execPath: '/node',
        args: ['--flag', 'server.js'],
        cwd: '/app',
        env: { A: '1' },
        platform: 'linux',
        ownPid: 100,
        log,
        ...overrides.options,
    });
    return { handle, fake, log, outcomes, child: fake.calls[0]?.child };
}

test('the replacement is an attached child that inherits the output, never a detached one with discarded output', () => {
    const { fake } = launch();

    assert.equal(fake.calls.length, 1);
    const { command, args, options } = fake.calls[0];
    assert.equal(command, '/node');
    assert.deepEqual(args, ['--flag', 'server.js']);
    assert.equal(options.stdio, 'inherit', 'its output is this console\'s output');
    assert.notEqual(options.detached, true, 'a detached child leaves the console and the process group');
    assert.equal(options.cwd, '/app');
    assert.deepEqual(options.env, { A: '1' });
});

test('the original process neither exits nor reports success when the replacement starts', () => {
    const { child, log, outcomes } = launch();

    child.emit('spawn');
    assert.deepEqual(outcomes.exits, [], 'it waits for the replacement');
    assert.deepEqual(outcomes.failures, []);
    const started = log.entries.find((entry) => /Started replacement Nextra \(PID 4242\)/.test(entry[1]));
    assert.ok(started, 'the replacement\'s PID is logged');
    assert.equal(started[0], 'warn', 'a recovery is visible at the default log level');
    assert.match(started[1], /PID 100/);
});

test('the original process exits with the exit code of the replacement', () => {
    for (const code of [0, 1, 3]) {
        const { child, log, outcomes } = launch();
        child.emit('spawn');
        child.emit('exit', code, null);
        child.emit('exit', code, null);

        assert.deepEqual(outcomes.exits, [code]);
        const level = code === 0 ? 'log' : 'error';
        assert.ok(log.entries.some((entry) => entry[0] === level && /Replacement Nextra \(PID 4242\)/.test(entry[1])));
    }
});

test('a replacement stopped by a signal is reported and ends the original with 1', () => {
    const { child, log, outcomes } = launch();
    child.emit('spawn');
    child.emit('exit', null, 'SIGKILL');

    assert.deepEqual(outcomes.exits, [1]);
    assert.ok(log.entries.some((entry) => entry[0] === 'error' && /stopped by SIGKILL/.test(entry[1])));
});

test('a replacement that cannot be started is reported and fails the original', () => {
    const { child, log, outcomes } = launch();
    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    child.emit('error', err);

    assert.deepEqual(outcomes.failures, [err]);
    assert.deepEqual(outcomes.exits, []);
    assert.ok(log.entries.some((entry) => entry[0] === 'error' && /Failed to relaunch automatically: spawn ENOENT/.test(entry[1])));

    // The failed child never exits as a started one would.
    child.emit('exit', 1, null);
    assert.deepEqual(outcomes.exits, []);
    assert.equal(outcomes.failures.length, 1);
});

test('a spawn that throws is reported and fails the original', () => {
    const err = new Error('invalid arguments');
    const { handle, log, outcomes } = launch({ fake: createFakeSpawn({ throwOnSpawn: err }) });

    assert.deepEqual(outcomes.failures, [err]);
    assert.deepEqual(outcomes.exits, []);
    assert.ok(log.entries.some((entry) => entry[0] === 'error' && /Failed to relaunch automatically/.test(entry[1])));
    assert.doesNotThrow(() => { handle.forwardSignal('SIGTERM'); handle.stop(); });
});

test('an error of a running replacement is logged and does not fail the original', () => {
    const { child, log, outcomes } = launch();
    child.emit('spawn');
    child.emit('error', new Error('kill EPERM'));

    assert.deepEqual(outcomes.failures, []);
    assert.deepEqual(outcomes.exits, []);
    assert.ok(log.entries.some((entry) => entry[0] === 'error' && /reported an error: kill EPERM/.test(entry[1])));
});

test('on POSIX a stop signal sent to the original alone is passed on to the replacement', () => {
    const { handle, child } = launch();
    child.emit('spawn');
    handle.forwardSignal('SIGTERM');
    handle.forwardSignal('SIGINT');
    handle.forwardSignal('SIGHUP');
    handle.forwardSignal('SMOKE_TEST');

    assert.deepEqual(child.killed, ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGTERM']);

    child.emit('exit', 0, null);
    handle.forwardSignal('SIGTERM');
    assert.equal(child.killed.length, 4, 'nothing is sent to a replacement that ended');
});

test('on Windows the console already delivers Ctrl+C, Ctrl+Break and a window close to the replacement', () => {
    // child.kill() there is TerminateProcess, which would skip the replacement's own
    // graceful shutdown, so nothing is passed on.
    const { handle, child } = launch({ options: { platform: 'win32' } });
    child.emit('spawn');
    handle.forwardSignal('SIGINT');
    handle.forwardSignal('SIGBREAK');
    handle.forwardSignal('SIGHUP');

    assert.deepEqual(child.killed, []);
});

test('stop ends the replacement so a fatal error in the original leaves no second instance', () => {
    const { handle, child } = launch();
    child.emit('spawn');
    handle.stop();
    assert.deepEqual(child.killed, ['SIGTERM']);

    child.emit('exit', 0, null);
    handle.stop();
    assert.deepEqual(child.killed, ['SIGTERM']);
});

test('launching a replacement needs both outcome callbacks', () => {
    assert.throws(() => launchReplacementProcess({ onFailed() {} }), /onExit/);
    assert.throws(() => launchReplacementProcess({ onExit() {} }), /onFailed/);
});
