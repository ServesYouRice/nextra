export function getLocalStorageSafely(windowLike) {
    try {
        return windowLike?.localStorage ?? null;
    } catch {
        return null;
    }
}

export function isMediaDebugEnabled(locationLike, storageLike) {
    try {
        const params = new URLSearchParams(locationLike?.search || '');
        return params.has('debugMedia') || storageLike?.getItem('nextra.debugMedia') === '1';
    } catch {
        return false;
    }
}

// `?manualStart` keeps the two-step viewer flow: Join Room, then Watch Stream.
export function isManualStartRequested(locationLike) {
    try {
        return new URLSearchParams(locationLike?.search || '').has('manualStart');
    } catch {
        return false;
    }
}
