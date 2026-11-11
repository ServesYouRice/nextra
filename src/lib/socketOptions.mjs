// Options for the browser's Socket.IO client. WebSocket is tried first; with
// tryAllTransports (socket.io-client 4.8+) a WebSocket that fails at the network
// level (blocked by a proxy or captive portal) falls through to HTTP long-polling.
export function createSocketOptions() {
    return {
        path: '/socket.io',
        autoConnect: false,
        transports: ['websocket', 'polling'],
        tryAllTransports: true,
    };
}
