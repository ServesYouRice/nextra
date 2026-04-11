export function shouldPreferRelayPlayback({ isTunnelOrigin = false, hasTurnServer = false, relayAllowed = true } = {}) {
    return relayAllowed && isTunnelOrigin && !hasTurnServer;
}

export function isAv1PlaybackUnsupported({ obsVideoCodec = null, mediaSourceSupported = false } = {}) {
    return String(obsVideoCodec || '').toLowerCase() === 'av1' && mediaSourceSupported !== true;
}
