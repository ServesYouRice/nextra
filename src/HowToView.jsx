import React from 'react';

export default function HowToView() {
    return (
        <div className="article-container">
            <h1>How to use Nextra</h1>

            <p>
                Nextra is a low-latency screen sharing app for local and remote viewers.
                Hosts run the server, viewers open a browser link, and streams are delivered over WebRTC.
            </p>

            <h2>For Hosts</h2>
            <div className="article-step">
                <strong>1. Run the app</strong>
                <p>
                    Start the server (`npm run dev` for development, or your packaged executable in production).
                    Keep the server terminal open while streaming.
                </p>
            </div>

            <div className="article-step">
                <strong>2. Open the host page</strong>
                <p>
                    Go to <code>https://localhost:3000</code>, then open <strong>Host</strong> and click
                    <strong> Start Sharing</strong>.
                </p>
                <div style={{ backgroundColor: 'var(--surface-3)', padding: '1rem', marginTop: '0.5rem', borderRadius: '4px', fontSize: '0.9rem', borderLeft: '3px solid var(--accent-1)' }}>
                    <strong>Important:</strong>
                    <ul style={{ margin: '0.5rem 0 0 1rem', padding: 0 }}>
                        <li style={{ marginBottom: '0.5rem' }}>
                            Allow firewall access for Node.js when prompted, or viewers may not connect.
                        </li>
                        <li>
                            The browser will warn about a self-signed certificate on first launch. This is expected for local HTTPS.
                        </li>
                    </ul>
                </div>
            </div>

            <div className="article-step">
                <strong>3. Share links</strong>
                <p>
                    Use the Room Code for direct joins. Nextra will try to create a public link automatically
                    if <code>cloudflared</code> is available. You can also set <code>SHARE_BASE_URL</code>
                    manually (for example your own tunnel/reverse-proxy domain).
                </p>
            </div>

            <h2>For Viewers</h2>
            <div className="article-step">
                <strong>1. Join</strong>
                <p>
                    Open the watch link or go to <strong>Watch</strong> and enter the Room Code.
                    No install is required for viewers.
                </p>
            </div>

            <div className="article-step">
                <strong>2. Optional remote media control</strong>
                <p>
                    If the host enables it, viewers can send Play/Pause media-key commands.
                    This does not grant full keyboard control.
                </p>
            </div>

            <h2>Security and privacy</h2>
            <p>
                Streams are sent peer-to-peer when possible. If direct connectivity fails, TURN relay is used.
                Media remains end-to-end encrypted and is not stored by Nextra.
            </p>

            <div style={{ marginTop: '3rem', textAlign: 'center' }}>
                <a href="#host" className="btn btn-primary">Start a stream now -&gt;</a>
            </div>
        </div>
    );
}
