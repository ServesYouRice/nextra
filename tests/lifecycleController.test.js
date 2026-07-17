'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('lifecycle controller closes resources in reverse order once', async () => {
    const { createLifecycleController } = await import('../src/lib/lifecycleController.mjs');
    const closed = [];
    const controller = createLifecycleController();
    controller.own('transport', () => closed.push('transport'));
    controller.own('timer', () => closed.push('timer'));
    controller.close();
    controller.close();
    assert.deepEqual(closed, ['timer', 'transport']);
    assert.equal(controller.closed, true);
});
