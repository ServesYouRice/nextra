export const STATUS_ACCESS_RESTRICTED_COPY =
    'This page only loads metrics for the host. Open it on the host machine, or sign in on the Host page first; remote API clients must authenticate separately.';

export function formatPlainDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days} d ${hours} h`;
    if (hours > 0) return `${hours} h ${minutes} min`;
    if (minutes > 0) return `${minutes} min`;
    return `${seconds} s`;
}

export function describeRoomState(room) {
    return room.hasProducer || room.whipConnected ? 'Live' : 'Host paused';
}

export function describeRoomSource(room) {
    if (room.ingestMode === 'obs') {
        return room.obsAv1Mode || room.obsVideoCodec === 'av1' ? 'From OBS · AV1' : 'From OBS';
    }
    return 'From this browser';
}

export function countRoomViewers(room) {
    return (Number(room.viewerCount) || 0) + (Number(room.whepViewerCount) || 0);
}
