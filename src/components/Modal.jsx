import React, { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function getFocusable(dialog) {
    return Array.from(dialog?.querySelectorAll(FOCUSABLE_SELECTOR) || [])
        .filter((el) => !el.disabled && el.offsetParent !== null);
}

/**
 * Dialog wrapper: closes on Escape or backdrop click, moves focus into the
 * dialog on open, traps Tab within it, and restores focus on close.
 */
export default function Modal({ titleId, onClose, children, className = 'settings-modal' }) {
    const dialogRef = useRef(null);

    useEffect(() => {
        const previouslyFocused = document.activeElement;
        const dialog = dialogRef.current;
        const [firstFocusable] = getFocusable(dialog);
        (firstFocusable || dialog)?.focus?.();

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                onClose();
                return;
            }
            if (event.key !== 'Tab' || !dialog) return;

            const focusable = getFocusable(dialog);
            if (focusable.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            if (event.shiftKey && (active === first || !dialog.contains(active))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
                event.preventDefault();
                first.focus();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            previouslyFocused?.focus?.();
        };
    }, [onClose]);

    return (
        <div className="modal-backdrop" role="presentation" onClick={onClose}>
            <div
                ref={dialogRef}
                className={className}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                onClick={(event) => event.stopPropagation()}
            >
                {children}
            </div>
        </div>
    );
}
