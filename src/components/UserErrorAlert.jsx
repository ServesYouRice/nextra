import React from 'react';
import { describeUserError } from '../lib/userError.mjs';

export default function UserErrorAlert({ error, id }) {
    if (!error) return null;
    const { action, detail } = describeUserError(error);
    return (
        <div className="alert alert-error" role="alert" id={id}>
            <span>{action}</span>
            {detail && detail !== action && (
                <details className="error-detail">
                    <summary>Technical details</summary>
                    <code>{detail}</code>
                </details>
            )}
        </div>
    );
}
