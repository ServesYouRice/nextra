import React, { useEffect, useRef, useState } from 'react';
import UserErrorAlert from './UserErrorAlert';
import { HOST_SIGN_IN_HTTPS_REQUIRED, HOST_SIGN_IN_UNAVAILABLE, canSendHostPassword, signInAsHost } from '../lib/hostSignIn.mjs';

/**
 * Shown on the host page in place of the start controls when this browser has no operator rights: a host on
 * another computer than the one running Nextra.
 *
 * - `signInAvailable`: the server has a host password, so the panel asks for it. Otherwise it only says that
 *   hosting from another computer is off and how the person who runs the server turns it on.
 * - `onSignedIn`: called once the server has answered with the session cookie. It resolves to whether this browser
 *   now has operator rights; when it does, the host page replaces this panel with the host controls.
 * - `focusPassword`: move focus to the password field when the panel appears (after a sign-out). On a page load
 *   focus stays where the browser put it.
 *
 * The password lives in the input and nowhere else: it is read on submit, sent, and the field is emptied.
 */
export default function HostSignInPanel({ signInAvailable, onSignedIn, focusPassword = false }) {
    const passwordRef = useRef(null);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState('');
    const pageIsHttps = canSendHostPassword(window.location.protocol);

    useEffect(() => {
        if (focusPassword) passwordRef.current?.focus();
    }, [focusPassword]);

    if (!signInAvailable) {
        return (
            <section className="settings-panel host-sign-in" aria-labelledby="hostSignInTitle">
                <h2 className="panel-heading" id="hostSignInTitle">Hosting is off for this computer</h2>
                <p className="host-sign-in-text">
                    {HOST_SIGN_IN_UNAVAILABLE} Rooms can only be started on the computer that runs Nextra.
                </p>
                <p className="host-sign-in-text">
                    The person who runs it can turn this on by setting a host password
                    (<code>OPERATOR_TOKEN</code>) and restarting Nextra. <a href="#how-to">How to Use</a> has the details.
                </p>
            </section>
        );
    }

    const handleSubmit = async (event) => {
        event.preventDefault();
        if (busy) return;
        const field = passwordRef.current;
        const password = field?.value || '';
        if (!password) {
            setFailure('Enter the host password.');
            field?.focus();
            return;
        }
        // Cleared first so the same message, given twice, is announced twice.
        setFailure('');
        setBusy(true);
        const result = await signInAsHost(password);
        if (result.ok) {
            if (field) field.value = '';
            // With the rights in place the host page replaces this panel and moves focus to its controls.
            if (await onSignedIn?.()) return;
            setBusy(false);
            // The server accepted the password but the next request did not carry the session.
            setFailure('Signed in, but this browser did not keep the session. Allow cookies for this site and try again.');
            field?.focus();
            return;
        }
        setBusy(false);
        setFailure(result.message);
        // Focus stays on the field, with the rejected text selected so typing replaces it.
        field?.focus();
        field?.select();
    };

    return (
        <form className="settings-panel host-sign-in" onSubmit={handleSubmit} aria-labelledby="hostSignInTitle" noValidate>
            <h2 className="panel-heading" id="hostSignInTitle">Host sign-in</h2>
            <p className="host-sign-in-text">
                This is not the computer that runs Nextra, so starting a room from here needs the host password.
            </p>
            {!pageIsHttps && (
                <div className="alert alert-warning" role="note" id="hostSignInHttps">{HOST_SIGN_IN_HTTPS_REQUIRED}</div>
            )}
            {/* There is one host and no account name; this gives a password manager something to file the password under. */}
            <input type="text" name="username" autoComplete="username" value="Nextra host" readOnly hidden />
            <div className="setting-row setting-row-inline">
                <label htmlFor="hostPassword">Host password</label>
                <input
                    ref={passwordRef}
                    id="hostPassword"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    autoCapitalize="none"
                    spellCheck={false}
                    className="select-input"
                    disabled={!pageIsHttps}
                    aria-invalid={failure ? 'true' : undefined}
                    aria-describedby={[failure ? 'hostSignInError' : '', pageIsHttps ? '' : 'hostSignInHttps'].filter(Boolean).join(' ') || undefined}
                    onInput={() => { if (failure) setFailure(''); }}
                />
            </div>
            <UserErrorAlert error={failure} id="hostSignInError" />
            <div className="host-sign-in-actions">
                <button type="submit" className="btn btn-primary btn-large" disabled={busy || !pageIsHttps}>
                    {busy ? 'Signing in...' : 'Sign in'}
                </button>
            </div>
        </form>
    );
}
