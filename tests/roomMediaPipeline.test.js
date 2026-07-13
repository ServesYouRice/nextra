const test = require('node:test');
const assert = require('node:assert/strict');

const { RoomMediaPipeline } = require('../lib/roomMediaPipeline');

test('RoomMediaPipeline closes owned resources in reverse order exactly once', () => {
    const room = { fallbackStarting: false };
    const closed = [];
    let closeNotifications = 0;
    const pipeline = new RoomMediaPipeline(room, {
        onClose: () => { closeNotifications += 1; },
    });

    const generation = pipeline.beginStart();
    pipeline.own('transport', {}, () => closed.push('transport'));
    pipeline.own('consumer', {}, () => closed.push('consumer'));
    pipeline.own('relay', {}, () => closed.push('relay'));
    pipeline.markRunning(generation);

    assert.equal(pipeline.close(), true);
    assert.equal(pipeline.close(), false);
    assert.deepEqual(closed, ['relay', 'consumer', 'transport']);
    assert.equal(closeNotifications, 1);
    assert.equal(room.fallbackStarting, false);
    assert.equal(pipeline.state, 'closed');
});

test('RoomMediaPipeline invalidates an in-flight startup when closed', () => {
    const room = { fallbackStarting: false };
    const pipeline = new RoomMediaPipeline(room);
    const generation = pipeline.beginStart();

    assert.equal(room.fallbackStarting, true);
    pipeline.close();
    assert.throws(() => pipeline.assertCurrent(generation), /cancelled/);
    assert.throws(() => pipeline.markRunning(generation), /cancelled/);
});

test('RoomMediaPipeline replaces an owned timer without leaking the previous one', () => {
    const room = { fallbackStarting: false };
    const cleared = [];
    const pipeline = new RoomMediaPipeline(room);
    pipeline.beginStart();

    pipeline.setTimer('startup', 1, (timer) => cleared.push(timer));
    pipeline.setTimer('startup', 2, (timer) => cleared.push(timer));
    pipeline.close();

    assert.deepEqual(cleared, [1, 2]);
});
