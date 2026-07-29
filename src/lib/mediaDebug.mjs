export function isMediaDebugEnabled(locationLike, storageLike) {
    try {
        const params = new URLSearchParams(locationLike?.search || '');
        return params.has('debugMedia') || storageLike?.getItem('nextra.debugMedia') === '1';
    } catch {
        return false;
    }
}
