import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNotifications } from '../context/NotificationContext';

/**
 * Accessible click-to-copy value with a label and polite "Copied!" feedback.
 * Renders a real <button> so it is keyboard-focusable, unlike the plain
 * onClick spans it replaces.
 */
export default function CopyField({ label, value, display, strong = false, className = '' }) {
    const { notify } = useNotifications();
    const [copied, setCopied] = useState(false);
    const timeoutRef = useRef(null);

    useEffect(() => () => clearTimeout(timeoutRef.current), []);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(value);
            notify(`${label || 'Value'} copied.`, { tone: 'success', timeoutMs: 2500 });
        } catch {
            console.warn('[Nextra] Clipboard API unavailable');
            notify('Clipboard access is unavailable. Select and copy the value manually.', { tone: 'error' });
            return;
        }
        setCopied(true);
        clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    }, [value, label, notify]);

    return (
        <div className={`copy-field ${className}`.trim()}>
            {label && <span className="copy-field-label">{label}</span>}
            <button
                type="button"
                className={`copy-field-value${strong ? ' copy-field-strong' : ''}`}
                onClick={handleCopy}
                title="Click to copy"
            >
                {display ?? value}
            </button>
            <span className="copy-field-feedback" role="status" aria-live="polite">
                {copied ? 'Copied!' : ' '}
            </span>
        </div>
    );
}
