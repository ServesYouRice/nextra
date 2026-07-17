import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const NotificationContext = createContext(null);

export function NotificationProvider({ children }) {
    const [notifications, setNotifications] = useState([]);
    const nextId = useRef(1);
    const timers = useRef(new Map());

    const dismiss = useCallback((id) => {
        clearTimeout(timers.current.get(id));
        timers.current.delete(id);
        setNotifications((current) => current.filter((item) => item.id !== id));
    }, []);

    const notify = useCallback((message, options = {}) => {
        const id = nextId.current++;
        const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 4000));
        setNotifications((current) => [...current, {
            id,
            message: String(message),
            tone: options.tone || 'info',
        }]);
        if (timeoutMs > 0) timers.current.set(id, setTimeout(() => dismiss(id), timeoutMs));
        return id;
    }, [dismiss]);

    const value = useMemo(() => ({ notify, dismiss }), [notify, dismiss]);
    useEffect(() => () => {
        timers.current.forEach((timer) => clearTimeout(timer));
        timers.current.clear();
    }, []);
    return (
        <NotificationContext.Provider value={value}>
            {children}
            <div className="notification-stack" aria-live="polite" aria-label="Notifications">
                {notifications.map((item) => (
                    <div key={item.id} className={`notification notification-${item.tone}`} role={item.tone === 'error' ? 'alert' : 'status'}>
                        <span>{item.message}</span>
                        <button type="button" onClick={() => dismiss(item.id)} aria-label="Dismiss notification">&times;</button>
                    </div>
                ))}
            </div>
        </NotificationContext.Provider>
    );
}

export function useNotifications() {
    const context = useContext(NotificationContext);
    return context || { notify: () => null, dismiss: () => {} };
}
