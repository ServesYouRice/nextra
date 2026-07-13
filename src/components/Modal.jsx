import React, { useEffect, useRef } from 'react';

/**
 * Dialog wrapper: closes on Escape or backdrop click, moves focus into the
 * dialog on open and restores it on close.
 */
export default function Modal({ titleId, onClose, children, className = 'settings-modal' }) {
    const dialogRef = useRef(null);

    useEffect(() => {
        const previouslyFocused = document.activeElement;
        const dialog = dialogRef.current;
        const firstFocusable = dialog?.querySelector(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        (firstFocusable || dialog)?.focus?.();

        const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                onClose();
                return;
            }

            // Focus trap: keep Tab / Shift+Tab cycling within the dialog so focus
            // can't escape to the (aria-hidden) page behind an aria-modal dialog.
            if (event.key !== 'Tab') return;
            const focusable = Array.from(
                dialog?.querySelectorAll(focusableSelector) || [],
            ).filter((el) => !el.disabled && el.offsetParent !== null);
            if (focusable.length === 0) {
                event.preventDefault();
                dialog?.focus?.();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            if (event.shiftKey && (active === first || !dialog?.contains(active))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && active === last) {
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
