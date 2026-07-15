// @ts-check

export function createLifecycleController() {
    /** @type {Map<string, () => void>} */
    const resources = new Map();
    let closed = false;
    return {
        /** @param {string} key @param {() => void} close */
        own(key, close) {
            if (closed) throw new Error('Lifecycle controller is closed');
            resources.get(key)?.();
            resources.set(key, close);
        },
        /** @param {string} key */
        release(key) {
            const close = resources.get(key);
            resources.delete(key);
            close?.();
        },
        close() {
            if (closed) return;
            closed = true;
            [...resources.values()].reverse().forEach((close) => {
                try { close(); } catch { /* best-effort teardown */ }
            });
            resources.clear();
        },
        get closed() { return closed; },
    };
}
