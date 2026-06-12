import React, { createContext, useContext, useState, useEffect } from 'react';
import { io } from 'socket.io-client';

export const SocketContext = createContext(null);

export function SocketProvider({ children }) {
    // Created with autoConnect:false so constructing the instance has no side
    // effect — React may invoke initializers more than once (StrictMode) and a
    // discarded auto-connecting socket would leak a live connection. The effect
    // below owns the connect/disconnect lifecycle.
    const [socket] = useState(() => io({
        path: '/socket.io',
        autoConnect: false,
        // WebSocket preferred, HTTP long-polling as a fallback for captive
        // portals / proxies that block or delay the WebSocket upgrade.
        transports: ['websocket', 'polling'],
    }));

    useEffect(() => {
        socket.connect();
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
