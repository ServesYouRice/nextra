'use strict';

function decideWorkerDeathAction({
    isShuttingDown = false,
    uptimeSeconds = 0,
    minimumUptimeSeconds = 30,
} = {}) {
    if (isShuttingDown) return 'ignore';
    if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < minimumUptimeSeconds) return 'exit';
    return 'restart';
}

module.exports = { decideWorkerDeathAction };
