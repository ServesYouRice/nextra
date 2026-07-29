import React from 'react';
import { formatBytes } from '../lib/formatBytes.mjs';

export default function HostDiagnostics({ metrics }) {
    if (!metrics) return null;
    const relay = metrics.relay || {};
    const eventLoop = metrics.eventLoopDelayMs || {};
    return (
        <details className="host-diagnostics">
            <summary>Troubleshooting diagnostics</summary>
            <dl>
                <div><dt>Fallback restarts</dt><dd>{metrics.fallbackRestartCount || 0}</dd></div>
                <div><dt>Dropped relay chunks</dt><dd>{relay.droppedOversized || 0}</dd></div>
                <div><dt>Dropped fallback input</dt><dd>{formatBytes(metrics.fallbackDroppedBytes, { maxUnit: 'MB' })}</dd></div>
                <div><dt>Event-loop p95</dt><dd>{Number(eventLoop.p95 || 0).toFixed(1)} ms</dd></div>
                <div><dt>Event-loop max</dt><dd>{Number(eventLoop.max || 0).toFixed(1)} ms</dd></div>
            </dl>
            {metrics.fallbackLastError && <p className="diagnostic-error">Last fallback error: {metrics.fallbackLastError}</p>}
        </details>
    );
}
