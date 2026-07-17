'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const util = require('util');

const contextStore = new AsyncLocalStorage();
const levels = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function normalizeLevel(value) {
    const candidate = String(value || 'info').trim().toLowerCase();
    return Object.hasOwn(levels, candidate) ? candidate : 'info';
}

function serializeError(error) {
    return {
        name: error.name,
        message: error.message,
        stack: error.stack,
    };
}

function formatArguments(args) {
    return util.format(...args.map((value) => value instanceof Error ? serializeError(value) : value));
}

function createLogger(options = {}) {
    const minimumLevel = normalizeLevel(options.level || process.env.LOG_LEVEL);
    const json = String(options.format || process.env.LOG_FORMAT || '').trim().toLowerCase() === 'json';
    const sink = options.sink || console;

    const write = (level, args, fields = {}) => {
        if (levels[level] < levels[minimumLevel]) return;
        const context = contextStore.getStore() || {};
        const message = formatArguments(args);
        if (json) {
            sink[level === 'debug' || level === 'info' ? 'log' : level](JSON.stringify({
                timestamp: new Date().toISOString(),
                level,
                message,
                ...context,
                ...fields,
            }));
            return;
        }
        sink[level === 'debug' || level === 'info' ? 'log' : level](message);
    };

    return {
        debug: (...args) => write('debug', args),
        info: (...args) => write('info', args),
        warn: (...args) => write('warn', args),
        error: (...args) => write('error', args),
        child(fields = {}) {
            return {
                debug: (...args) => write('debug', args, fields),
                info: (...args) => write('info', args, fields),
                warn: (...args) => write('warn', args, fields),
                error: (...args) => write('error', args, fields),
            };
        },
    };
}

function runWithLogContext(fields, callback) {
    return contextStore.run({ ...(contextStore.getStore() || {}), ...fields }, callback);
}

function installConsoleLogger(options = {}) {
    const original = {
        log: console.log.bind(console),
        debug: console.debug.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    };
    const logger = createLogger({ ...options, sink: original });
    console.log = logger.info;
    console.debug = logger.debug;
    console.warn = logger.warn;
    console.error = logger.error;
    return logger;
}

module.exports = { createLogger, installConsoleLogger, runWithLogContext };
