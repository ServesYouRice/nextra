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
                You can host directly from the browser, or switch to OBS for higher quality scenes and hardware encoding.
                OBS rooms can run in stable H.264 mode with relay fallback, or AV1 WebRTC-only mode with BYOK TURN.
            </p>

            <h2>What you need</h2>

            <div className="article-step">
                <strong>Everyone</strong>
                <ul>
                    <li><strong>Host:</strong> Windows machine running <code>Nextra.exe</code> or the project from source with <code>npm start</code></li>
                    <li><strong>Viewers:</strong> any modern browser, no install required</li>
                </ul>
            </div>

            <div className="article-step">
                <strong>Optional, depending on the workflow</strong>
                <ul>
                    <li><strong>OBS Studio 28+</strong> - required for OBS streaming mode. Download it from <a href="https://obsproject.com" target="_blank" rel="noopener noreferrer">obsproject.com</a>.</li>
                    <li><strong>FFmpeg</strong> - required on the server for the H.264 OBS relay path. Download it from <a href="https://ffmpeg.org/download.html" target="_blank" rel="noopener noreferrer">ffmpeg.org</a> and make sure it is on your PATH.</li>
                    <li><strong>TURN service</strong> - required for OBS AV1 rooms. AV1 mode disables relay fallback and expects viewers to stay on WebRTC.</li>
                    <li><strong>cloudflared</strong> - required for public internet sharing via Cloudflare tunnel in source/dev. It is bundled in <code>Nextra.exe</code>. Download it from <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" target="_blank" rel="noopener noreferrer">Cloudflare</a>.</li>
                </ul>
            </div>

            <h2>For Hosts</h2>

            <div className="article-step">
                <strong>1. Run the app</strong>
                <p>
                    Start <code>Nextra.exe</code>, or run <code>npm start</code> in development.
                    Keep the app running while you are streaming.
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
                            The browser will warn about a self-signed certificate on first launch. That is expected for local HTTPS.
                        </li>
                    </ul>
                </div>
            </div>

            <div className="article-step">
                <strong>3. Configure the room</strong>
                <p>Before clicking Start Sharing, choose the settings that match the stream you want to run:</p>
                <ul>
                    <li><strong>Resolution</strong> - 1080p, 1440p, or 4K. Nextra defaults from your screen size.</li>
                    <li><strong>Frame rate</strong> - 30 or 60 fps.</li>
                    <li><strong>Allow viewers to pause/play media</strong> - lets viewers send a Play/Pause media key to the host machine.</li>
                    <li><strong>Use OBS (WHIP ingest)</strong> - switches the host flow from browser capture to OBS.</li>
                </ul>
            </div>

            <div className="article-step">
                <strong>4. Start sharing</strong>
                <p>
                    Click <strong>Start Sharing</strong>. For browser capture, select the screen or window to share.
                    For OBS mode, Nextra creates the room first and then connects OBS to the matching WHIP session.
                </p>
            </div>

            <div className="article-step">
                <strong>5. Share the link</strong>
                <p>
                    Copy the <strong>Public Link</strong> for internet viewers, or the <strong>Local Link</strong> / room code for same-network viewers.
                    Packaged <code>Nextra.exe</code> creates a public tunnel link automatically. In dev, enable <code>AUTO_PUBLIC_TUNNEL=true</code> or configure <code>SHARE_BASE_URL</code>.
                </p>
            </div>

            <h2>OBS Streaming</h2>

            <p>
                Use OBS Studio instead of browser capture for higher quality scenes, overlays, and hardware encoding.
                There are two OBS paths: stable H.264 with relay fallback, and AV1 with BYOK TURN for WebRTC-only playback.
            </p>

            <div className="article-step">
                <strong>1. Enable OBS mode</strong>
                <p>
                    On the host page, enable <strong>Use OBS (WHIP ingest)</strong>. The OBS Configuration panel appears on the right.
                </p>
            </div>

            <div className="article-step">
                <strong>2. Choose the OBS path</strong>
                <ul>
                    <li><strong>Stable H.264</strong> - leave <strong>Use BYOK TURN (AV1)</strong> off. This is the compatibility path and keeps relay fallback available for viewers.</li>
                    <li><strong>AV1 WebRTC-only</strong> - enable <strong>Use BYOK TURN (AV1)</strong>. This requires an AV1-capable GPU, a TURN config, and OBS auto-configuration. Relay fallback is disabled for that room.</li>
                    <li><strong>Cloudflare TURN autofill</strong> - if the server is configured for it, the AV1 modal can fetch short-lived TURN credentials directly into the form. This button is only exposed to local or LAN hosts.</li>
                </ul>
            </div>

            <div className="article-step">
                <strong>3. Choose encoder settings</strong>
                <ul>
                    <li><strong>Apply recommended output settings</strong> - auto-configures OBS encoder, bitrate, keyframe interval, and low-latency tuning over WebSocket. AV1 mode requires this.</li>
                    <li><strong>Tuning</strong> - Balanced, Crisp, or Max.</li>
                    <li><strong>Auto-start streaming in OBS</strong> - starts the WHIP stream immediately after configuration.</li>
                    <li><strong>WS password</strong> - your OBS WebSocket password, or leave it empty if OBS auth is disabled.</li>
                    <li><strong>Save TURN credentials for this session</strong> - keeps AV1 TURN values in session storage so they survive reloads and disappear when the tab or window closes.</li>
                </ul>
            </div>

            <div className="article-step">
                <strong>4. Start the OBS room</strong>
                <p>
                    Click <strong>Start Sharing</strong>. Nextra creates the room, connects to OBS over WebSocket, applies the room settings, and starts the WHIP stream.
                    H.264 rooms can still use the manual WHIP values shown on the host page if OBS auto-config fails. AV1 rooms require auto-config to succeed because the encoder has to be switched into AV1 first.
                </p>
            </div>

            <div style={{ backgroundColor: 'var(--surface-3)', padding: '1rem', marginTop: '0.5rem', borderRadius: '4px', fontSize: '0.9rem', borderLeft: '3px solid var(--accent-1)' }}>
                <strong>OBS settings applied automatically:</strong>
                <ul style={{ margin: '0.5rem 0 0 1rem', padding: 0 }}>
                    <li>Output mode: Advanced</li>
                    <li>Video encoder: best available H.264 or AV1 hardware encoder for the selected room mode</li>
                    <li>Keyframe interval: 2 seconds</li>
                    <li>Rate control: CBR</li>
                    <li>Tuning: Balanced, Crisp, or Max</li>
                    <li>NVENC preset: tuning-driven <code>p5</code> or <code>p6</code> with full-resolution multipass</li>
                    <li>Audio: 256 kbps, 48 kHz</li>
                    <li>Color: BT.709, Full range</li>
                    <li>Resolution, FPS, and bitrate match your selected quality profile</li>
                    <li>H.264 rooms also get High profile, zerolatency tune, and 0 B-frames for relay compatibility</li>
                </ul>
            </div>

            <h2>For Viewers</h2>

            <div className="article-step">
                <strong>1. Join</strong>
                <p>
                    Open the link the host shared, or go to <strong>Watch</strong> and enter the room code.
                    No install is required.
                </p>
            </div>

            <div className="article-step">
                <strong>2. Playback</strong>
                <p>
                    The stream starts when you click <strong>Watch Stream</strong>. Browser capture uses WebRTC directly.
                    H.264 OBS rooms can use WebRTC or Relay, and the viewer can switch into Relay Mode when it is offered.
                    AV1 OBS rooms stay on WebRTC only, which means viewers need TURN-reachable connectivity and a browser that can play AV1.
                </p>
            </div>

            <div className="article-step">
                <strong>3. Remote media control</strong>
                <p>
                    If the host enabled it, you can send Play/Pause commands from the viewer page.
                    This sends a media key to the host machine. It does not grant keyboard control.
                </p>
            </div>

            <h2>Troubleshooting</h2>

            <div className="article-step">
                <strong>No public link?</strong>
                <p>
                    Wait a few seconds after startup. In dev, enable <code>AUTO_PUBLIC_TUNNEL=true</code>.
                    Make sure the <code>cloudflared</code> binary is in the project root or on PATH.
                </p>
            </div>

            <div className="article-step">
                <strong>AV1 room will not start or viewers cannot join?</strong>
                <p>
                    AV1 mode requires an AV1-capable GPU, a valid TURN config, and OBS auto-configuration.
                    If you are using a public Cloudflare link, remember that AV1 rooms do not have relay fallback.
                    Switch back to H.264 if you cannot provide TURN or if the viewers are on older browsers.
                </p>
            </div>

            <div className="article-step">
                <strong>OBS auto-config fails?</strong>
                <p>
                    Make sure OBS is running and WebSocket is enabled in <strong>Tools &gt; WebSocket Server Settings</strong>.
                    Enter the correct password if you use one. H.264 rooms can fall back to the manual WHIP setup shown on the host page. AV1 rooms cannot.
                </p>
            </div>

            <div className="article-step">
                <strong>Viewer browser says AV1 is unsupported?</strong>
                <p>
                    That viewer needs either a browser/device with AV1 playback support, or the host needs to run the OBS room in H.264 mode instead.
                </p>
            </div>

            <div className="article-step">
                <strong>Audio missing?</strong>
                <p>
                    For browser capture, use Chrome or Edge if you need system audio.
                    For OBS, make sure the right audio sources are active in the OBS Audio Mixer.
                </p>
            </div>

            <div className="article-step">
                <strong>Buffering or stalls?</strong>
                <p>
                    Lower the quality profile or frame rate. H.264 rooms can switch into Relay Mode when needed.
                    AV1 rooms depend on a stable TURN-backed WebRTC path.
                </p>
            </div>

            <h2>Security and privacy</h2>
            <p>
                Streams are encrypted in transit with HTTPS and WebRTC DTLS. Media is not stored by Nextra.
                OBS WebSocket traffic stays on localhost. Room access is code-based with no user accounts.
                If you enable Cloudflare TURN autofill, the long-lived API token stays on the server and the browser only receives short-lived TURN credentials.
            </p>

            <div style={{ marginTop: '3rem', textAlign: 'center' }}>
                <a href="#host" className="btn btn-primary">Start a stream now -&gt;</a>
            </div>
        </div>
    );
}
