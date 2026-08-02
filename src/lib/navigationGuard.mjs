// Hash routing lives in the App router, but only HostView knows whether a
// stream is live, and the router unmounts HostView before it could veto its own
// teardown. HostView registers a guard here while sharing and the router asks
// before applying a route change. One router and one host view exist at a time,
// so a module-level slot is enough.

let activeGuard = null;

/**
 * Register a guard consulted before each hash route change.
 * @param {(targetRoute: string) => boolean} guard Return false to block the
 *   navigation; the guard is responsible for prompting and for retrying.
 * @returns {() => void} Releases this guard.
 */
export function setNavigationGuard(guard) {
    activeGuard = guard;
    return () => {
        if (activeGuard === guard) activeGuard = null;
    };
}

/** @returns {boolean} true when the route change may proceed. */
export function canLeaveRoute(targetRoute) {
    if (!activeGuard) return true;
    return activeGuard(targetRoute) !== false;
}
