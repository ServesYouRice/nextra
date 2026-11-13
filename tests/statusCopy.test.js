const test = require('node:test');
const assert = require('node:assert/strict');

test('restricted Status copy describes the UI that exists', async () => {
    const { STATUS_ACCESS_RESTRICTED_COPY } = await import('../src/lib/statusCopy.mjs');
    assert.match(STATUS_ACCESS_RESTRICTED_COPY, /open it on the host machine/i);
    assert.match(STATUS_ACCESS_RESTRICTED_COPY, /remote API clients must authenticate separately/i);
    // A host signed in with the host password gets the metrics too (the session authorizes /api/metrics).
    assert.match(STATUS_ACCESS_RESTRICTED_COPY, /sign in on the Host page/i);
    assert.doesNotMatch(STATUS_ACCESS_RESTRICTED_COPY, /with a metrics token/i);
});

test('formatPlainDuration writes short plain durations', async () => {
    const { formatPlainDuration } = await import('../src/lib/statusCopy.mjs');
    assert.equal(formatPlainDuration(45), '45 s');
    assert.equal(formatPlainDuration(540), '9 min');
    assert.equal(formatPlainDuration(7500), '2 h 5 min');
    assert.equal(formatPlainDuration(3 * 86400 + 4 * 3600 + 120), '3 d 4 h');
    assert.equal(formatPlainDuration(-5), '0 s');
    assert.equal(formatPlainDuration('soon'), '0 s');
    assert.equal(formatPlainDuration(undefined), '0 s');
});

test('describeRoomState says whether a picture is arriving', async () => {
    const { describeRoomState } = await import('../src/lib/statusCopy.mjs');
    assert.equal(describeRoomState({ hasProducer: true }), 'Live');
    assert.equal(describeRoomState({ whipConnected: true }), 'Live');
    assert.equal(describeRoomState({}), 'Host paused');
});

test('describeRoomSource says where the picture comes from', async () => {
    const { describeRoomSource } = await import('../src/lib/statusCopy.mjs');
    assert.equal(describeRoomSource({}), 'From this browser');
    assert.equal(describeRoomSource({ ingestMode: 'obs' }), 'From OBS');
    assert.equal(describeRoomSource({ ingestMode: 'obs', obsAv1Mode: true }), 'From OBS · AV1');
    assert.equal(describeRoomSource({ ingestMode: 'obs', obsVideoCodec: 'av1' }), 'From OBS · AV1');
});

test('countRoomViewers adds WebRTC and WHEP viewers', async () => {
    const { countRoomViewers } = await import('../src/lib/statusCopy.mjs');
    assert.equal(countRoomViewers({ viewerCount: 2, whepViewerCount: 1 }), 3);
    assert.equal(countRoomViewers({ viewerCount: 2 }), 2);
    assert.equal(countRoomViewers({}), 0);
});
