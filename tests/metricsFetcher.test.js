const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const metricsFetcherModule = import('../src/lib/metricsFetcher.mjs');
const visibilityPollerModule = import('../src/lib/visibilityPoller.mjs');

const POLL_INTERVAL_MS = 5000;

/** A manual clock: nothing fires until advance() moves it past a deadline. */
function createFakeTimers() {
    let now = 0;
    let nextId = 1;
    const pending = new Map();
    return {
        timers: {
            setTimeout(handler, ms) {
                const id = nextId++;
                pending.set(id, { handler, at: now + ms });
                return id;
            },
            clearTimeout(id) {
                pending.delete(id);
            },
        },
        get pending() {
            return pending.size;
        },
        advance(ms) {
            const target = now + ms;
            for (;;) {
                const due = [...pending.entries()]
                    .filter(([, timer]) => timer.at <= target)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                pending.delete(due[0]);
                now = due[1].at;
                due[1].handler();
            }
            now = target;
        },
    };
}

/**
 * Stands in for fetch(): every call stays pending until the test settles it, and,
 * like the real fetch, rejects with the signal's reason when the signal aborts.
 */
function createFakeFetch({ honorSignal = true } = {}) {
    const calls = [];
    function fetchImpl(url, init) {
        const call = { url, init, signal: init.signal };
        call.promise = new Promise((resolve, reject) => {
            call.resolve = resolve;
            call.reject = reject;
        });
        if (honorSignal) {
            init.signal.addEventListener('abort', () => call.reject(init.signal.reason));
        }
        calls.push(call);
        return call.promise;
    }
    return { fetchImpl, calls };
}

function jsonResponse(payload, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

/** Awaits a load result, but fails the test instead of hanging it if it never settles. */
async function settle(promise) {
    const stuck = Symbol('still pending');
    const outcome = await Promise.race([
        promise,
        (async () => {
            for (let turn = 0; turn < 5; turn += 1) await flush();
            return stuck;
        })(),
    ]);
    assert.notEqual(outcome, stuck, 'the request never settled');
    return outcome;
}

async function createFetcher(options = {}) {
    const { createMetricsFetcher } = await metricsFetcherModule;
    const fake = createFakeFetch(options.fake);
    const clock = createFakeTimers();
    const fetcher = createMetricsFetcher({
        fetchImpl: fake.fetchImpl,
        timeoutMs: 15000,
        timers: clock.timers,
        ...options.fetcher,
    });
    return { fetcher, fake, clock };
}

test('a load while one is in flight returns that same request and aborts nothing', async () => {
    const { fetcher, fake, clock } = await createFetcher();

    const first = fetcher.load();
    const second = fetcher.load();

    assert.equal(second, first, 'overlapping callers must share the in-flight promise');
    assert.equal(fake.calls.length, 1, 'no second request while one is in flight');
    assert.equal(fake.calls[0].signal.aborted, false);

    fake.calls[0].resolve(jsonResponse({ rooms: { active: 1 } }));
    assert.deepEqual(await settle(first), { status: 'ok', payload: { rooms: { active: 1 } } });
    assert.equal(clock.pending, 0, 'the request timeout must be cleared once it settles');

    const third = fetcher.load();
    assert.notEqual(third, first, 'a settled request is not reused');
    assert.equal(fake.calls.length, 2);
    fake.calls[1].resolve(jsonResponse({}));
    await settle(third);
});

test('poll ticks during a request slower than the poll interval do not cancel it', async () => {
    const { fetcher, fake, clock } = await createFetcher();
    const { createVisibilityPoller } = await visibilityPollerModule;

    let tick = null;
    const poller = createVisibilityPoller({
        poll: () => { void fetcher.load(); },
        intervalMs: POLL_INTERVAL_MS,
        visibilityTarget: null,
        timers: {
            setInterval: (handler) => { tick = handler; return 1; },
            clearInterval: () => { tick = null; },
        },
    });
    assert.equal(fake.calls.length, 1, 'the poller starts the first request immediately');

    // The server needs 8s; two ticks (5s and 10s) land before and after it answers.
    clock.advance(POLL_INTERVAL_MS);
    tick();
    assert.equal(fake.calls[0].signal.aborted, false, 'the 5s tick must not abort the slow request');
    assert.equal(fake.calls.length, 1);

    clock.advance(3000);
    fake.calls[0].resolve(jsonResponse({ rooms: { active: 2 } }));
    await flush();

    clock.advance(2000);
    tick();
    assert.equal(fake.calls.length, 2, 'once it settled, the next tick starts a new request');
    assert.equal(fake.calls[0].signal.aborted, false, 'the slow request was never aborted');

    poller.close();
    fetcher.abort();
    await flush();
});

test('a slow request that answers before the timeout succeeds', async () => {
    const { fetcher, fake, clock } = await createFetcher();

    const pending = fetcher.load();
    clock.advance(14000);
    assert.equal(fake.calls[0].signal.aborted, false, 'still inside the 15s budget');

    fake.calls[0].resolve(jsonResponse({ ok: true }));
    assert.deepEqual(await settle(pending), { status: 'ok', payload: { ok: true } });
    assert.equal(clock.pending, 0);
});

test('a request that exceeds the timeout fails visibly and is aborted with a timeout reason', async () => {
    const { fetcher, fake, clock } = await createFetcher();

    const pending = fetcher.load();
    clock.advance(14999);
    assert.equal(fake.calls[0].signal.aborted, false);
    clock.advance(1);

    assert.deepEqual(await settle(pending), { status: 'error', message: 'Metrics request timed out.' });
    assert.equal(fake.calls[0].signal.aborted, true);
    assert.equal(fake.calls[0].signal.reason.name, 'TimeoutError');

    // The timed-out request no longer blocks polling.
    const retry = fetcher.load();
    assert.equal(fake.calls.length, 2);
    fake.calls[1].resolve(jsonResponse({}));
    assert.equal((await retry).status, 'ok');
});

test('the timeout also covers a response whose body never arrives', async () => {
    const { fetcher, fake, clock } = await createFetcher();

    const pending = fetcher.load();
    fake.calls[0].resolve({ ok: true, status: 200, json: () => new Promise(() => {}) });
    await flush();
    clock.advance(15000);

    assert.deepEqual(await settle(pending), { status: 'error', message: 'Metrics request timed out.' });
});

test('a timeout settles the request even when the fetch ignores the abort signal', async () => {
    const { fetcher, fake, clock } = await createFetcher({ fake: { honorSignal: false } });

    const pending = fetcher.load();
    clock.advance(15000);

    assert.deepEqual(await settle(pending), { status: 'error', message: 'Metrics request timed out.' });
    fetcher.load();
    assert.equal(fake.calls.length, 2, 'a hung request must not wedge single-flight');
});

test('the timeout defaults to 15s, above the 5s poll interval', async () => {
    const { createMetricsFetcher, DEFAULT_METRICS_TIMEOUT_MS } = await metricsFetcherModule;
    assert.equal(DEFAULT_METRICS_TIMEOUT_MS, 15000);
    assert.ok(DEFAULT_METRICS_TIMEOUT_MS > POLL_INTERVAL_MS);

    const fake = createFakeFetch();
    const clock = createFakeTimers();
    const fetcher = createMetricsFetcher({ fetchImpl: fake.fetchImpl, timers: clock.timers });
    const pending = fetcher.load();
    clock.advance(14999);
    assert.equal(fake.calls[0].signal.aborted, false);
    clock.advance(1);
    assert.equal((await settle(pending)).status, 'error');
});

test('aborting for unmount cancels the request silently', async () => {
    const { fetcher, fake, clock } = await createFetcher();

    const pending = fetcher.load();
    fetcher.abort();

    assert.deepEqual(await settle(pending), { status: 'aborted' });
    assert.equal(fake.calls[0].signal.aborted, true);
    assert.notEqual(fake.calls[0].signal.reason.name, 'TimeoutError');
    assert.equal(clock.pending, 0);
});

test('an unmount abort stays silent whatever error the fetch rejects with', async () => {
    const { fetcher, fake } = await createFetcher({ fake: { honorSignal: false } });

    const pending = fetcher.load();
    fetcher.abort();
    fake.calls[0].reject(new DOMException('The operation was aborted.', 'AbortError'));

    assert.deepEqual(await settle(pending), { status: 'aborted' });
});

test('abort with nothing in flight does nothing, and the fetcher stays usable after it', async () => {
    const { fetcher, fake } = await createFetcher();

    fetcher.abort();
    const pending = fetcher.load();
    assert.equal(fake.calls.length, 1);
    fake.calls[0].resolve(jsonResponse({}));
    assert.equal((await settle(pending)).status, 'ok');
});

test('a request aborted at unmount does not block, or get cleared by, the next mount', async () => {
    const { fetcher, fake } = await createFetcher({ fake: { honorSignal: false } });

    // React strict mode: mount, cleanup (abort), mount again on the same fetcher.
    const unmounted = fetcher.load();
    fetcher.abort();
    const remounted = fetcher.load();
    assert.notEqual(remounted, unmounted);
    assert.equal(fake.calls.length, 2, 'the remount starts its own request');

    // The aborted request settling late must not release the live one.
    fake.calls[0].reject(new Error('late'));
    assert.deepEqual(await settle(unmounted), { status: 'aborted' });
    assert.equal(fetcher.load(), remounted, 'the remounted request is still the in-flight one');

    fake.calls[1].resolve(jsonResponse({ n: 1 }));
    assert.deepEqual(await settle(remounted), { status: 'ok', payload: { n: 1 } });
});

test('an explicit retry replaces a stuck request silently and starts a fresh one', async () => {
    const { fetcher, fake, clock } = await createFetcher();

    const stuck = fetcher.load();
    clock.advance(10000);
    const retried = fetcher.load({ restart: true });

    assert.notEqual(retried, stuck);
    assert.equal(fake.calls.length, 2, 'the retry makes its own request');
    assert.equal(fake.calls[0].signal.aborted, true, 'the replaced request is cancelled');
    assert.equal(fake.calls[0].signal.reason.name, 'AbortError');
    assert.deepEqual(await settle(stuck), { status: 'aborted' }, 'replacing a request is not an error');

    // The replacement has its own full timeout budget and is the one later ticks join.
    assert.equal(fetcher.load(), retried);
    clock.advance(10000);
    assert.equal(fake.calls[1].signal.aborted, false);
    fake.calls[1].resolve(jsonResponse({ n: 2 }));
    assert.deepEqual(await settle(retried), { status: 'ok', payload: { n: 2 } });
    assert.equal(clock.pending, 0);
});

test('a retry with nothing in flight simply loads', async () => {
    const { fetcher, fake } = await createFetcher();

    const retried = fetcher.load({ restart: true });
    assert.equal(fake.calls.length, 1);
    fake.calls[0].resolve(jsonResponse({}));
    assert.equal((await settle(retried)).status, 'ok');
});

test('an abort the fetcher did not cause is reported, not swallowed', async () => {
    const { fetcher, fake } = await createFetcher({ fake: { honorSignal: false } });

    const pending = fetcher.load();
    fake.calls[0].reject(new DOMException('The operation was aborted.', 'AbortError'));

    const result = await settle(pending);
    assert.equal(result.status, 'error');
    assert.match(result.message, /aborted/i);
});

test('401 and 403 map to denied', async () => {
    for (const status of [401, 403]) {
        const { fetcher, fake } = await createFetcher();
        const pending = fetcher.load();
        fake.calls[0].resolve(jsonResponse({}, status));
        assert.deepEqual(await settle(pending), { status: 'denied' }, `HTTP ${status}`);
    }
});

test('other failures map to an error message', async () => {
    {
        const { fetcher, fake } = await createFetcher();
        const pending = fetcher.load();
        fake.calls[0].resolve(jsonResponse({}, 503));
        assert.deepEqual(await settle(pending), { status: 'error', message: 'Server responded with 503.' });
    }
    {
        const { fetcher, fake } = await createFetcher();
        const pending = fetcher.load();
        fake.calls[0].reject(new TypeError('Failed to fetch'));
        assert.deepEqual(await settle(pending), { status: 'error', message: 'Failed to fetch' });
    }
    {
        const { fetcher, fake } = await createFetcher();
        const pending = fetcher.load();
        fake.calls[0].reject({});
        assert.deepEqual(await settle(pending), { status: 'error', message: 'Failed to load server metrics.' });
    }
    {
        const { fetcher, fake } = await createFetcher();
        const pending = fetcher.load();
        fake.calls[0].resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
        assert.deepEqual(await settle(pending), { status: 'error', message: 'Unexpected token <' });
    }
});

test('a fetch that throws synchronously is reported and does not wedge the fetcher', async () => {
    const { createMetricsFetcher } = await metricsFetcherModule;
    const fetcher = createMetricsFetcher({
        fetchImpl: () => { throw new Error('boom'); },
        timers: createFakeTimers().timers,
    });
    assert.deepEqual(await fetcher.load(), { status: 'error', message: 'boom' });
    assert.deepEqual(await fetcher.load(), { status: 'error', message: 'boom' });
});

test('the request is the same-origin JSON metrics call with the per-request signal', async () => {
    const { fetcher, fake } = await createFetcher();

    const pending = fetcher.load();
    const [call] = fake.calls;
    assert.equal(call.url, '/api/metrics');
    assert.deepEqual(call.init.headers, { accept: 'application/json' });
    assert.equal(call.init.credentials, 'same-origin');
    assert.ok(call.init.signal instanceof AbortSignal);

    call.resolve(jsonResponse({}));
    await settle(pending);
});

test('the default timers work when none are injected', async (t) => {
    const { createMetricsFetcher } = await metricsFetcherModule;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fake = createFakeFetch();
    const fetcher = createMetricsFetcher({ fetchImpl: fake.fetchImpl, timeoutMs: 1000 });

    const pending = fetcher.load();
    t.mock.timers.tick(1000);

    assert.deepEqual(await settle(pending), { status: 'error', message: 'Metrics request timed out.' });
});

test('applyMetricsResult keeps the last metrics and shows the error when a refresh times out', async () => {
    const { applyMetricsResult, INITIAL_METRICS_VIEW } = await metricsFetcherModule;
    const earlier = new Date('2026-10-24T10:00:00Z');
    const later = new Date('2026-10-24T10:00:20Z');

    const loaded = applyMetricsResult(INITIAL_METRICS_VIEW, { status: 'ok', payload: { rooms: { active: 3 } } }, earlier);
    assert.deepEqual(loaded, { metrics: { rooms: { active: 3 } }, error: '', denied: false, lastUpdated: earlier });

    const timedOut = applyMetricsResult(loaded, { status: 'error', message: 'Metrics request timed out.' }, later);
    assert.deepEqual(timedOut.metrics, { rooms: { active: 3 } }, 'the last metrics stay on screen');
    assert.equal(timedOut.error, 'Metrics request timed out.');
    assert.equal(timedOut.lastUpdated, earlier, 'the update time is the last success');

    const recovered = applyMetricsResult(timedOut, { status: 'ok', payload: { rooms: { active: 4 } } }, later);
    assert.equal(recovered.error, '');
    assert.equal(recovered.lastUpdated, later);
});

test('applyMetricsResult shows the Access restricted state on denied and ignores unmount aborts', async () => {
    const { applyMetricsResult, INITIAL_METRICS_VIEW } = await metricsFetcherModule;
    const now = new Date('2026-10-24T10:00:00Z');

    const denied = applyMetricsResult(INITIAL_METRICS_VIEW, { status: 'denied' }, now);
    assert.equal(denied.denied, true);
    assert.equal(denied.error, '');

    const afterError = applyMetricsResult(denied, { status: 'error', message: 'x' }, now);
    assert.equal(afterError.denied, true, 'an error does not lift the restricted card');

    const lifted = applyMetricsResult(denied, { status: 'ok', payload: {} }, now);
    assert.equal(lifted.denied, false);

    const unchanged = applyMetricsResult(lifted, { status: 'aborted' }, now);
    assert.equal(unchanged, lifted, 'an unmount abort changes nothing, not even identity');
});

test('StatusView polls through the single-flight fetcher and only aborts at unmount', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'StatusView.jsx'), 'utf8');

    assert.match(source, /createMetricsFetcher/);
    assert.doesNotMatch(source, /new AbortController/, 'the view must not run its own per-tick abort');
    assert.doesNotMatch(source, /fetch\('\/api\/metrics'/, 'the request belongs to the fetcher');
    assert.equal(source.match(/\.abort\(\)/g)?.length, 1, 'abort() appears once, in the unmount cleanup');
    assert.match(source, /return \(\) => \{[^}]*fetcher\.abort\(\)/);
    assert.match(source, /poll: \(\) => \{ void fetchMetrics\(\); \}/, 'poll ticks join the in-flight request');
    assert.match(source, /onClick=\{\(\) => \{ void fetchMetrics\(\{ restart: true \}\); \}\}>Retry</, 'only Retry restarts');
});
