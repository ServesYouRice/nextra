// @ts-check

/** @typedef {{ label: string, tone: 'ok'|'warn'|'err'|'info' }} ViewerStatus */

/** @type {Record<string, ViewerStatus>} */
const WEBRTC_QUALITY = {
    excellent: { label: 'Good connection', tone: 'ok' },
    good: { label: 'Good connection', tone: 'ok' },
    fair: { label: 'Fair connection', tone: 'warn' },
    poor: { label: 'Poor connection', tone: 'err' },
};

/**
 * The one status chip on the viewer's picture: how the picture is reaching the
 * viewer, in a few words. null while there is nothing to report (not watching
 * and no relay fallback starting).
 *
 * @param {{
 *   watching: boolean,
 *   playbackMode: string,
 *   fallbackMode: boolean,
 *   fallbackState?: string|null,
 *   quality?: string|null,
 *   pictureInterrupted?: boolean,
 * }} state
 * @returns {ViewerStatus|null}
 */
export function describeViewerStatus({ watching, playbackMode, fallbackMode, fallbackState, quality, pictureInterrupted }) {
    if (!watching && !fallbackMode) return null;
    if (pictureInterrupted) return { label: 'Reconnecting', tone: 'warn' };
    if (fallbackMode && fallbackState !== 'playing') return { label: 'Connecting', tone: 'info' };
    if (fallbackMode || playbackMode === 'relay') return { label: 'Backup connection', tone: 'info' };
    return (quality && WEBRTC_QUALITY[quality]) || { label: 'Connected', tone: 'ok' };
}
