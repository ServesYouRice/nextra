// @ts-check

/** How long one metrics request may take; longer than the status page's 5s poll interval. */
export const DEFAULT_METRICS_TIMEOUT_MS = 15000;
export const METRICS_TIMEOUT_MESSAGE = 'Metrics request timed out.';
const METRICS_FAILED_MESSAGE = 'Failed to load server metrics.';

/**
 * @typedef {{ status: 'ok', payload: any }
 *   | { status: 'denied' }
 *   | { status: 'error', message: string }
 *   | { status: 'aborted' }} MetricsResult
 *   `aborted` means the request was cancelled on purpose (the view unmounted, or a Retry replaced
 *   it); it is never an error.
 *
 * @typedef {{ metrics: any, error: string, denied: boolean, lastUpdated: Date | null }} MetricsView
 */

/** @type {MetricsView} */
export const INITIAL_METRICS_VIEW = Object.freeze({
    metrics: null,
    error: '',
    denied: false,
    lastUpdated: null,
});

// Wrapped rather than referenced directly: browsers throw "Illegal invocation"
// when the global timer functions are called as methods of a plain object.
const defaultTimers = {
    setTimeout: (/** @type {() => void} */ handler, /** @type {number} */ ms) => setTimeout(handler, ms),
    clearTimeout: (/** @type {any} */ id) => clearTimeout(id),
};

/**
 * Single-flight metrics loader. While a request is outstanding, `load()` hands
 * back that same promise instead of starting another or cancelling it, so a
 * slow response is not aborted by the next poll tick. Each request has its own
 * AbortController and a timeout; a timeout is reported as an error, whereas
 * `abort()` (view unmounted) settles the request as `aborted` without one.
 * `load({ restart: true })`, for an explicit user retry, replaces the outstanding
 * request the same way. `load()` never rejects.
 *
 * @param {object} [options]
 * @param {(input: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
 * @param {string} [options.url]
 * @param {number} [options.timeoutMs]
 * @param {{ setTimeout: (handler: () => void, ms: number) => any, clearTimeout: (id: any) => void }} [options.timers]
 */
export function createMetricsFetcher({
    fetchImpl = (input, init) => fetch(input, init),
    url = '/api/metrics',
    timeoutMs = DEFAULT_METRICS_TIMEOUT_MS,
    timers = defaultTimers,
} = {}) {
    const budgetMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_METRICS_TIMEOUT_MS;
    /** @type {{ promise: Promise<MetricsResult>, cancel: (cause: 'unmount' | 'superseded') => void } | null} */
    let current = null;

    function start() {
        const controller = new AbortController();
        /** @type {'timeout' | 'unmount' | 'superseded' | null} */
        let cause = null;
        /** @param {'timeout' | 'unmount' | 'superseded'} nextCause @param {string} message @param {string} name */
        const abortWith = (nextCause, message, name) => {
            if (cause !== null) return;
            cause = nextCause;
            const reason = new Error(message);
            reason.name = name;
            controller.abort(reason);
        };

        // Settles the request on abort even if fetchImpl ignores the signal, so a
        // hung request can never hold the single flight open.
        const aborted = new Promise((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        });
        aborted.catch(() => {});

        const timer = timers.setTimeout(() => abortWith('timeout', METRICS_TIMEOUT_MESSAGE, 'TimeoutError'), budgetMs);

        /** @returns {Promise<MetricsResult>} */
        const run = async () => {
            try {
                const response = await Promise.race([
                    fetchImpl(url, {
                        headers: { accept: 'application/json' },
                        credentials: 'same-origin',
                        signal: controller.signal,
                    }),
                    aborted,
                ]);

                if (response.status === 401 || response.status === 403) return { status: 'denied' };
                if (!response.ok) return { status: 'error', message: `Server responded with ${response.status}.` };

                const payload = await Promise.race([response.json(), aborted]);
                return { status: 'ok', payload };
            } catch (err) {
                // Only an abort we raised on purpose (unmount, retry) is silent; any
                // other failure, a timeout included, must reach the screen.
                if (cause === 'unmount' || cause === 'superseded') return { status: 'aborted' };
                if (cause === 'timeout') return { status: 'error', message: METRICS_TIMEOUT_MESSAGE };
                return { status: 'error', message: /** @type {any} */ (err)?.message || METRICS_FAILED_MESSAGE };
            }
        };

        /** @type {{ promise: Promise<MetricsResult>, cancel: (cause: 'unmount' | 'superseded') => void }} */
        const entry = {
            promise: run().finally(() => {
                timers.clearTimeout(timer);
                // An aborted request settles late; it must not release a newer one.
                if (current === entry) current = null;
            }),
            cancel: (why) => abortWith(
                why,
                why === 'unmount' ? 'Metrics view closed.' : 'Metrics request replaced by a retry.',
                'AbortError',
            ),
        };
        return entry;
    }

    return {
        /**
         * @param {{ restart?: boolean }} [loadOptions] `restart` replaces an outstanding request
         *   instead of joining it; only an explicit user retry should set it, never a poll tick.
         * @returns {Promise<MetricsResult>}
         */
        load({ restart = false } = {}) {
            if (current && restart) {
                const replaced = current;
                current = null;
                replaced.cancel('superseded');
            }
            if (!current) current = start();
            return current.promise;
        },
        /**
         * Cancels the outstanding request for an unmount. The fetcher stays usable,
         * so a strict-mode remount can load again straight away.
         */
        abort() {
            const entry = current;
            current = null;
            entry?.cancel('unmount');
        },
    };
}

/**
 * Folds one load result into what the status page shows. A failed refresh keeps
 * the last metrics (the page then shows its "Refresh failed" alert over them);
 * only a success clears the error and the Access restricted state.
 *
 * @param {MetricsView} state
 * @param {MetricsResult} result
 * @param {Date} [now]
 * @returns {MetricsView}
 */
export function applyMetricsResult(state, result, now = new Date()) {
    switch (result.status) {
        case 'ok':
            return { metrics: result.payload, error: '', denied: false, lastUpdated: now };
        case 'denied':
            return { ...state, denied: true, error: '' };
        case 'error':
            return { ...state, error: result.message };
        default:
            return state;
    }
}
