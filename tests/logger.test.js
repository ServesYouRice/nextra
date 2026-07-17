'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger, runWithLogContext } = require('../lib/logger');

test('JSON logger includes levels, fields, and request context', () => {
    const lines = [];
    const sink = {
        log: (line) => lines.push(line),
        warn: (line) => lines.push(line),
        error: (line) => lines.push(line),
    };
    const logger = createLogger({ format: 'json', level: 'info', sink });

    runWithLogContext({ requestId: 'request-1' }, () => {
        logger.child({ roomCode: '[REDACTED]' }).info('room %s', 'created');
        logger.debug('hidden');
    });

    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.level, 'info');
    assert.equal(record.message, 'room created');
    assert.equal(record.requestId, 'request-1');
    assert.equal(record.roomCode, '[REDACTED]');
});
