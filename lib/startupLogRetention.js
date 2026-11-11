'use strict';

// Startup-log retention, kept free of side effects (unlike lib/startupRuntime.js, which
// patches process.stdout/stderr when it is required) so that tests can load it.

const nodeFs = require('fs');
const path = require('path');

const DEFAULT_KEEP_SESSIONS = 10;

// One startup session writes startup-<date>-<time>-<pid>.log. When that file grows past
// NEXTRA_LOG_MAX_BYTES, rotation renames it to .log.1 and shifts older generations up
// (.log.1 -> .log.2, ...). A session is the stem plus every generation. startup-latest.log
// and its generations do not match, so session retention never touches them.
const SESSION_LOG_PATTERN = /^(startup-\d{8}-\d{6}-\d+)\.log(?:\.\d+)?$/;

// Keeps the newest `keep` sessions with all their generations and deletes every file of
// older sessions. Returns the names it deleted. Failures are swallowed: pruning must never
// stop startup, and a file that cannot be deleted now is retried on the next start.
function pruneOldLogs(logDir, { fs = nodeFs, keep = DEFAULT_KEEP_SESSIONS } = {}) {
    const removed = [];
    if (!logDir) return removed;

    try {
        const filesByStem = new Map();
        for (const name of fs.readdirSync(logDir)) {
            const match = SESSION_LOG_PATTERN.exec(name);
            if (!match) continue;
            const stem = match[1];
            if (!filesByStem.has(stem)) filesByStem.set(stem, []);
            filesByStem.get(stem).push(name);
        }

        const staleStems = [...filesByStem.keys()].sort().reverse().slice(keep);
        for (const stem of staleStems) {
            for (const name of filesByStem.get(stem)) {
                try {
                    fs.unlinkSync(path.join(logDir, name));
                    removed.push(name);
                } catch {
                    // Ignore log pruning failures.
                }
            }
        }
    } catch {
        // Ignore log pruning failures.
    }

    return removed;
}

module.exports = {
    DEFAULT_KEEP_SESSIONS,
    SESSION_LOG_PATTERN,
    pruneOldLogs,
};
