export function shouldPreferRelayPlayback({ isTunnelOrigin = false, hasTurnServer = false, relayAllowed = true } = {}) {
    return relayAllowed && isTunnelOrigin && !hasTurnServer;
}

export function hasWebRtcReceiveCodec(rtpCapabilities, mimeType) {
    const expectedMimeType = String(mimeType || '').toLowerCase();
    if (!expectedMimeType || !Array.isArray(rtpCapabilities?.codecs)) return false;
    return rtpCapabilities.codecs.some((codec) => (
        String(codec?.mimeType || '').toLowerCase() === expectedMimeType
    ));
}

export function isAv1PlaybackUnsupported({
    obsVideoCodec = null,
    receiveCapabilitiesLoaded = false,
    av1ReceiveSupported = false,
} = {}) {
    return String(obsVideoCodec || '').toLowerCase() === 'av1'
        && receiveCapabilitiesLoaded === true
        && av1ReceiveSupported !== true;
}

export const RELAY_PLAYBACK_UNSUPPORTED_MESSAGE = 'This browser cannot play the relay stream that public links use. '
    + 'iPhone and iPad need iOS 17.1 or later and a host on a current Chrome or Edge; otherwise watch from Chrome on Android or a desktop browser.';

// iPhone browsers (all WebKit) expose ManagedMediaSource but no MediaSource.
export function getMediaSourceClass(scope = globalThis) {
    return scope?.MediaSource || scope?.ManagedMediaSource || null;
}

export function canPlayRelayFormat(mimeType, scope = globalThis) {
    const mediaSource = getMediaSourceClass(scope);
    return typeof mediaSource?.isTypeSupported === 'function' && mediaSource.isTypeSupported(mimeType);
}

// ManagedMediaSource only opens once remote playback (AirPlay) is disabled or an
// alternate source is provided, so set it before attaching the object URL.
export function createRelayMediaSource(videoElement, scope = globalThis) {
    const MediaSourceClass = getMediaSourceClass(scope);
    if (MediaSourceClass && MediaSourceClass === scope.ManagedMediaSource) {
        videoElement.disableRemotePlayback = true;
    }
    return new MediaSourceClass();
}

export function isRelayPlaybackUnsupported(error) {
    const message = typeof error === 'string' ? error : error?.message;
    return message === RELAY_PLAYBACK_UNSUPPORTED_MESSAGE;
}
