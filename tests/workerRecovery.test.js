const test = require('node:test');
const assert = require('node:assert/strict');

const { decideWorkerDeathAction } = require('../lib/workerRecovery');

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
});
