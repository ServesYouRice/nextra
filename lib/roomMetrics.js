const EMPTY_RELAY_METRICS = Object.freeze({
    chunksReceived: 0,
    bytesReceived: 0,
    chunksForwarded: 0,
    bytesForwarded: 0,
    droppedOversized: 0,
});

function buildHostRoomMetricsPayload({
    summary,
    room,
    relayMetrics,
    eventLoopDelayMs,
    normalizeFallback = false,
    includeFallbackGeneration = false,
    runtime,
}) {
    const metrics = {
        roomCode: summary.code,
        viewerCount: summary.viewerCount,
        relayViewerCount: summary.relayViewerCount,
        mediasoupConsumerCount: summary.mediasoupConsumerCount,
        hasProducer: summary.hasProducer,
        hasAudioProducer: summary.hasAudioProducer,
        whipConnected: room?.whipConnected || false,
        obsVideoCodec: room?.obsVideoCodec || null,
        relayAllowed: room?.relayAllowed !== false,
        hasRoomTurnServer: room?.hasRoomTurnServer || false,
        fallbackAvailable: normalizeFallback ? room?.fallbackAvailable || false : room?.fallbackAvailable,
        fallbackViewerCount: room?.fallbackViewerCount || 0,
        fallbackCodec: normalizeFallback ? room?.fallbackCodec || null : room?.fallbackCodec,
        fallbackRestartCount: room?.fallbackRestartCount || 0,
        fallbackLastError: room?.fallbackLastError || null,
        fallbackDroppedBytes: room?.fallbackWorker?.totalStdinDroppedBytes || 0,
        eventLoopDelayMs,
        whepViewerCount: room?.whepViewerCount || 0,
        totalViewerCount: summary.viewerCount + (room?.whepViewerCount || 0),
        relay: relayMetrics || EMPTY_RELAY_METRICS,
    };
    if (includeFallbackGeneration) metrics.fallbackGeneration = room?.fallbackGeneration;
    if (runtime) metrics.runtime = runtime;
    return metrics;
}

module.exports = { buildHostRoomMetricsPayload, EMPTY_RELAY_METRICS };
