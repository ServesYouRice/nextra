import React from 'react';

const TONE_CLASSES = {
    ok: 'status-pill-ok',
    warn: 'status-pill-warn',
    err: 'status-pill-err',
    info: 'status-pill-info',
};

/** Small semantic status indicator: dot + short label. */
export default function StatusPill({ tone, pulse = false, children }) {
    const classes = ['status-pill'];
    if (TONE_CLASSES[tone]) classes.push(TONE_CLASSES[tone]);
    if (pulse) classes.push('status-pill-pulse');

    return (
        <span className={classes.join(' ')}>
            <span className="status-dot" aria-hidden="true" />
            {children}
        </span>
    );
}
