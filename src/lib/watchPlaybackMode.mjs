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
