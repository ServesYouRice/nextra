import React, { useState, useEffect, useCallback, useRef } from 'react';
import StatusPill from './components/StatusPill';

const REFRESH_INTERVAL_MS = 5000;

function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUptime(totalSeconds) {
    const seconds = Math.max(0, Number(totalSeconds) || 0);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m ${Math.floor(seconds % 60)}s`;
}

function formatAge(timestamp) {
    const ms = Date.now() - (Number(timestamp) || 0);
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return '<1m';
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function describeRoomMode(room) {
    if (room.ingestMode === 'obs') {
        return room.obsAv1Mode || room.obsVideoCodec === 'av1' ? 'OBS · AV1' : 'OBS · H.264';
    }
    return 'Browser';
}

export default function StatusView() {
    const [metrics, setMetrics] = useState(null);
    const [error, setError] = useState('');
    const [denied, setDenied] = useState(false);
    const [lastUpdated, setLastUpdated] = useState(null);
    const abortRef = useRef(null);

    const fetchMetrics = useCallback(async () => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const response = await fetch('/api/metrics', {
                headers: { accept: 'application/json' },
                credentials: 'same-origin',
                signal: controller.signal,
            });

            if (response.status === 401 || response.status === 403) {
                setDenied(true);
                setError('');
                return;
            }
            if (!response.ok) {
                throw new Error(`Server responded with ${response.status}.`);
            }

            const payload = await response.json();
            setMetrics(payload);
            setDenied(false);
            setError('');
            setLastUpdated(new Date());
        } catch (err) {
            if (err?.name === 'AbortError') return;
            setError(err.message || 'Failed to load server metrics.');
        }
    }, []);

    useEffect(() => {
        const initialFetch = setTimeout(fetchMetrics, 0);
        const interval = setInterval(fetchMetrics, REFRESH_INTERVAL_MS);
        return () => {
            clearTimeout(initialFetch);
            clearInterval(interval);
            abortRef.current?.abort();
        };
    }, [fetchMetrics]);

    if (denied) {
        return (
            <div className="status-container">
                <div className="status-error-card">
                    <StatusPill tone="warn">Access restricted</StatusPill>
                    <p>
                        Server metrics are only available to the machine running Nextra
                        (or with a metrics token). Open this page on the host machine to see live stats.
                    </p>
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
                    <button className="btn btn-primary" onClick={fetchMetrics}>Retry</button>
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

    const stats = [
        { label: 'Active rooms', value: metrics.rooms?.active ?? rooms.length },
        { label: 'WebRTC viewers', value: metrics.rooms?.totalViewers ?? 0 },
        { label: 'Relay viewers', value: metrics.rooms?.totalRelayViewers ?? 0 },
        { label: 'WHEP viewers', value: metrics.rooms?.totalWhepViewers ?? 0 },
        { label: 'Media consumers', value: metrics.rooms?.totalMediasoupConsumers ?? 0 },
        { label: 'Uptime', value: formatUptime(sockets.uptimeSec) },
    ];

    return (
        <div className="status-container">
            <div className="status-head">
                <div>
                    <h1>Server Status</h1>
                    <p className="subtitle">
                        Live rooms, viewers, and relay throughput on this Nextra instance.
                    </p>
                </div>
                <StatusPill tone="ok" pulse>
                    {lastUpdated
                        ? `Auto-refreshing · updated ${lastUpdated.toLocaleTimeString()}`
                        : 'Auto-refreshing'}
                </StatusPill>
            </div>

            {error && <div className="alert alert-warning" role="alert">Refresh failed: {error}</div>}

            <div className="stats-grid">
                {stats.map((stat) => (
                    <div className="stat-card" key={stat.label}>
                        <div className="stat-value">{stat.value}</div>
                        <div className="stat-label">{stat.label}</div>
                    </div>
                ))}
            </div>

            <h2 className="panel-heading">Active rooms</h2>
            <div className="table-wrap">
                {rooms.length === 0 ? (
                    <div className="status-empty">No active rooms right now.</div>
                ) : (
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
                                                : <StatusPill tone="warn">idle</StatusPill>}
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
                )}
            </div>

            <h2 className="panel-heading">Runtime counters</h2>
            <div className="stats-grid">
                <div className="stat-card">
                    <div className="stat-value">{counters.activeProducers ?? 0}</div>
                    <div className="stat-label">Active producers</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{counters.activeConsumers ?? 0}</div>
                    <div className="stat-label">Active consumers</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{counters.activeViewers ?? 0}</div>
                    <div className="stat-label">Connected viewers</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{counters.activeRelayViewers ?? 0}</div>
                    <div className="stat-label">Relay subscribers</div>
                </div>
            </div>
        </div>
    );
}
