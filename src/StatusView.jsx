import React, { useState, useEffect, useCallback, useReducer } from 'react';
import StatusPill from './components/StatusPill';
import { createVisibilityPoller } from './lib/visibilityPoller.mjs';
import {
    applyMetricsResult,
    createMetricsFetcher,
    INITIAL_METRICS_VIEW,
} from './lib/metricsFetcher.mjs';
import { formatBytes } from './lib/formatBytes.mjs';
import { formatRoomCode } from './lib/roomCode.mjs';
import {
    STATUS_ACCESS_RESTRICTED_COPY,
    countRoomViewers,
    describeRoomSource,
    describeRoomState,
    formatPlainDuration,
} from './lib/statusCopy.mjs';

const REFRESH_INTERVAL_MS = 5000;

function formatAge(timestamp) {
    const ms = Date.now() - (Number(timestamp) || 0);
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return '<1m';
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatRoomAge(timestamp) {
    const created = Number(timestamp);
    if (!Number.isFinite(created) || created <= 0) return '—';
    return formatPlainDuration((Date.now() - created) / 1000);
}

function describeRoomMode(room) {
    if (room.ingestMode === 'obs') {
        return room.obsAv1Mode || room.obsVideoCodec === 'av1' ? 'OBS · AV1' : 'OBS · H.264';
    }
    return 'Browser';
}

function reduceMetricsView(state, { result, now }) {
    return applyMetricsResult(state, result, now);
}

export default function StatusView() {
    const [{ metrics, error, denied, lastUpdated }, dispatch] = useReducer(reduceMetricsView, INITIAL_METRICS_VIEW);
    // One fetcher for the life of the view: a poll tick that finds a request still
    // in flight joins it rather than cancelling it, and a slow one times out visibly.
    const [fetcher] = useState(() => createMetricsFetcher());

    const fetchMetrics = useCallback(async (options) => {
        const result = await fetcher.load(options);
        dispatch({ result, now: new Date() });
    }, [fetcher]);

    useEffect(() => {
        const poller = createVisibilityPoller({
            poll: () => { void fetchMetrics(); },
            intervalMs: REFRESH_INTERVAL_MS,
        });
        return () => {
            poller.close();
            fetcher.abort();
        };
    }, [fetchMetrics, fetcher]);

    if (denied) {
        return (
            <div className="status-container">
                <div className="status-error-card">
                    <StatusPill tone="warn">Access restricted</StatusPill>
                    <p>{STATUS_ACCESS_RESTRICTED_COPY}</p>
                    <a href="#" className="btn btn-outline">Back to Home</a>
                </div>
            </div>
        );
    }

    if (!metrics && error) {
        return (
            <div className="status-container">
                <div className="status-error-card">
                    <StatusPill tone="err">Unavailable</StatusPill>
                    <p>{error}</p>
                    <button className="btn btn-primary" onClick={() => { void fetchMetrics({ restart: true }); }}>Retry</button>
                </div>
            </div>
        );
    }

    if (!metrics) {
        return (
            <div className="loading-state" role="status">
                <span className="spinner" aria-hidden="true" />
                <span>Loading server metrics…</span>
            </div>
        );
    }

    const rooms = metrics.rooms?.list || [];
    const sockets = metrics.sockets || {};
    const counters = sockets.counters || {};
    const socketRooms = sockets.rooms || [];
    const relayByCode = new Map(socketRooms.map((room) => [room.code, room.relay]));

    const headlineStats = [
        { label: 'Rooms open', value: metrics.rooms?.active ?? rooms.length },
        { label: 'People watching', value: (metrics.rooms?.totalViewers ?? 0) + (metrics.rooms?.totalWhepViewers ?? 0) },
        { label: 'On the backup connection', value: metrics.rooms?.totalRelayViewers ?? 0 },
    ];
    const detailStats = [
        { label: 'WebRTC viewers', value: metrics.rooms?.totalViewers ?? 0 },
        { label: 'Relay viewers', value: metrics.rooms?.totalRelayViewers ?? 0 },
        { label: 'WHEP viewers', value: metrics.rooms?.totalWhepViewers ?? 0 },
        { label: 'Media consumers', value: metrics.rooms?.totalMediasoupConsumers ?? 0 },
        { label: 'Active producers', value: counters.activeProducers ?? 0 },
        { label: 'Active consumers', value: counters.activeConsumers ?? 0 },
        { label: 'Connected viewers', value: counters.activeViewers ?? 0 },
        { label: 'Relay subscribers', value: counters.activeRelayViewers ?? 0 },
    ];

    return (
        <div className="status-container">
            <div className="status-head">
                <h1>Server Status</h1>
                <p className="status-health">
                    {error
                        ? <StatusPill tone="warn">Not updating</StatusPill>
                        : <StatusPill tone="ok">All good</StatusPill>}
                    <span> · up {formatPlainDuration(sockets.uptimeSec)}</span>
                    {lastUpdated && (
                        <span className="status-updated">Updated {lastUpdated.toLocaleTimeString()}</span>
                    )}
                </p>
            </div>

            {error && <div className="alert alert-warning" role="alert">Refresh failed: {error}</div>}

            <div className="stats-grid status-headline-stats">
                {headlineStats.map((stat) => (
                    <div className="stat-card" key={stat.label}>
                        <div className="stat-value">{stat.value}</div>
                        <div className="stat-label">{stat.label}</div>
                    </div>
                ))}
            </div>

            <h2 className="panel-heading">Active rooms</h2>
            {rooms.length === 0 ? (
                <div className="table-wrap">
                    <div className="status-empty">No active rooms right now.</div>
                </div>
            ) : (
                <ul className="status-rooms">
                    {rooms.map((room, index) => {
                        const state = describeRoomState(room);
                        return (
                            <li key={room.code || index}>
                                <span className="mono status-room-code">
                                    {room.code ? formatRoomCode(room.code) : '(hidden)'}
                                </span>
                                <StatusPill tone={state === 'Live' ? 'ok' : 'warn'}>{state}</StatusPill>
                                <span>{describeRoomSource(room)}</span>
                                <span>{countRoomViewers(room)} watching</span>
                                <span className="status-room-age">
                                    {formatRoomAge(room.createdAt)}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}

            <details className="status-more">
                <summary>More numbers for troubleshooting</summary>
                <div className="stats-grid">
                    {detailStats.map((stat) => (
                        <div className="stat-card" key={stat.label}>
                            <div className="stat-value">{stat.value}</div>
                            <div className="stat-label">{stat.label}</div>
                        </div>
                    ))}
                </div>
                {rooms.length > 0 && (
                    <div className="table-wrap">
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th scope="col">Room</th>
                                    <th scope="col">Mode</th>
                                    <th scope="col">Live</th>
                                    <th scope="col">Viewers</th>
                                    <th scope="col">Relay</th>
                                    <th scope="col">WHEP</th>
                                    <th scope="col">Consumers</th>
                                    <th scope="col">Relay out</th>
                                    <th scope="col">Age</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rooms.map((room, index) => {
                                    const relay = relayByCode.get(room.code);
                                    return (
                                        <tr key={room.code || index}>
                                            <td className="mono">{room.code || '(hidden)'}</td>
                                            <td>{describeRoomMode(room)}</td>
                                            <td>
                                                {room.hasProducer || room.whipConnected
                                                    ? <StatusPill tone="ok">live</StatusPill>
                                                    : <StatusPill tone="warn">paused</StatusPill>}
                                            </td>
                                            <td>{room.viewerCount ?? 0}</td>
                                            <td>{room.relayViewerCount ?? 0}</td>
                                            <td>{room.whepViewerCount ?? 0}</td>
                                            <td>{room.mediasoupConsumerCount ?? 0}</td>
                                            <td>{relay ? formatBytes(relay.bytesForwarded) : '—'}</td>
                                            <td>{formatAge(room.createdAt)}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </details>
        </div>
    );
}
