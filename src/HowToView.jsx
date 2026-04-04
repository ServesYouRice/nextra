import React from 'react';

export default function HowToView() {
    const appOrigin = typeof window !== 'undefined'
        ? window.location.origin
        : 'https://localhost:3000';

    return (
        <div className="article-container">
            <h1>How to use Nextra</h1>

            <p>
                Nextra is a low-latency screen sharing app for local and remote viewers.
                Hosts can share their screen directly from the browser or stream through OBS Studio.
                Viewers just open a link in any modern browser.
            </p>

            <h2>What you need</h2>

            <div className="article-step">
                <strong>Everyone</strong>
                <ul>
                    <li><strong>Host:</strong> Windows machine running <code>Nextra.exe</code> or the project from source (<code>npm start</code>)</li>
                    <li><strong>Viewers:</strong> any modern browser (no install needed)</li>
                </ul>
            </div>

            <div className="article-step">
                <strong>Optional (depending on features used)</strong>
                <ul>
                    <li><strong>OBS Studio 28+</strong> — required for OBS streaming mode. Download from <a href="https://obsproject.com" target="_blank" rel="noopener noreferrer">obsproject.com</a>. Built-in WHIP output and WebSocket v5 are included.</li>
                    <li><strong>FFmpeg</strong> — required on the server for OBS relay playback. Download from <a href="https://ffmpeg.org/download.html" target="_blank" rel="noopener noreferrer">ffmpeg.org</a> and ensure it's on your PATH.</li>
                    <li><strong>cloudflared</strong> — required for public internet sharing via Cloudflare tunnel. Bundled in <code>Nextra.exe</code>, but must be downloaded separately for source/dev. Get it from <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" target="_blank" rel="noopener noreferrer">Cloudflare</a>.</li>
                </ul>
            </div>

            <h2>For Hosts</h2>

            <div className="article-step">
                <strong>1. Run the app</strong>
                <p>
                    Start <code>Nextra.exe</code> (from GitHub Releases), or run <code>npm start</code> for
                    development. Keep the server running while streaming.
                </p>
            </div>

            <div className="article-step">
                <strong>2. Open the host page</strong>
                <p>
                    Go to <code>{appOrigin}</code>, then open <strong>Host</strong>.
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
                <strong>3. Configure settings</strong>
                <p>Before clicking Start Sharing, adjust your settings:</p>
                <ul>
                    <li><strong>Resolution</strong> — 1080p, 1440p, or 4K. Auto-detected from your screen.</li>
                    <li><strong>Frame rate</strong> — 30 or 60 fps.</li>
                    <li><strong>Allow viewers to pause/play media</strong> — lets viewers send Play/Pause commands to the host machine.</li>
                </ul>
            </div>

            <div className="article-step">
                <strong>4. Start sharing</strong>
                <p>
                    Click <strong>Start Sharing</strong>. For browser capture, select the screen or window to share.
                    For OBS mode, the stream starts automatically from OBS.
                </p>
            </div>

            <div className="article-step">
                <strong>5. Share the link</strong>
                <p>
                    Copy the <strong>Public Link</strong> for internet viewers, or the <strong>Local Link</strong> / room code for same-network viewers.
                    Packaged <code>Nextra.exe</code> automatically creates a public tunnel link.
                    In dev, set <code>AUTO_PUBLIC_TUNNEL=true</code> or configure <code>SHARE_BASE_URL</code>.
                </p>
            </div>

            <h2>OBS Streaming</h2>

            <p>
                Use OBS Studio instead of browser capture for higher quality, custom scenes, overlays, and hardware encoding.
                Requires OBS 28+ (built-in WHIP and WebSocket support) and FFmpeg on the server.
            </p>

            <div className="article-step">
                <strong>1. Enable OBS mode</strong>
                <p>
                    On the host page, check <strong>Use OBS (WHIP ingest)</strong>. An OBS Configuration panel appears
                    on the right.
                </p>
            </div>

            <div className="article-step">
                <strong>2. Choose encoder settings</strong>
                <ul>
                    <li><strong>Apply recommended output settings</strong> — auto-configures OBS encoder, bitrate, keyframe interval, and low-latency tuning over WebSocket.</li>
                    <li><strong>Encoder</strong> — H.264 (NVENC, AMF, QSV, or x264). Nextra detects your GPU and recommends the best fit for the stable relay path.</li>
                    <li><strong>Tuning</strong> — Balanced aims for the quality plateau, Crisp adds a modest bump, and Max pushes harder when the host has headroom.</li>
                    <li><strong>Auto-start streaming in OBS</strong> — begins the stream immediately after configuration.</li>
                    <li><strong>WS password</strong> — enter your OBS WebSocket password, or leave empty if you disabled authentication in OBS.</li>
                </ul>
            </div>

            <div className="article-step">
                <strong>3. Click Start Sharing</strong>
                <p>
                    Nextra connects to OBS via WebSocket, applies settings, and starts the stream. You'll see a
                    live preview once OBS is connected. If auto-configuration fails, use the manual WHIP setup
                    shown on the host page.
                </p>
            </div>

            <div style={{ backgroundColor: 'var(--surface-3)', padding: '1rem', marginTop: '0.5rem', borderRadius: '4px', fontSize: '0.9rem', borderLeft: '3px solid var(--accent-1)' }}>
                <strong>OBS settings applied automatically:</strong>
                <ul style={{ margin: '0.5rem 0 0 1rem', padding: 0 }}>
                    <li>Output mode: Advanced</li>
                    <li>Keyframe interval: 2 seconds</li>
                    <li>Rate control: CBR</li>
                    <li>Tuning: Balanced, Crisp, or Max</li>
                    <li>H.264 profile: High, tune: zerolatency, 0 B-frames</li>
                    <li>NVENC: tuning-driven p5/p6 preset with full-resolution multipass</li>
                    <li>Audio: 256 kbps, 48 kHz</li>
                    <li>Color: BT.709, Full range</li>
                    <li>Resolution, FPS, and bitrate match your selected quality profile</li>
                </ul>
            </div>

            <h2>For Viewers</h2>

            <div className="article-step">
                <strong>1. Join</strong>
                <p>
                    Open the link the host shared, or go to <strong>Watch</strong> and enter the room code.
                    No install required.
                </p>
            </div>

            <div className="article-step">
                <strong>2. Playback</strong>
                <p>
                    The stream starts automatically. For OBS streams, playback uses Relay mode (fMP4 over MSE).
                    For browser capture, you get a direct WebRTC stream. You can switch between modes using the
                    <strong> Try WebRTC</strong> or <strong>Relay Mode</strong> buttons.
                </p>
            </div>

            <div className="article-step">
                <strong>3. Remote media control</strong>
                <p>
                    If the host enables it, you can send Play/Pause commands from the viewer page.
                    This sends a media key to the host machine, it does not grant keyboard control.
                </p>
            </div>

            <h2>Troubleshooting</h2>

            <div className="article-step">
                <strong>No public link?</strong>
                <p>
                    Wait a few seconds after startup. In dev, enable <code>AUTO_PUBLIC_TUNNEL=true</code>.
                    Ensure the <code>cloudflared</code> binary is in the project root or on PATH.
                </p>
            </div>

            <div className="article-step">
                <strong>OBS auto-config fails?</strong>
                <p>
                    Make sure OBS is running and WebSocket is enabled (Tools &gt; WebSocket Server Settings).
                    If using a password, enter it in the WS password field. You can retry from the host page
                    or use the manual WHIP setup.
                </p>
            </div>

            <div className="article-step">
                <strong>Audio missing?</strong>
                <p>
                    For browser capture, use Chrome or Edge (system audio requires Chromium).
                    For OBS, check that audio sources are active in the OBS Audio Mixer.
                </p>
            </div>

            <div className="article-step">
                <strong>Buffering or stalls?</strong>
                <p>
                    Lower the quality profile or frame rate. The player auto-recovers from stalls and
                    stays near the live edge. A stable network helps.
                </p>
            </div>

            <h2>Security and privacy</h2>
            <p>
                Streams are encrypted in transit (HTTPS + WebRTC DTLS). Media is not stored by Nextra.
                OBS WebSocket communication stays on localhost. Room access is code-based with no user accounts.
            </p>

            <div style={{ marginTop: '3rem', textAlign: 'center' }}>
                <a href="#host" className="btn btn-primary">Start a stream now -&gt;</a>
            </div>
        </div>
    );
}
