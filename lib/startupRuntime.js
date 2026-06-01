const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { execFileSync } = require('child_process');

function makeTimestamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '-',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join('');
}

function resolveLogDir() {
    const candidates = [
        process.env.NEXTRA_LOG_DIR,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Nextra', 'logs') : '',
        path.join(os.tmpdir(), 'Nextra', 'logs'),
        path.join(process.cwd(), 'logs'),
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            fs.mkdirSync(candidate, { recursive: true });
            return candidate;
        } catch {
            // Try the next fallback path.
        }
    }

    return '';
}

function pruneOldLogs(logDir) {
    if (!logDir) return;

    try {
        const files = fs.readdirSync(logDir)
            .filter((name) => /^startup-\d{8}-\d{6}-\d+\.log$/.test(name))
            .sort()
            .reverse();

        files.slice(10).forEach((name) => {
            try {
                fs.unlinkSync(path.join(logDir, name));
            } catch {
                // Ignore log pruning failures.
            }
        });
    } catch {
        // Ignore log pruning failures.
    }
}

function formatValue(value) {
    if (value instanceof Error) {
        return value.stack || value.message;
    }

    if (typeof value === 'string') {
        return value;
    }

    return util.inspect(value, { depth: 5, breakLength: 120 });
}

function installStartupRuntime() {
    const logDir = resolveLogDir();
    const sessionPath = logDir
        ? path.join(logDir, `startup-${makeTimestamp()}-${process.pid}.log`)
        : '';
    const latestPath = logDir ? path.join(logDir, 'startup-latest.log') : '';

    if (latestPath) {
        try {
            fs.writeFileSync(latestPath, '', 'utf8');
        } catch {
            // Ignore and continue without latest log mirroring.
        }
    }

    function createLogStream(filePath) {
        if (!filePath) return null;
        try {
            const stream = fs.createWriteStream(filePath, { flags: 'a' });
            stream.on('error', () => {
                // Ignore write failures to keep startup/runtime moving.
            });
            return stream;
        } catch {
            return null;
        }
    }

    const sessionStream = createLogStream(sessionPath);
    const latestStream = createLogStream(latestPath);

    const appendSync = (text) => {
        if (!logDir) return;
        try {
            fs.appendFileSync(sessionPath, text, 'utf8');
        } catch {
            // Ignore write failures to keep startup moving.
        }

        if (latestPath) {
            try {
                fs.appendFileSync(latestPath, text, 'utf8');
            } catch {
                // Ignore write failures to keep startup moving.
            }
        }
    };

    const append = (chunk, { sync = false } = {}) => {
        if (!logDir) return;

        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (!text) return;

        if (sync || (!sessionStream && !latestStream)) {
            appendSync(text);
            return;
        }

        if (sessionStream?.writable) sessionStream.write(text);
        if (latestStream?.writable) latestStream.write(text);
    };

    let lastErrorSnippet = '';
    let failureNotified = false;

    const writeLine = (label, value) => {
        append(`[${new Date().toISOString()}] ${label}${formatValue(value)}\n`);
    };

    const writeLineSync = (label, value) => {
        append(`[${new Date().toISOString()}] ${label}${formatValue(value)}\n`, { sync: true });
    };

    const rememberErrorText = (text) => {
        if (!text) return;

        const normalized = text
            .replace(/\0/g, '')
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(-8)
            .join('\n');

        if (normalized) {
            lastErrorSnippet = normalized.slice(-1200);
        }
    };

    const showFailureDialog = (summary) => {
        if (failureNotified || process.platform !== 'win32') return;
        failureNotified = true;

        const message = [
            'Nextra could not start correctly.',
            '',
            summary || 'The app exited unexpectedly during startup.',
            '',
            latestPath
                ? `Startup log: ${latestPath}`
                : 'Startup log path unavailable.',
        ].join('\n');

        try {
            execFileSync(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-Command',
                    '$wshell = New-Object -ComObject Wscript.Shell; $wshell.Popup($env:NEXTRA_ERROR_TEXT, 15, \'Nextra startup failed\', 16) | Out-Null',
                ],
                {
                    env: {
                        ...process.env,
                        NEXTRA_ERROR_TEXT: message.slice(0, 1800),
                    },
                    stdio: 'ignore',
                    windowsHide: true,
                }
            );
        } catch {
            // Ignore notification failures and rely on the startup log instead.
        }
    };

    pruneOldLogs(logDir);
    process.env.NEXTRA_PACKAGED = '1';
    if (logDir) {
        process.env.NEXTRA_LOG_DIR = logDir;
        process.env.NEXTRA_SESSION_LOG_PATH = sessionPath;
        process.env.NEXTRA_LATEST_LOG_PATH = latestPath;
    }

    const stdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, encoding, callback) => {
        append(chunk);
        return stdoutWrite(chunk, encoding, callback);
    };

    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, encoding, callback) => {
        append(chunk);
        rememberErrorText(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        return stderrWrite(chunk, encoding, callback);
    };

    process.on('warning', (warning) => writeLine('process warning: ', warning));
    process.on('uncaughtExceptionMonitor', (error, origin) => {
        writeLineSync(`uncaught exception (${origin}): `, error);
        showFailureDialog(formatValue(error));
    });
    process.on('exit', (code) => {
        writeLineSync('process exit code: ', code);
        if (code !== 0) {
            showFailureDialog(lastErrorSnippet || `Exit code ${code}`);
        }
    });

    writeLine('packaged startup log dir: ', logDir || 'unavailable');
    writeLine('node execPath: ', process.execPath);
    writeLine('initial cwd: ', process.cwd());
    writeLine('argv: ', process.argv);
}

installStartupRuntime();
