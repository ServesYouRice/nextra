export function buildViewerRoomUrl(locationLike, roomCode) {
    const code = String(roomCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z0-9]{6}$/.test(code)) return '';
    try {
        const base = new URL(locationLike?.href || String(locationLike?.origin || ''));
        return `${base.origin}${base.pathname || '/'}#watch/${code}`;
    } catch {
        return '';
    }
}
