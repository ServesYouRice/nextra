const test = require('node:test');
const assert = require('node:assert/strict');

const visibilityPollerModule = import('../src/lib/visibilityPoller.mjs');

function createFakeEnvironment(visibilityState = 'visible') {
    const listeners = new Map();
    const intervals = new Map();
    let nextId = 1;

    return {
        intervals,
        target: {
            visibilityState,
            addEventListener(type, handler) {
                listeners.set(type, [...(listeners.get(type) || []), handler]);
            },
            removeEventListener(type, handler) {
                listeners.set(type, (listeners.get(type) || []).filter((item) => item !== handler));
            },
        },
        timers: {
            setInterval(handler, ms) {
                const id = nextId++;
                intervals.set(id, { handler, ms });
                return id;
            },
            clearInterval(id) {
                intervals.delete(id);
            },
        },
        setVisibility(state) {
            this.target.visibilityState = state;
            (listeners.get('visibilitychange') || []).forEach((handler) => handler());
        },
        tick(times = 1) {
            for (let index = 0; index < times; index += 1) {
                [...intervals.values()].forEach(({ handler }) => handler());
            }
        },
        listenerCount(type) {
            return (listeners.get(type) || []).length;
        },
    };
}

test('a visible poller refreshes immediately and owns exactly one interval', async () => {
    const { createVisibilityPoller } = await visibilityPollerModule;
    const environment = createFakeEnvironment('visible');
    let polls = 0;

    const poller = createVisibilityPoller({
        poll: () => { polls += 1; },
        intervalMs: 5000,
        visibilityTarget: environment.target,
        timers: environment.timers,
    });

    assert.equal(polls, 1);
    assert.equal(environment.intervals.size, 1);
    environment.tick(2);
    assert.equal(polls, 3);

    poller.close();
});

test('hiding the tab stops all periodic work and resuming refreshes with one interval', async () => {
    const { createVisibilityPoller } = await visibilityPollerModule;
    const environment = createFakeEnvironment('visible');
    let polls = 0;

    const poller = createVisibilityPoller({
        poll: () => { polls += 1; },
        intervalMs: 5000,
        visibilityTarget: environment.target,
        timers: environment.timers,
    });
    assert.equal(polls, 1);

    environment.setVisibility('hidden');
    assert.equal(environment.intervals.size, 0);
    assert.equal(poller.polling, false);
    environment.tick(3);
    assert.equal(polls, 1, 'a hidden tab must do no periodic work');

    environment.setVisibility('visible');
    assert.equal(polls, 2, 'becoming visible refreshes immediately');
    assert.equal(environment.intervals.size, 1, 'resume must start exactly one interval');

    // A repeated visible event (some browsers fire focus-adjacent changes) must
    // not stack a second interval.
    environment.setVisibility('visible');
    assert.equal(environment.intervals.size, 1);

    poller.close();
});

test('a poller created while hidden waits for visibility before doing any work', async () => {
    const { createVisibilityPoller } = await visibilityPollerModule;
    const environment = createFakeEnvironment('hidden');
    let polls = 0;

    const poller = createVisibilityPoller({
        poll: () => { polls += 1; },
        intervalMs: 5000,
        visibilityTarget: environment.target,
        timers: environment.timers,
    });

    assert.equal(polls, 0);
    assert.equal(environment.intervals.size, 0);

    environment.setVisibility('visible');
    assert.equal(polls, 1);
    assert.equal(environment.intervals.size, 1);

    poller.close();
});

test('close releases the interval and the visibility listener exactly once', async () => {
    const { createVisibilityPoller } = await visibilityPollerModule;
    const environment = createFakeEnvironment('visible');
    let polls = 0;

    const poller = createVisibilityPoller({
        poll: () => { polls += 1; },
        intervalMs: 5000,
        visibilityTarget: environment.target,
        timers: environment.timers,
    });

    poller.close();
    poller.close();

    assert.equal(environment.intervals.size, 0);
    assert.equal(environment.listenerCount('visibilitychange'), 0);
    environment.setVisibility('visible');
    assert.equal(polls, 1, 'a closed poller must not run again');
});

test('the default timers work when no timer pair is injected', async () => {
    const { createVisibilityPoller } = await visibilityPollerModule;
    let polls = 0;

    // Browsers reject setInterval/clearInterval invoked with a plain object as
    // `this` ("Illegal invocation"), so the defaults must not be bare method
    // references on the options object.
    const poller = createVisibilityPoller({
        poll: () => { polls += 1; },
        intervalMs: 5000,
        visibilityTarget: null,
    });

    assert.equal(polls, 1);
    assert.equal(poller.polling, true);
    poller.close();
    assert.equal(poller.polling, false);
});
