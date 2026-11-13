const test = require('node:test');
const assert = require('node:assert/strict');

const stepsModule = import('../src/lib/obsSetupSteps.mjs');

async function statesFor(input) {
    const { obsSetupSteps } = await stepsModule;
    return obsSetupSteps({ progress: '', whipConnected: false, autoStart: true, ...input })
        .map(({ state }) => state);
}

test('the three OBS setup steps keep their ids, labels and order', async () => {
    const { obsSetupSteps } = await stepsModule;
    const steps = obsSetupSteps({ autoStatus: '', progress: '', whipConnected: false, autoStart: true });
    assert.deepEqual(steps.map(({ id, label }) => [id, label]), [
        ['found', 'OBS found on this computer'],
        ['settings', 'Nextra applies the stream settings'],
        ['streaming', 'OBS starts streaming'],
    ]);
    assert.deepEqual(steps.map(({ hint }) => hint), ['', '', '']);
});

test('before a setup starts every OBS step is idle', async () => {
    assert.deepEqual(await statesFor({ autoStatus: '' }), ['idle', 'idle', 'idle']);
});

test('a setup in progress works on the step its reported progress has reached', async () => {
    assert.deepEqual(await statesFor({ autoStatus: 'configuring' }), ['working', 'waiting', 'waiting']);
    assert.deepEqual(await statesFor({ autoStatus: 'configuring', progress: 'connected' }), ['done', 'working', 'waiting']);
    assert.deepEqual(await statesFor({ autoStatus: 'configuring', progress: 'configured' }), ['done', 'done', 'working']);
});

test('a finished setup waits on OBS to stream, and asks the host to press Start when Nextra does not', async () => {
    const { obsSetupSteps } = await stepsModule;
    assert.deepEqual(await statesFor({ autoStatus: 'success', progress: 'configured', autoStart: true }), ['done', 'done', 'working']);

    const manual = obsSetupSteps({ autoStatus: 'success', progress: 'configured', whipConnected: false, autoStart: false });
    assert.deepEqual(manual.map(({ state }) => state), ['done', 'done', 'waiting']);
    assert.equal(manual[2].hint, 'Press Start Streaming in OBS.');
    assert.deepEqual(manual.slice(0, 2).map(({ hint }) => hint), ['', '']);
});

test('once OBS streams into the room every step is done, whatever the setup status', async () => {
    for (const autoStatus of ['', 'configuring', 'success', 'error']) {
        assert.deepEqual(
            await statesFor({ autoStatus, whipConnected: true, autoStart: false }),
            ['done', 'done', 'done'],
            autoStatus,
        );
    }
    const { obsSetupSteps } = await stepsModule;
    const steps = obsSetupSteps({ autoStatus: 'success', progress: 'configured', whipConnected: true, autoStart: false });
    assert.equal(steps[2].hint, '');
});

test('a failed setup marks the step it stopped at and leaves the later ones waiting', async () => {
    assert.deepEqual(await statesFor({ autoStatus: 'error' }), ['attention', 'waiting', 'waiting']);
    assert.deepEqual(await statesFor({ autoStatus: 'error', progress: 'connected' }), ['done', 'attention', 'waiting']);
    assert.deepEqual(await statesFor({ autoStatus: 'error', progress: 'configured' }), ['done', 'done', 'attention']);
});
