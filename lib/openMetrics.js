'use strict';

/** @param {string} name @param {number} value @param {string} help @param {'gauge'|'counter'} [type] */
function metric(name, value, help, type = 'gauge') {
    const safeValue = Number.isFinite(Number(value)) ? Number(value) : 0;
    return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${safeValue}\n`;
}

/**
 * @param {{
 * processMetrics: {uptimeSec:number, memory:{rss:number}, eventLoopDelayMs:{p95:number}},
 * rooms: {active:number,totalViewers:number,totalRelayViewers:number,totalWhepViewers:number,totalMediasoupConsumers:number},
 * sockets: {totalConnections?:number,activeSockets?:number,relayBytesForwarded?:number,counters?:Record<string,number>}
 * }} input
 */
function renderOpenMetrics({ processMetrics, rooms, sockets }) {
    const socketCounters = sockets.counters || sockets;
    let output = '';
    output += metric('nextra_process_uptime_seconds', processMetrics.uptimeSec, 'Process uptime in seconds.');
    output += metric('nextra_process_resident_memory_bytes', processMetrics.memory.rss, 'Resident process memory in bytes.');
    output += metric('nextra_event_loop_delay_p95_seconds', processMetrics.eventLoopDelayMs.p95 / 1000, '95th percentile event-loop delay in seconds.');
    output += metric('nextra_rooms_active', rooms.active, 'Active rooms.');
    output += metric('nextra_viewers_webrtc', rooms.totalViewers, 'Current WebRTC viewers.');
    output += metric('nextra_viewers_relay', rooms.totalRelayViewers, 'Current relay viewers.');
    output += metric('nextra_viewers_whep', rooms.totalWhepViewers, 'Current WHEP viewers.');
    output += metric('nextra_mediasoup_consumers', rooms.totalMediasoupConsumers, 'Current mediasoup consumers.');
    output += metric('nextra_socket_connections_total', socketCounters.totalConnections || 0, 'Socket connections accepted.', 'counter');
    output += metric('nextra_sockets_active', socketCounters.activeSockets || 0, 'Active Socket.IO connections.');
    output += metric('nextra_relay_bytes_forwarded_total', socketCounters.relayBytesForwarded || 0, 'Relay bytes forwarded.', 'counter');
    output += '# EOF\n';
    return output;
}

module.exports = { renderOpenMetrics };
