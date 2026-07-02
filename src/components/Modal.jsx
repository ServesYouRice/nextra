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

        const onKeyDown = (event) => {
            if (event.key === 'Escape') onClose();
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
