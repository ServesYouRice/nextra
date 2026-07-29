// @ts-check

/**
 * Periodic poller that does no work while its document is hidden. A hidden tab
 * clears the interval instead of queueing throttled callbacks, and becoming
 * visible again polls immediately and starts exactly one replacement interval.
 *
 * @param {object} options
 * @param {() => void} options.poll
 * @param {number} options.intervalMs
 * @param {{ visibilityState?: string, addEventListener: Function, removeEventListener: Function } | null} [options.visibilityTarget]
 * @param {{ setInterval: Function, clearInterval: Function }} [options.timers]
 */
export function createVisibilityPoller({
    poll,
    intervalMs,
    visibilityTarget = typeof document === 'undefined' ? null : document,
    timers = { setInterval, clearInterval },
}) {
    let intervalId = null;
    let closed = false;

    const isHidden = () => visibilityTarget?.visibilityState === 'hidden';

    const stopInterval = () => {
        if (intervalId === null) return;
        timers.clearInterval(intervalId);
        intervalId = null;
    };

    const startInterval = () => {
        if (closed || intervalId !== null) return;
        intervalId = timers.setInterval(() => poll(), intervalMs);
    };

    const onVisibilityChange = () => {
        if (closed) return;
        if (isHidden()) {
            stopInterval();
            return;
        }
        // Resuming must refresh straight away; the displayed data is at least
        // one hidden interval stale.
        poll();
        startInterval();
    };

    visibilityTarget?.addEventListener('visibilitychange', onVisibilityChange);

    if (!isHidden()) {
        poll();
        startInterval();
    }

    return {
        close() {
            if (closed) return;
            closed = true;
            stopInterval();
            visibilityTarget?.removeEventListener('visibilitychange', onVisibilityChange);
        },
        /** Exposed so tests can assert timer ownership rather than call counts. */
        get polling() { return intervalId !== null; },
    };
}
