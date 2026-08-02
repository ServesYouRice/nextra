import React from 'react';
import { formatBytes } from '../lib/formatBytes.mjs';

export default function HostDiagnostics({ metrics, onDownload, downloading = false, downloadStatus = '' }) {
    const relay = metrics?.relay || {};
    const eventLoop = metrics?.eventLoopDelayMs || {};
    return (
        <details className="host-diagnostics">
            <summary>Troubleshooting diagnostics</summary>
            {metrics ? (
                <>
                    <dl>
                        <div><dt>Fallback restarts</dt><dd>{metrics.fallbackRestartCount || 0}</dd></div>
                        <div><dt>Dropped relay chunks</dt><dd>{relay.droppedOversized || 0}</dd></div>
                        <div><dt>Dropped fallback input</dt><dd>{formatBytes(metrics.fallbackDroppedBytes, { maxUnit: 'MB' })}</dd></div>
                        <div><dt>Event-loop p95</dt><dd>{Number(eventLoop.p95 || 0).toFixed(1)} ms</dd></div>
                        <div><dt>Event-loop max</dt><dd>{Number(eventLoop.max || 0).toFixed(1)} ms</dd></div>
                    </dl>
                    {metrics.fallbackLastError && <p className="diagnostic-error">Last fallback error: {metrics.fallbackLastError}</p>}
                </>
            ) : (
                <p>No active room metrics are available. Server readiness and configuration can still be exported.</p>
            )}
            <div className="diagnostic-actions">
                <button type="button" className="btn btn-secondary btn-small" onClick={onDownload} disabled={downloading}>
                    {downloading ? 'Preparing diagnostics...' : 'Download redacted diagnostics'}
                </button>
                <span role="status" aria-live="polite">{downloadStatus}</span>
            </div>
            <p className="copy-hint">The JSON export uses an allowlist and excludes room codes, links, credentials, and request headers.</p>
        </details>
    );
}
