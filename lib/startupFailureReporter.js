'use strict';

// Failure reporting for the packaged app, kept free of side effects (unlike
// lib/startupRuntime.js, which patches process.stdout/stderr when it is required) so that
// tests can load it and drive it with a fake process.

const childProcess = require('child_process');
const util = require('util');

const DIALOG_TITLE = 'Nextra stopped';
// Keeps the log path, which comes last, inside the dialog however long the error text is.
const MAX_SUMMARY_CHARS = 1200;

function formatValue(value) {
    if (value instanceof Error) {
        return value.stack || value.message;
    }

    if (typeof value === 'string') {
        return value;
    }

    return util.inspect(value, { depth: 5, breakLength: 120 });
}

// Nothing in the process tells startup apart from steady state, so the text must not claim
// a startup failure: the same non-zero exit can come from a crash hours after start.
function formatFailureMessage({ code, summary, logPath }) {
    let detail = String(summary || '').trim();
    if (detail.length > MAX_SUMMARY_CHARS) detail = `${detail.slice(0, MAX_SUMMARY_CHARS)}\n...`;

    return [
        `Nextra stopped unexpectedly (exit code ${code}).`,
        '',
        detail || 'No error text was captured.',
        '',
        logPath
            ? `Startup log: ${logPath}`
            : 'Startup log path unavailable.',
    ].join('\n');
}

// The notifier shows a modal Popup through powershell.exe with a 15 second timeout. It
// blocks until the user dismisses it or the timeout passes, so it belongs only on the exit
// path, where the process is already gone. execFileSync is looked up on each call.
function createDialogNotifier({ logPath = '', execFileSync, env = process.env } = {}) {
    return ({ code, summary }) => {
        const run = execFileSync || childProcess.execFileSync;
        const message = formatFailureMessage({ code, summary, logPath });

        try {
            run(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-Command',
                    `$wshell = New-Object -ComObject Wscript.Shell; $wshell.Popup($env:NEXTRA_ERROR_TEXT, 15, '${DIALOG_TITLE}', 16) | Out-Null`,
                ],
                {
                    env: {
                        ...env,
                        NEXTRA_ERROR_TEXT: message,
                    },
                    stdio: 'ignore',
                    windowsHide: true,
                }
            );
        } catch {
            // Ignore notification failures and rely on the startup log instead.
        }
    };
}

// Installs the process-level reporting on `processLike` (the real process, or an
// EventEmitter in tests).
//   uncaughtExceptionMonitor: Node emits it for every uncaught exception before any
//     'uncaughtException' listener runs, also for one the app then handles and survives. It
//     only writes the log line (synchronously) and remembers the error text.
//   exit: a non-zero code calls notify({ code, summary }) once, on Windows only. summary is
//     the remembered error text, else getFallbackText() (the app passes the last stderr
//     lines), else empty.
function installFailureReporter(processLike, { notify, platform = process.platform, log, getFallbackText } = {}) {
    const writeLog = typeof log === 'function' ? log : () => {};
    let rememberedError = '';
    let notified = false;

    processLike.on('uncaughtExceptionMonitor', (error, origin) => {
        writeLog(`uncaught exception (${origin}): `, error);
        rememberedError = formatValue(error);
    });

    processLike.on('exit', (code) => {
        writeLog('process exit code: ', code);
        if (code === 0 || notified || platform !== 'win32' || typeof notify !== 'function') return;
        notified = true;

        const summary = rememberedError || (typeof getFallbackText === 'function' ? getFallbackText() : '') || '';
        try {
            notify({ code, summary });
        } catch {
            // A failing notifier must not change the exit.
        }
    });
}

module.exports = {
    DIALOG_TITLE,
    MAX_SUMMARY_CHARS,
    createDialogNotifier,
    formatFailureMessage,
    formatValue,
    installFailureReporter,
};
