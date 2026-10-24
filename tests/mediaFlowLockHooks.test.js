'use strict';

// tests/browser/media-flow.spec.mjs serialises its tests across workers with a
// lock taken in test.beforeEach and given back in test.afterEach. Playwright
// enforces the test timeout by racing each hook against a deadline: when the
// timeout fires inside beforeEach, Playwright stops waiting for the hook (the
// hook is not interrupted, so its own catch never runs), runs the afterEach
// hooks, and then discards the worker. These tests load the real spec with
// @playwright/test replaced by a stub that only collects the hooks, and drive
// the hooks the way Playwright does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

const specUrl = pathToFileURL(path.join(__dirname, 'browser', 'media-flow.spec.mjs')).href;

const stubSource = [
    'const hooks = (type) => globalThis.__mediaFlowSpecHooks[type];',
    'export const test = Object.assign(() => {}, {',
    '    beforeEach: (fn) => { hooks("beforeEach").push(fn); },',
    '    afterEach: (fn) => { hooks("afterEach").push(fn); },',
    '});',
    'export const expect = () => { throw new Error("expect is only available inside Playwright"); };',
    'export const devices = {};',
].join('\n');
const stubUrl = `data:text/javascript,${encodeURIComponent(stubSource)}`;
const loaderSource = [
    'export async function resolve(specifier, context, nextResolve) {',
    `    if (specifier === '@playwright/test' && String(context.parentURL).startsWith(${JSON.stringify(specUrl)})) {`,
    `        return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };`,
    '    }',
    '    return nextResolve(specifier, context);',
    '}',
].join('\n');
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`);

// Every Playwright worker loads the spec on its own; a distinct URL gives each
// "worker" here its own module instance and so its own hook state.
async function loadWorker(name) {
    const hooks = { beforeEach: [], afterEach: [] };
    globalThis.__mediaFlowSpecHooks = hooks;
    await import(`${specUrl}?worker=${name}`);
    assert.equal(hooks.beforeEach.length, 1);
    assert.equal(hooks.afterEach.length, 1);
    return {
        beforeEach: (testInfo) => hooks.beforeEach[0]({ browser: { newContext: async () => null } }, testInfo),
        afterEach: () => hooks.afterEach[0](),
    };
}

function testInfo(workerIndex, outputDir) {
    return { workerIndex, project: { outputDir } };
}

async function list(directory) {
    try {
        return (await fs.readdir(directory)).sort();
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settleWithin(promise, ms) {
    let timer;
    const pending = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ state: 'pending' }), ms);
    });
    try {
        return await Promise.race([
            promise.then(() => ({ state: 'resolved' }), (error) => ({ state: 'rejected', error })),
            pending,
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function useScratchProject(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nextra-media-flow-lock-'));
    const previousCwd = process.cwd();
    process.chdir(root);
    const cleanups = [];
    t.after(async () => {
        process.chdir(previousCwd);
        // Removing the folder ends any wait that is still polling it; the
        // afterEach calls then close any loopback proxy still listening.
        await fs.rm(root, { recursive: true, force: true });
        for (const cleanup of cleanups) await cleanup();
        await fs.rm(root, { recursive: true, force: true });
    });
    return { root, onCleanup: (fn) => cleanups.push(fn) };
}

test('a media-flow test that times out in beforeEach waiting for the lock leaves nothing that blocks later tests', async (t) => {
    const { root, onCleanup } = await useScratchProject(t);
    const outputDir = path.join(root, 'test-results');
    const lockDirectory = path.join(outputDir, '.media-flow-lock');
    const holder = await loadWorker('holder');
    const waiter = await loadWorker('waiter');
    const started = [];
    onCleanup(async () => {
        await Promise.allSettled(started);
        await waiter.afterEach();
        await holder.afterEach();
    });

    // A test in another worker holds the lock.
    await holder.beforeEach(testInfo(1, outputDir));
    const whileHeld = await list(lockDirectory);
    assert.notDeepEqual(whileHeld, []);

    // This worker's test queues behind it, and its timeout fires in beforeEach:
    // Playwright abandons the hook and runs afterEach.
    const timedOut = waiter.beforeEach(testInfo(0, outputDir));
    started.push(timedOut);
    timedOut.catch(() => {});
    for (let waited = 0; waited < 2_000 && (await list(lockDirectory)).length === whileHeld.length; waited += 25) {
        await delay(25);
    }
    await waiter.afterEach();

    assert.deepEqual(await list(lockDirectory), whileHeld,
        'afterEach left the timed-out test queued for the lock');
    assert.equal((await settleWithin(timedOut, 2_000)).state, 'rejected',
        'the abandoned beforeEach is still waiting for the lock after its afterEach ran');

    // The holder finishes, and the next test must get the lock.
    await holder.afterEach();
    const next = waiter.beforeEach(testInfo(0, outputDir));
    started.push(next);
    const outcome = await settleWithin(next, 3_000);
    assert.equal(outcome.state, 'resolved',
        `the next test did not get the lock; lock folder: ${JSON.stringify(await list(lockDirectory))}`);
    await waiter.afterEach();
    assert.deepEqual(await list(lockDirectory), []);
});

test('the media-flow lock lives under the project outputDir, which Playwright clears when a run starts', async (t) => {
    const { root, onCleanup } = await useScratchProject(t);
    const outputDir = path.join(root, 'custom-output');
    const worker = await loadWorker('output-dir');
    onCleanup(() => worker.afterEach());

    await worker.beforeEach(testInfo(0, outputDir));
    assert.notDeepEqual(await list(path.join(outputDir, '.media-flow-lock')), [],
        'the held lock is not under the project outputDir');
    assert.deepEqual(await list(path.join(root, 'test-results')), [],
        'the lock was written under <cwd>/test-results, which a run with another outputDir never clears');
    await worker.afterEach();
    assert.deepEqual(await list(path.join(outputDir, '.media-flow-lock')), []);
});
