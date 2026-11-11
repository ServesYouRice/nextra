'use strict';

// Cleanup shared by the long-running runtime harnesses (benchmark-runtime.js and
// churn-runtime.js). Both hold persistent Socket.IO connections and background
// loops; whichever way a run ends, including a thrown error, it must stop the loops
// and close every socket, or the open sockets keep the process alive after it has
// already failed.

// Closes every socket, including one that is still connecting or already closed. A
// close that throws never stops the remaining sockets from being closed.
function closeSockets(sockets) {
    for (const socket of sockets) {
        try {
            socket.close();
        } catch {
            // Nothing left to release on a socket that cannot be closed.
        }
    }
}

// Waits for every promise to settle, fulfilled or rejected, but for at most
// timeoutMs. Resolves true when all settled and false when the wait gave up. The
// timer is cleared as soon as the wait ends, so it never keeps the process alive.
function settleWithin(promises, timeoutMs) {
    let timer;
    const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const settled = Promise.allSettled(promises).then(() => true);
    return Promise.race([settled, timedOut]).finally(() => clearTimeout(timer));
}

module.exports = { closeSockets, settleWithin };
