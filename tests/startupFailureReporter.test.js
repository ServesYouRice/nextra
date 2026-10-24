'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    MAX_SUMMARY_CHARS,
    createDialogNotifier,
    formatFailureMessage,
    installFailureReporter,
} = require('../lib/startupFailureReporter');

const repoRoot = path.resolve(__dirname, '..');
const runtimePath = path.join(repoRoot, 'lib', 'startupRuntime.js');

// lib/startupRuntime.js patches stdout and stderr when it is required, so these tests run it
// in a child process. A preload script, listed before it with -r, makes the child look like
// Windows (or not) and replaces child_process.execFileSync, which would start powershell.exe
// and a modal Popup, with a recorder that appends one JSON line per call.
function makeWorkDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-startup-failure-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const preload = path.join(dir, 'preload.js');
    fs.writeFileSync(preload, [
        "const fs = require('fs');",
        "const childProcess = require('child_process');",
        "Object.defineProperty(process, 'platform', { value: process.env.NEXTRA_TEST_PLATFORM });",
        'childProcess.execFileSync = (file, args, options) => {',
        '    fs.appendFileSync(process.env.NEXTRA_TEST_DIALOG_LOG, JSON.stringify({',
        '        file, args, text: options.env.NEXTRA_ERROR_TEXT,',
        "    }) + '\\n');",
        '};',
        '',
    ].join('\n'));
    return { dir, preload, dialogLog: path.join(dir, 'dialogs.jsonl'), logDir: path.join(dir, 'logs') };
}

function runScenario(t, source, { platform = 'win32' } = {}) {
    const work = makeWorkDir(t);
    const script = path.join(work.dir, 'scenario.js');
    fs.writeFileSync(script, source);
    const result = spawnSync(
        process.execPath,
        ['-r', work.preload, '-r', runtimePath, script],
        {
            cwd: work.dir,
            env: {
                ...process.env,
                NEXTRA_LOG_DIR: work.logDir,
                NEXTRA_TEST_PLATFORM: platform,
                NEXTRA_TEST_DIALOG_LOG: work.dialogLog,
            },
            encoding: 'utf8',
            windowsHide: true,
            timeout: 30000,
        }
    );
    const dialogs = fs.existsSync(work.dialogLog)
        ? fs.readFileSync(work.dialogLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [];
    const latestLog = fs.readFileSync(path.join(work.logDir, 'startup-latest.log'), 'utf8');
    return { result, dialogs, latestLog, logDir: work.logDir };
}

test('an uncaught exception that an uncaughtException listener handles logs a line but shows no dialog', (t) => {
    const { result, dialogs, latestLog } = runScenario(t, [
        "process.on('uncaughtException', () => {});",
        "setTimeout(() => { throw new Error('handled boom'); }, 0);",
        'setTimeout(() => {}, 100);',
        '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    assert.match(latestLog, /uncaught exception \(uncaughtException\): Error: handled boom/);
    assert.match(latestLog, /process exit code: 0/);
    assert.deepEqual(dialogs, [], 'a handled exception must not block the main thread with a dialog');
});

test('a fatal uncaught exception still exits non-zero and shows one dialog that does not claim a startup failure', (t) => {
    const { result, dialogs, latestLog, logDir } = runScenario(t, [
        "setTimeout(() => { throw new Error('fatal boom'); }, 0);",
        'setTimeout(() => {}, 5000);',
        '',
    ].join('\n'));

    assert.notEqual(result.status, 0, 'process exit codes are unchanged');
    assert.match(latestLog, /uncaught exception \(uncaughtException\): Error: fatal boom/);
    assert.match(latestLog, /process exit code: 1/);

    assert.equal(dialogs.length, 1, `expected one dialog, got ${dialogs.length}`);
    assert.equal(dialogs[0].file, 'powershell.exe');
    assert.match(dialogs[0].text, /fatal boom/);
    assert.match(dialogs[0].text, /Nextra stopped unexpectedly/);
    assert.ok(!/start(?:up|ing)? (?:correctly|failed)|could not start/i.test(dialogs[0].text), dialogs[0].text);
    assert.ok(!/startup failed/i.test(dialogs[0].args.join(' ')), 'the dialog title does not say startup failed');
    assert.ok(dialogs[0].text.includes(path.join(logDir, 'startup-latest.log')), 'the dialog shows the latest log path');
});

test('a recovering listener that exits 1 after logging, as server.js does, shows exactly one dialog', (t) => {
    const { result, dialogs } = runScenario(t, [
        "process.on('uncaughtException', (error) => {",
        "    console.error('[fatal] shutdownReason=uncaught-exception:', error.stack);",
        '    process.exit(1);',
        '});',
        "setTimeout(() => { throw new Error('server style boom'); }, 0);",
        'setTimeout(() => {}, 5000);',
        '',
    ].join('\n'));

    assert.equal(result.status, 1);
    assert.equal(dialogs.length, 1, `expected one dialog, got ${dialogs.length}`);
    assert.match(dialogs[0].text, /server style boom/);
});

test('a non-zero exit without any exception shows one dialog with the exit code', (t) => {
    const { result, dialogs } = runScenario(t, 'process.exit(3);\n');

    assert.equal(result.status, 3);
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0].text, /exit code 3/i);
});

test('exit code 0 shows no dialog, also after a handled exception', (t) => {
    const { result, dialogs } = runScenario(t, [
        "process.on('uncaughtException', () => {});",
        "setTimeout(() => { throw new Error('handled before a clean exit'); }, 0);",
        'setTimeout(() => process.exit(0), 50);',
        '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(dialogs, []);
});

test('off Windows nothing is shown, but the exception is still logged and the exit code is unchanged', (t) => {
    const { result, dialogs, latestLog } = runScenario(t, [
        "setTimeout(() => { throw new Error('fatal boom off windows'); }, 0);",
        'setTimeout(() => {}, 5000);',
        '',
    ].join('\n'), { platform: 'linux' });

    assert.notEqual(result.status, 0);
    assert.match(latestLog, /uncaught exception \(uncaughtException\): Error: fatal boom off windows/);
    assert.deepEqual(dialogs, []);
});

// Unit tests with a fake process: an EventEmitter and an injected notifier.
function install({ platform = 'win32', fallback = '' } = {}) {
    const fakeProcess = new EventEmitter();
    const notifications = [];
    const logged = [];
    installFailureReporter(fakeProcess, {
        notify: (info) => notifications.push(info),
        platform,
        log: (label, value) => logged.push({ label, value }),
        getFallbackText: () => fallback,
    });
    return { fakeProcess, notifications, logged };
}

test('the monitor logs the uncaught exception synchronously and does not notify', () => {
    const { fakeProcess, notifications, logged } = install();
    const error = new Error('boom');

    fakeProcess.emit('uncaughtExceptionMonitor', error, 'uncaughtException');

    assert.deepEqual(logged, [{ label: 'uncaught exception (uncaughtException): ', value: error }]);
    assert.equal(notifications.length, 0);
});

test('a handled exception followed by exit code 0 never notifies', () => {
    const { fakeProcess, notifications } = install();

    fakeProcess.emit('uncaughtExceptionMonitor', new Error('handled'), 'uncaughtException');
    fakeProcess.emit('uncaughtExceptionMonitor', new Error('handled again'), 'unhandledRejection');
    fakeProcess.emit('exit', 0);

    assert.equal(notifications.length, 0);
});

test('a non-zero exit notifies exactly once, with the remembered error and the exit code', () => {
    const { fakeProcess, notifications, logged } = install({ fallback: 'stderr text' });

    fakeProcess.emit('uncaughtExceptionMonitor', new Error('fatal'), 'uncaughtException');
    fakeProcess.emit('exit', 1);
    fakeProcess.emit('exit', 1);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].code, 1);
    assert.match(notifications[0].summary, /Error: fatal/);
    assert.ok(!notifications[0].summary.includes('stderr text'), 'the remembered error wins over the stderr fallback');
    assert.ok(logged.some((entry) => entry.label === 'process exit code: ' && entry.value === 1));
});

test('a non-zero exit without an exception falls back to the stderr text, then to nothing', () => {
    const withStderr = install({ fallback: 'last stderr lines' });
    withStderr.fakeProcess.emit('exit', 2);
    assert.deepEqual(withStderr.notifications, [{ code: 2, summary: 'last stderr lines' }]);

    const bare = install();
    bare.fakeProcess.emit('exit', 7);
    assert.deepEqual(bare.notifications, [{ code: 7, summary: '' }]);
});

test('a thrown non-Error value is remembered as readable text', () => {
    const { fakeProcess, notifications } = install();

    fakeProcess.emit('uncaughtExceptionMonitor', { reason: 'plain object' }, 'uncaughtException');
    fakeProcess.emit('exit', 1);

    assert.match(notifications[0].summary, /reason: 'plain object'/);
});

test('off Windows nothing is notified, but the exit is still logged', () => {
    for (const platform of ['linux', 'darwin']) {
        const { fakeProcess, notifications, logged } = install({ platform });
        fakeProcess.emit('uncaughtExceptionMonitor', new Error('fatal'), 'uncaughtException');
        fakeProcess.emit('exit', 1);
        assert.equal(notifications.length, 0, platform);
        assert.equal(logged.length, 2, platform);
    }
});

test('a notifier that throws does not escape the exit handler', () => {
    const fakeProcess = new EventEmitter();
    installFailureReporter(fakeProcess, {
        notify: () => { throw new Error('notifier broke'); },
        platform: 'win32',
    });

    assert.doesNotThrow(() => fakeProcess.emit('exit', 1));
});

test('without a log or notifier option the installer still works', () => {
    const fakeProcess = new EventEmitter();
    installFailureReporter(fakeProcess);

    assert.doesNotThrow(() => {
        fakeProcess.emit('uncaughtExceptionMonitor', new Error('x'), 'uncaughtException');
        fakeProcess.emit('exit', 1);
    });
});

test('the failure message says the app stopped, not that it failed to start, and shows the exit code and log path', () => {
    const message = formatFailureMessage({ code: 1, summary: 'Error: boom\n    at x', logPath: 'C:\\logs\\startup-latest.log' });

    assert.match(message, /^Nextra stopped unexpectedly \(exit code 1\)\./);
    assert.match(message, /Error: boom/);
    assert.match(message, /Startup log: C:\\logs\\startup-latest\.log$/);
    assert.ok(!/could not start|startup failed|during startup/i.test(message), message);

    assert.match(formatFailureMessage({ code: 3, summary: '', logPath: '' }), /No error text was captured\.[\s\S]*Startup log path unavailable\./);
});

test('a very long error text is cut so that the log path stays in the message', () => {
    const logPath = 'C:\\Users\\someone\\AppData\\Local\\Nextra\\logs\\startup-latest.log';
    const message = formatFailureMessage({ code: 1, summary: 'x'.repeat(50000), logPath });

    assert.ok(message.endsWith(`Startup log: ${logPath}`));
    assert.ok(message.length < MAX_SUMMARY_CHARS + 300, `message is ${message.length} characters`);
});

test('the dialog notifier runs powershell.exe once with the message in the environment and swallows failures', () => {
    const calls = [];
    const logPath = 'C:\\logs\\startup-latest.log';
    const notify = createDialogNotifier({
        logPath,
        env: { KEEP: 'yes' },
        execFileSync: (file, args, options) => { calls.push({ file, args, options }); },
    });

    notify({ code: 1, summary: 'Error: boom' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'powershell.exe');
    assert.equal(calls[0].options.env.KEEP, 'yes');
    assert.equal(calls[0].options.env.NEXTRA_ERROR_TEXT, formatFailureMessage({ code: 1, summary: 'Error: boom', logPath }));
    assert.equal(calls[0].options.windowsHide, true);
    assert.ok(calls[0].args.at(-1).includes('Popup($env:NEXTRA_ERROR_TEXT, 15,'), 'timeout is still 15 seconds');
    assert.ok(!/startup failed/i.test(calls[0].args.at(-1)), 'the title does not claim a startup failure');

    const failing = createDialogNotifier({ execFileSync: () => { throw new Error('no powershell'); } });
    assert.doesNotThrow(() => failing({ code: 1, summary: '' }));
});

test('in a real process the installer sees the fatal exception: exit is non-zero and the notifier runs once, from exit', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-startup-failure-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const script = path.join(dir, 'fatal.js');
    fs.writeFileSync(script, [
        `const { installFailureReporter } = require(${JSON.stringify(path.join(repoRoot, 'lib', 'startupFailureReporter.js'))});`,
        'const events = [];',
        "process.on('uncaughtExceptionMonitor', () => events.push('monitor'));",
        'installFailureReporter(process, {',
        "    platform: 'win32',",
        "    notify: ({ code, summary }) => { events.push('notify'); process.stdout.write(JSON.stringify({ events, code, summary })); },",
        '});',
        "setTimeout(() => { throw new Error('real fatal'); }, 0);",
        'setTimeout(() => {}, 5000);',
        '',
    ].join('\n'));

    const result = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 30000 });

    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.events, ['monitor', 'notify'], 'the monitor fires first, the notifier only at exit');
    assert.equal(report.code, result.status);
    assert.match(report.summary, /real fatal/);
});

test('the reporter ships with the packaged app: lib/ is copied whole, the runtime requires it, and it needs only Node', () => {
    const packager = fs.readFileSync(path.join(repoRoot, 'scripts', 'package-app.js'), 'utf8');
    const sourceEntries = /const sourceEntries = \[([^\]]*)\]/.exec(packager);
    assert.ok(sourceEntries, 'package-app.js lists sourceEntries');
    assert.match(sourceEntries[1], /'lib'/);

    const runtime = fs.readFileSync(runtimePath, 'utf8');
    assert.match(runtime, /require\('\.\/startupFailureReporter'\)/);
    assert.ok(!/execFileSync|powershell/i.test(runtime), 'the runtime no longer shows a dialog itself');

    const reporter = fs.readFileSync(path.join(repoRoot, 'lib', 'startupFailureReporter.js'), 'utf8');
    const required = [...reporter.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
    assert.deepEqual(required.sort(), ['child_process', 'util']);
});
