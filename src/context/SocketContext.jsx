import React, { createContext, useContext, useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { createSocketOptions } from '../lib/socketOptions.mjs';

export const SocketContext = createContext(null);

export function SocketProvider({ children }) {
    // Created with autoConnect:false so constructing the instance has no side
    // effect — React may invoke initializers more than once (StrictMode) and a
    // discarded auto-connecting socket would leak a live connection. The effect
    // below owns the connect/disconnect lifecycle.
    // WebSocket preferred; HTTP long-polling is the fallback when the WebSocket
    // fails at the network level (captive portals, proxies). See
    // src/lib/socketOptions.mjs for the tryAllTransports option that makes it.
    const [socket] = useState(() => io(createSocketOptions()));

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
