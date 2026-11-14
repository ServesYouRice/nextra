import React, { useState, useRef, useEffect, useCallback, useId } from 'react';
import { useNotifications } from '../context/NotificationContext';

function CopyIcon() {
    return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V6a2 2 0 0 1 2-2h9" />
        </svg>
    );
}

function CheckIcon() {
    return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
    );
}

// Splits a link for middle shortening: the head (cut with an ellipsis when the
// link does not fit) and the tail, from `marker` on, which always shows.
function splitAtMarker(value, marker) {
    const text = String(value ?? '');
    const index = marker ? text.indexOf(marker) : -1;
    if (index <= 0) return { head: text, tail: '' };
    return { head: text.slice(0, index), tail: text.slice(index) };
}

/**
 * Accessible click-to-copy value with a label and polite "Copied!" feedback.
 * Renders a real <button> so it is keyboard-focusable, unlike the plain
 * onClick spans it replaces.
 *
 * Optional props, all off by default:
 * - copyButtonLabel: the value becomes plain text and a square copy button
 *   with this name sits beside it. Its icon turns to a tick while "Copied!"
 *   is announced, so the status needs no room in the row and stays unseen.
 * - shortenFrom: the value stays on one line; when it does not fit, it is cut
 *   in the middle, keeping its start and everything from this marker on. The
 *   element's text stays the full value.
 * - tag: shown after the label; labelTitle and description explain the label
 *   (as its title and as a visually hidden description of the copy button).
 * - copyName: the name the toast uses instead of the label.
 */
export default function CopyField({
    label,
    value,
    display,
    strong = false,
    className = '',
    copyButtonLabel,
    shortenFrom,
    tag,
    labelTitle,
    description,
    copyName,
}) {
    const { notify } = useNotifications();
    const [copied, setCopied] = useState(false);
    const timeoutRef = useRef(null);
    const descriptionId = useId();

    useEffect(() => () => clearTimeout(timeoutRef.current), []);

    const toastName = copyName || label || 'Value';
    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(value);
            notify(`${toastName} copied.`, { tone: 'success', timeoutMs: 2500 });
        } catch {
            console.warn('[Nextra] Clipboard API unavailable');
            notify('Clipboard access is unavailable. Select and copy the value manually.', { tone: 'error' });
            return;
        }
        setCopied(true);
        clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    }, [value, toastName, notify]);

    const feedback = (
        <span className={`copy-field-feedback${copyButtonLabel ? ' visually-hidden' : ''}`} role="status" aria-live="polite">
            {copied ? 'Copied!' : ' '}
        </span>
    );

    if (!copyButtonLabel) {
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
                {feedback}
            </div>
        );
    }

    // The tail's width in characters reserves its room on the line, so only
    // the head is cut. The value is set in the mono font, where 1ch is one
    // character.
    const { head, tail } = shortenFrom ? splitAtMarker(value, shortenFrom) : { head: '', tail: '' };
    const valueContent = shortenFrom
        ? (
            <>
                <span className="copy-field-head">{head}</span>
                {tail}
            </>
        )
        : (display ?? value);

    return (
        <div className={`copy-field copy-field-split ${className}`.trim()}>
            <div className="copy-field-top">
                {label && <span className="copy-field-label" title={labelTitle}>{label}</span>}
                {tag}
            </div>
            <span
                className={`copy-field-value${strong ? ' copy-field-strong' : ''}${shortenFrom ? ' copy-field-shortened' : ''}`}
                style={shortenFrom ? { '--copy-field-tail': `${tail.length}ch` } : undefined}
                title={shortenFrom ? value : undefined}
            >
                {valueContent}
            </span>
            <button
                type="button"
                className={`copy-field-copy${copied ? ' is-copied' : ''}`}
                onClick={handleCopy}
                aria-label={copyButtonLabel}
                aria-describedby={description ? descriptionId : undefined}
                title={copyButtonLabel}
            >
                {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
            {feedback}
            {description && <span className="visually-hidden" id={descriptionId}>{description}</span>}
        </div>
    );
}
