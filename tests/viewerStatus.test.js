'use strict';

// Tests of src/lib/viewerStatus.mjs, the one status chip on the viewer's
// picture: a short label and a tone for how the picture is reaching the viewer.

const test = require('node:test');
const assert = require('node:assert/strict');

const loadStatus = () => import('../src/lib/viewerStatus.mjs');

const webRtc = { watching: true, playbackMode: 'mediasoup', fallbackMode: false, fallbackState: null };

test('a viewer that is neither watching nor in fallback mode has no status chip', async () => {
    const { describeViewerStatus } = await loadStatus();
    assert.equal(describeViewerStatus({ watching: false, playbackMode: '', fallbackMode: false, fallbackState: null }), null);
    assert.equal(describeViewerStatus({
        watching: false, playbackMode: '', fallbackMode: false, fallbackState: null, quality: 'good', pictureInterrupted: true,
    }), null, 'nothing to report before the picture starts');
});

test('an interrupted picture reads Reconnecting, whatever the connection measures', async () => {
    const { describeViewerStatus } = await loadStatus();
    assert.deepEqual(
        describeViewerStatus({ ...webRtc, quality: 'excellent', pictureInterrupted: true }),
        { label: 'Reconnecting', tone: 'warn' },
    );
});

test('fallback mode reads Connecting until the relay player is playing', async () => {
    const { describeViewerStatus } = await loadStatus();
    // The fallbackState values WatchView sets: null before the player exists,
    // then the fMP4 relay player's own states.
    for (const fallbackState of [null, 'connecting', 'buffering', 'error', 'stopped']) {
        assert.deepEqual(
            describeViewerStatus({ watching: false, playbackMode: '', fallbackMode: true, fallbackState }),
            { label: 'Connecting', tone: 'info' },
            String(fallbackState),
        );
    }
});

test('relay playback and a playing fallback read Backup connection', async () => {
    const { describeViewerStatus } = await loadStatus();
    assert.deepEqual(
        describeViewerStatus({ watching: false, playbackMode: '', fallbackMode: true, fallbackState: 'playing' }),
        { label: 'Backup connection', tone: 'info' },
    );
    assert.deepEqual(
        describeViewerStatus({ watching: true, playbackMode: 'relay', fallbackMode: false, fallbackState: null, quality: 'poor' }),
        { label: 'Backup connection', tone: 'info' },
        'the relay has no WebRTC quality to report',
    );
});

test('WebRTC playback reads the measured connection quality', async () => {
    const { describeViewerStatus } = await loadStatus();
    const cases = [
        ['excellent', { label: 'Good connection', tone: 'ok' }],
        ['good', { label: 'Good connection', tone: 'ok' }],
        ['fair', { label: 'Fair connection', tone: 'warn' }],
        ['poor', { label: 'Poor connection', tone: 'err' }],
        ['unknown', { label: 'Connected', tone: 'ok' }],
        [undefined, { label: 'Connected', tone: 'ok' }],
        [null, { label: 'Connected', tone: 'ok' }],
    ];
    for (const [quality, expected] of cases) {
        assert.deepEqual(describeViewerStatus({ ...webRtc, quality }), expected, String(quality));
    }
});
