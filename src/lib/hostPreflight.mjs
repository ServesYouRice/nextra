function issue(code, message) {
    return { code, message };
}

export function evaluateHostPreflight({
    ingestMode,
    captureApiAvailable,
    secureContext,
    chromium,
    whipHttpStatus,
    whipHttpError,
    obsAv1Mode,
    obsApplySettings,
    turnConfigValid,
    turnConfigError,
    publicShareStatus,
    publicShareError,
    publicAv1Supported,
    webSocketAvailable,
}) {
    const blockers = [];
    const warnings = [];

    if (ingestMode === 'browser') {
        if (!captureApiAvailable) {
            blockers.push(issue(
                'capture-unavailable',
                secureContext
                    ? 'Screen capture is unavailable in this browser. Use desktop Chrome or Edge.'
                    : 'Screen capture requires a secure page. Open Nextra on localhost or HTTPS in desktop Chrome or Edge.',
            ));
        } else if (!chromium) {
            warnings.push(issue(
                'system-audio-unsupported',
                'This browser is not tested for system-audio capture. Sharing can continue without system audio; desktop Chrome or Edge is recommended.',
            ));
        }
    }

    if (ingestMode === 'obs') {
        if (whipHttpStatus !== 'ready') {
            blockers.push(issue(
                'whip-unavailable',
                whipHttpStatus === 'error'
                    ? `OBS WHIP is unavailable: ${whipHttpError || 'the WHIP listener failed to start'}. Fix the listener and retry.`
                    : 'OBS WHIP is still starting. Wait for it to become ready, then retry.',
            ));
        }

        if (!webSocketAvailable) {
            const message = 'This browser cannot connect to OBS WebSocket. Use a browser with WebSocket support.';
            if (obsAv1Mode) blockers.push(issue('obs-websocket-unavailable', message));
            else warnings.push(issue(
                'obs-websocket-unavailable',
                `${message} H.264 can still be configured manually after the room starts.`,
            ));
        }

        if (obsAv1Mode) {
            if (!obsApplySettings) {
                blockers.push(issue(
                    'av1-auto-config-required',
                    'AV1 requires OBS auto-configuration so Nextra can select and verify the encoder.',
                ));
            }
            if (!turnConfigValid) {
                blockers.push(issue(
                    'av1-turn-invalid',
                    turnConfigError || 'AV1 requires a valid TURN configuration.',
                ));
            }
            if ((publicShareStatus === 'active' || publicShareStatus === 'manual') && !publicAv1Supported) {
                blockers.push(issue(
                    'av1-public-media-unreachable',
                    'Public AV1 requires a publicly reachable media address. Configure PUBLIC_IP and RTC_LISTEN_IP, or use H.264 relay mode.',
                ));
            }
        }
    }

    if (publicShareStatus === 'starting') {
        warnings.push(issue(
            'public-link-starting',
            'The room can start locally now; the public link will appear when tunnel startup completes.',
        ));
    } else if (publicShareStatus === 'error') {
        warnings.push(issue(
            'public-link-unavailable',
            `Public sharing is unavailable${publicShareError ? `: ${publicShareError}` : ''}. The local/LAN room can still start.`,
        ));
    }

    return { blockers, warnings };
}
