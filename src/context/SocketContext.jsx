import React, { createContext, useContext, useMemo, useEffect } from 'react';
import { io } from 'socket.io-client';

export const SocketContext = createContext(null);

export function SocketProvider({ children }) {
    const socket = useMemo(() => {
        return io({
            path: '/socket.io',
            autoConnect: true,
            // WebSocket preferred, HTTP long-polling as a fallback for captive
            // portals / proxies that block or delay the WebSocket upgrade.
            transports: ['websocket', 'polling'],
        });
    }, []);

    // Disconnect socket when the provider unmounts (prevents zombie connections)
    useEffect(() => {
        return () => {
            socket.disconnect();
        };
    }, [socket]);

    return (
        <SocketContext.Provider value={socket}>
            {children}
        </SocketContext.Provider>
    );
}

export function useSocket() {
    const socket = useContext(SocketContext);
    if (!socket) throw new Error('useSocket must be used within a SocketProvider');
    return socket;
}
