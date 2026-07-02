import React, { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Accessible click-to-copy value with a label and polite "Copied!" feedback.
 * Renders a real <button> so it is keyboard-focusable, unlike the plain
 * onClick spans it replaces.
 */
export default function CopyField({ label, value, display, strong = false, className = '' }) {
    const [copied, setCopied] = useState(false);
    const timeoutRef = useRef(null);

    useEffect(() => () => clearTimeout(timeoutRef.current), []);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(value);
        } catch {
            console.warn('[Nextra] Clipboard API unavailable');
        }
        setCopied(true);
        clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    }, [value]);

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
