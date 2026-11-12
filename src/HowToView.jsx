import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNotifications } from './context/NotificationContext';

const TABS = [
    { id: 'share', label: 'Share your screen' },
    { id: 'obs', label: 'Use OBS' },
    { id: 'watch', label: 'Watch a stream' },
    { id: 'fix', label: 'Fix a problem' },
    { id: 'privacy', label: 'Privacy' },
];

const MAC_COMMAND = 'chmod +x ./Nextra-macos-arm64\nxattr -dr com.apple.quarantine ./Nextra-macos-arm64\n./Nextra-macos-arm64';

// A command in its own box: it scrolls sideways inside the box, and the Copy
// button copies the text exactly as shown.
function CodeBox({ text }) {
    const { notify } = useNotifications();
    const [copied, setCopied] = useState(false);
    const timeoutRef = useRef(null);

    useEffect(() => () => clearTimeout(timeoutRef.current), []);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(text);
            notify('Command copied.', { tone: 'success', timeoutMs: 2500 });
        } catch {
            console.warn('[Nextra] Clipboard API unavailable');
            notify('Clipboard access is unavailable. Select and copy the command manually.', { tone: 'error' });
            return;
        }
        setCopied(true);
        clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    }, [text, notify]);

    return (
        <div className="howto-code">
            <button
                type="button"
                className="btn btn-secondary btn-small howto-copy"
                onClick={handleCopy}
                aria-label="Copy command"
            >
                {copied ? 'Copied' : 'Copy'}
            </button>
            <span className="visually-hidden" role="status" aria-live="polite">{copied ? 'Copied!' : ''}</span>
            <pre><code>{text}</code></pre>
        </div>
    );
}

export default function HowToView() {
    const appOrigin = typeof window !== 'undefined'
        ? window.location.origin
        : 'http://127.0.0.1:3000';
    const [activeTab, setActiveTab] = useState(TABS[0].id);
    const tabRefs = useRef({});

    const selectTab = useCallback((id) => {
        setActiveTab(id);
        tabRefs.current[id]?.focus();
    }, []);

    // Left and Right move one tab (wrapping); Home and End jump to the ends.
    const handleTabKeyDown = (event) => {
        const index = TABS.findIndex((tab) => tab.id === activeTab);
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = TABS.length - 1;
        else return;
        event.preventDefault();
        selectTab(TABS[next].id);
    };

    const panelProps = (id) => ({
        id: `howto-panel-${id}`,
        role: 'tabpanel',
        'aria-labelledby': `howto-tab-${id}`,
        className: 'howto-panel',
        hidden: activeTab !== id,
    });

    return (
        <div className="article-container howto">
            <h1>How to use Nextra</h1>

            <p>
                Share your screen from this browser or from OBS. Viewers open a link; they install nothing.
            </p>

            <div
                className="howto-tabs"
                role="tablist"
                aria-label="Guide sections"
                onKeyDown={handleTabKeyDown}
            >
                {TABS.map((tab) => (
                    <button
                        key={tab.id}
                        ref={(node) => { tabRefs.current[tab.id] = node; }}
                        type="button"
                        role="tab"
                        id={`howto-tab-${tab.id}`}
                        className="howto-tab"
                        aria-selected={activeTab === tab.id}
                        aria-controls={`howto-panel-${tab.id}`}
                        tabIndex={activeTab === tab.id ? 0 : -1}
                        onClick={() => setActiveTab(tab.id)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            <section {...panelProps('share')}>
                <h2>Share your screen</h2>
                <p>
                    Nextra is a low-latency screen sharing app for local and remote viewers.
                    You can host straight from the browser, in three steps.
                </p>

                <div className="howto-steps">
                    <div className="article-step">
                        <div className="howto-art" aria-hidden="true">
                            <span className="howto-art-button">Share my screen</span>
                        </div>
                        <strong>1. Start Nextra</strong>
                        <p>Open the app on the computer you want to share.</p>
                    </div>
                    <div className="article-step">
                        <div className="howto-art" aria-hidden="true">
                            <span className="howto-art-window" />
                            <span className="howto-art-window is-picked" />
                            <span className="howto-art-window" />
                        </div>
                        <strong>2. Press Start Sharing</strong>
                        <p>Pick a screen, a window or a tab.</p>
                    </div>
                    <div className="article-step">
                        <div className="howto-art" aria-hidden="true">
                            <span className="howto-art-chip">VW6-349</span>
                        </div>
                        <strong>3. Send the link</strong>
                        <p>Viewers open it. Nothing to install.</p>
                    </div>
                </div>

                <div className="article-step">
                    <strong>On a Mac, run this once</strong>
                    <p>
                        <strong>Mac (Apple Silicon):</strong> the download is blocked until you clear it once. Open Terminal in the download folder and run:
                    </p>
                    <CodeBox text={MAC_COMMAND} />
                    <p>
                        Keep that Terminal window open while you stream; press <strong>Ctrl+C</strong> in it to stop Nextra.
                    </p>
                </div>

                <h2>Step by step</h2>

                <div className="article-step">
                    <strong>1. Run the app</strong>
                    <p>
                        <strong>Windows:</strong> double-click <code>Nextra.exe</code>. If SmartScreen warns about an unrecognized app, choose <strong>More info &gt; Run anyway</strong>.
                    </p>
                    <p>
                        <strong>Mac (Apple Silicon):</strong> run the command in <strong>On a Mac, run this once</strong> above, then keep that Terminal window open.
                    </p>
                    <p>
                        From source, run <code>npm run dev</code>, or <code>npm run build && npm start</code> for a production start.
                        Only one copy of Nextra can run at a time.
                    </p>
                </div>

                <div className="article-step">
                    <strong>2. Open the host page</strong>
                    <p>
                        Go to <code>{appOrigin}</code>, then open <strong>Host</strong>.
                    </p>
                    <div className="callout callout-accent">
                        <strong>Important:</strong>
                        <ul>
                            <li>
                                Allow firewall access for Node.js when prompted, or viewers may not connect.
                            </li>
                            <li>Use the local host page from this machine when capturing a browser screen.</li>
                            <li>On a Mac, host from Chrome, Edge, or Brave (not Safari), and allow Screen Recording for that browser in <strong>System Settings &gt; Privacy &amp; Security</strong> when asked.</li>
                        </ul>
                    </div>
                </div>

                <div className="article-step">
                    <strong>3. Configure the room</strong>
                    <p>Before pressing Start Sharing, choose the settings that match the stream you want to run:</p>
                    <ul>
                        <li><strong>Resolution</strong> - 1080p, 1440p, or 4K. Nextra defaults from your screen size.</li>
                        <li><strong>Frame rate</strong> - 30 or 60 fps.</li>
                        <li><strong>Allow viewers to pause/play media</strong> (under <strong>More options</strong>) - lets viewers send a Play/Pause media key to the host machine.</li>
                        <li><strong>This browser / OBS</strong> - the tabs above the preview. <strong>This browser</strong> captures a screen, window or tab; <strong>OBS</strong> switches the host flow to OBS (see the <strong>Use OBS</strong> tab of this guide).</li>
                    </ul>
                </div>

                <div className="article-step">
                    <strong>4. Start sharing</strong>
                    <p>
                        Press <strong>Start Sharing</strong>. For browser capture, select the screen or window to share.
                        For OBS mode, Nextra creates the room first and then connects OBS to the matching WHIP session.
                    </p>
                </div>

                <div className="article-step">
                    <strong>5. Share the link</strong>
                    <p>
                        On the <strong>Invite viewers</strong> card, copy the <strong>Public link</strong> for internet viewers, or the <strong>Local link</strong> / room code for same-network viewers.
                        The packaged app creates a public tunnel link automatically. In dev, enable <code>AUTO_PUBLIC_TUNNEL=true</code> or configure <code>SHARE_BASE_URL</code>.
                        The public link is meant for one or two viewers, because each of them receives a full copy of the stream through your upload. For a bigger audience, run Nextra on a server with a public IP address.
                        Each link lasts only for that in-memory room: stopping the Host or restarting Nextra retires it and the next room gets a new link.
                    </p>
                </div>

                <div className="howto-folds">
                    <details className="howto-fold">
                        <summary>What you need</summary>
                        <div className="howto-fold-body">
                            <div className="article-step">
                                <strong>Everyone</strong>
                                <ul>
                                    <li><strong>Host:</strong> a Windows PC running <code>Nextra.exe</code>, an Apple Silicon Mac running <code>Nextra-macos-arm64</code>, or the project from source with <code>npm run dev</code> / <code>npm run build && npm start</code>. Host from Chrome, Edge, or Brave.</li>
                                    <li><strong>Viewers:</strong> desktop browsers, Android Chrome, or an iPhone/iPad on iOS 17.1 or later. No install required.</li>
                                </ul>
                            </div>
                            <div className="article-step">
                                <strong>Optional, depending on the workflow</strong>
                                <ul>
                                    <li><strong>OBS Studio 28+</strong> - required for OBS streaming mode. Download it from <a href="https://obsproject.com" target="_blank" rel="noopener noreferrer">obsproject.com</a>.</li>
                                    <li><strong>FFmpeg</strong> - required on the server for the H.264 relay path that public-link viewers and OBS rooms use. It is bundled in the packaged releases. For source/dev, download it from <a href="https://ffmpeg.org/download.html" target="_blank" rel="noopener noreferrer">ffmpeg.org</a> and make sure it is on your PATH.</li>
                                    <li><strong>TURN service</strong> - required for OBS AV1 rooms. AV1 mode disables relay fallback and expects viewers to stay on WebRTC.</li>
                                    <li><strong>cloudflared</strong> - required for public internet sharing via Cloudflare tunnel in source/dev. It is bundled in the packaged releases. Download it from <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" target="_blank" rel="noopener noreferrer">Cloudflare</a>.</li>
                                </ul>
                            </div>
                        </div>
                    </details>

                    <details className="howto-fold">
                        <summary>Tested browsers</summary>
                        <div className="howto-fold-body">
                            <p>
                                Nextra is tested end to end on the paths below. Other browsers are not tested:
                                they may work, and Nextra feature-detects WebRTC receive codecs and Media Source
                                Extensions rather than checking the browser name, so an unsupported browser gets
                                an explicit message instead of a silent failure.
                            </p>

                            <div className="table-wrap">
                                <table className="data-table">
                                    <thead>
                                        <tr>
                                            <th scope="col">Role and path</th>
                                            <th scope="col">Desktop Chrome / Edge</th>
                                            <th scope="col">Mobile Chrome</th>
                                            <th scope="col">Other browsers</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr>
                                            <th scope="row">Host, browser capture</th>
                                            <td>Tested</td>
                                            <td>Not supported (no screen capture)</td>
                                            <td>Not tested; system audio needs Chrome or Edge</td>
                                        </tr>
                                        <tr>
                                            <th scope="row">Host, OBS (WHIP)</th>
                                            <td>Tested</td>
                                            <td>Not supported</td>
                                            <td>Not tested</td>
                                        </tr>
                                        <tr>
                                            <th scope="row">Viewer, WebRTC</th>
                                            <td>Tested</td>
                                            <td>Tested</td>
                                            <td>Not tested</td>
                                        </tr>
                                        <tr>
                                            <th scope="row">Viewer, relay (H.264 MP4 / WebM)</th>
                                            <td>Tested</td>
                                            <td>Not tested</td>
                                            <td>iPhone/iPad (iOS 17.1+): checked by hand, needs a Chrome/Edge/Brave host</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </details>
                </div>
            </section>

            <section {...panelProps('obs')}>
                <h2>Use OBS</h2>

                <p>
                    Use OBS Studio instead of browser capture for higher quality scenes, overlays, and hardware encoding.
                    There are two OBS paths: stable H.264 with relay fallback, and AV1 with your own TURN server for WebRTC-only playback.
                </p>

                <div className="article-step">
                    <strong>1. Choose the OBS tab</strong>
                    <p>
                        On the host page, choose the <strong>OBS</strong> tab above the preview (the other tab is <strong>This browser</strong>).
                        The settings panel beside the preview then shows the OBS rows.
                    </p>
                </div>

                <div className="article-step">
                    <strong>2. Choose the OBS path</strong>
                    <ul>
                        <li><strong>Stable H.264</strong> - leave <strong>AV1 with my own TURN server</strong> (under <strong>More options</strong>) off. This is the compatibility path and keeps relay fallback available for viewers.</li>
                        <li><strong>AV1 WebRTC-only</strong> - turn on <strong>AV1 with my own TURN server</strong>. This requires an AV1-capable GPU, a TURN config, and OBS auto-configuration. Relay fallback is disabled for that room.</li>
                        <li><strong>Cloudflare TURN autofill</strong> - if the server is configured for it, the AV1 TURN setup window can fetch short-lived TURN credentials directly into the form with <strong>Autofill From Cloudflare</strong>. This button is only exposed to local or LAN hosts.</li>
                    </ul>
                </div>

                <div className="article-step">
                    <strong>3. Choose encoder settings</strong>
                    <ul>
                        <li><strong>Set OBS up for me</strong> (under <strong>More options</strong>) - auto-configures OBS encoder, bitrate, keyframe interval, and low-latency tuning over WebSocket. AV1 mode requires this.</li>
                        <li><strong>Picture preset</strong> - Balanced, Crisp, or Max.</li>
                        <li><strong>Start stream for me</strong> (under <strong>More options</strong>) - starts the WHIP stream immediately after configuration.</li>
                        <li><strong>OBS password</strong> - your OBS WebSocket password, or leave it empty if OBS auth is disabled.</li>
                        <li><strong>Save TURN credentials for this session</strong> - keeps AV1 TURN values in session storage so they survive reloads and disappear when the tab or window closes.</li>
                    </ul>
                </div>

                <div className="article-step">
                    <strong>4. Start the OBS room</strong>
                    <p>
                        Press <strong>Start Sharing</strong>. Nextra creates the room, connects to OBS over WebSocket, applies the room settings, and starts the WHIP stream.
                        The host page shows three steps while it works: OBS found on this computer, Nextra applies the stream settings, OBS starts streaming.
                        H.264 rooms can still use <strong>Set it up by hand</strong> on the host page if OBS auto-config fails. AV1 rooms require auto-config to succeed because the encoder has to be switched into AV1 first.
                    </p>
                </div>

                <div className="howto-folds">
                    <details className="howto-fold">
                        <summary>OBS settings applied automatically</summary>
                        <div className="howto-fold-body">
                            <ul>
                                <li>Output mode: Advanced</li>
                                <li>Video encoder: best available H.264 or AV1 hardware encoder for the selected room mode</li>
                                <li>Keyframe interval: 1 second</li>
                                <li>Rate control: CBR</li>
                                <li>Picture preset: Balanced, Crisp, or Max</li>
                                <li>NVENC preset: <code>p5</code> or <code>p6</code>, depending on the picture preset, with full-resolution multipass</li>
                                <li>Audio: 256 kbps, 48 kHz</li>
                                <li>Color: BT.709, Full range</li>
                                <li>Resolution, FPS, and bitrate match your selected quality profile</li>
                                <li>H.264 rooms also get High profile, zerolatency tune, and 0 B-frames for relay compatibility</li>
                            </ul>
                        </div>
                    </details>
                </div>
            </section>

            <section {...panelProps('watch')}>
                <h2>Watch a stream</h2>

                <div className="article-step">
                    <strong>1. Join</strong>
                    <p>
                        Open the link the host shared, or go to <strong>Watch</strong> and enter the room code, then press <strong>Join Room</strong>.
                        No install is required.
                    </p>
                </div>

                <div className="article-step">
                    <strong>2. Playback</strong>
                    <p>
                        The stream starts when you press <strong>Join Room</strong>; <strong>Watch Stream</strong> appears only to retry.
                        Nextra uses direct WebRTC when your device can reach the host,
                        and otherwise, for example through the public link, a relay over the page connection.
                        Viewers who cannot reach the host directly watch through a relay that adjusts itself to their connection.
                        On a slow connection the relay skips ahead to stay live instead of disconnecting you.
                        H.264 OBS rooms also let you switch into Relay Mode when it is offered.
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

                <div className="article-step">
                    <strong>4. External players (WHEP)</strong>
                    <p>
                        When WHEP egress is enabled on the server, each room also exposes a standards-based
                        WHEP playback URL at <code>{appOrigin}/whep/watch/&lt;ROOM-CODE&gt;</code>.
                        The host page shows a copyable link for it while streaming, as the <strong>Player link</strong> on the <strong>Invite viewers</strong> card. Any WHEP-compatible
                        player (GStreamer, web-based WHEP players, custom WebRTC clients) can watch the room
                        without opening the Nextra viewer page.
                    </p>
                </div>
            </section>

            <section {...panelProps('fix')}>
                <h2>Common questions</h2>

                <div className="howto-folds">
                    <details className="howto-fold howto-question">
                        <summary>No public link?</summary>
                        <div className="howto-fold-body">
                            <p>
                                Wait a few seconds after startup; the packaged app includes <code>cloudflared</code>. In dev, enable <code>AUTO_PUBLIC_TUNNEL=true</code>
                                and make sure the <code>cloudflared</code> binary is in the project root or on PATH.
                            </p>
                        </div>
                    </details>

                    <details className="howto-fold howto-question">
                        <summary>Mac says the app cannot be opened or is damaged?</summary>
                        <div className="howto-fold-body">
                            <p>
                                Run the <code>chmod</code> and <code>xattr</code> commands from <strong>On a Mac, run this once</strong> (the <strong>Share your screen</strong> tab) in the folder that holds the download.
                            </p>
                        </div>
                    </details>

                    <details className="howto-fold howto-question">
                        <summary>iPhone or iPad says it cannot play the relay stream?</summary>
                        <div className="howto-fold-body">
                            <p>
                                iPhones and iPads need iOS 17.1 or later, and the host must use Chrome, Edge, or Brave, which record the relay in a format iOS can play.
                            </p>
                        </div>
                    </details>

                    <details className="howto-fold howto-question">
                        <summary>Troubleshooting diagnostics says the relay was lowered?</summary>
                        <div className="howto-fold-body">
                            <p>
                                On the host page, <strong>Troubleshooting diagnostics</strong> shows a lowered relay bitrate when every relay viewer was falling behind, so your upload could not carry the full quality. Nothing to fix: quality returns step by step once the connection keeps up.
                            </p>
                        </div>
                    </details>

                    <details className="howto-fold howto-question">
                        <summary>AV1 room will not start or viewers cannot join?</summary>
                        <div className="howto-fold-body">
                            <p>
                                AV1 mode requires an AV1-capable GPU, OBS auto-configuration, and a publicly reachable mediasoup media address for internet viewers.
                                A generic TURN service cannot expose a server media listener bound only to loopback, and AV1 rooms do not have relay fallback.
                                Switch back to H.264 (turn off <strong>AV1 with my own TURN server</strong>) if you cannot provide TURN or if the viewers are on older browsers.
                            </p>
                        </div>
                    </details>

                    <details className="howto-fold howto-question">
                        <summary>OBS auto-config fails?</summary>
                        <div className="howto-fold-body">
                            <p>
                                Make sure OBS is running and WebSocket is enabled in <strong>Tools &gt; WebSocket Server Settings</strong>.
                                Enter the correct <strong>OBS password</strong> if you use one. H.264 rooms can fall back to <strong>Set it up by hand</strong> on the host page. AV1 rooms cannot.
                            </p>
                        </div>
                    </details>

                    <details className="howto-fold howto-question">
                        <summary>Viewer browser says AV1 is unsupported?</summary>
                        <div className="howto-fold-body">
                            <p>
                                That viewer needs either a browser/device with AV1 playback support, or the host needs to run the OBS room in H.264 mode instead.
                            </p>
                        </div>
                    </details>

                    <details className="howto-fold howto-question">
                        <summary>Audio missing?</summary>
                        <div className="howto-fold-body">
                            <p>
                                For browser capture, use Chrome or Edge if you need system audio.
                                For OBS, make sure the right audio sources are active in the OBS Audio Mixer.
                            </p>
                        </div>
                    </details>

                    <details className="howto-fold howto-question">
                        <summary>Buffering or stalls?</summary>
                        <div className="howto-fold-body">
                            <p>
                                Lower the resolution or frame rate, from the <strong>Quality</strong> menu on the host page while streaming. H.264 rooms can switch into Relay Mode when needed.
                                AV1 rooms depend on a stable TURN-backed WebRTC path.
                            </p>
                        </div>
                    </details>
                </div>
            </section>

            <section {...panelProps('privacy')}>
                <h2>Security and privacy</h2>
                <p>
                    How well your video is protected depends on the path it takes:
                </p>
                <ul>
                    <li><strong>WebRTC:</strong> WebRTC viewing, OBS WHIP ingest and WHEP playback are encrypted in transit with DTLS-SRTP.</li>
                    <li><strong>Relay:</strong> relay media travels over the page connection instead of WebRTC, so it is encrypted only as far as that connection is.</li>
                    <li><strong>Public link:</strong> public links use HTTPS, which ends at the tunnel provider (Cloudflare), so relay media is not end-to-end encrypted to the host.</li>
                    <li><strong>Local link:</strong> a local link uses plain HTTP unless you enable local HTTPS (<code>LOCAL_HTTPS=true</code>, with a self-signed certificate), so on that link everything except WebRTC media is unencrypted on your network.</li>
                </ul>
                <p>
                    Media is not stored by Nextra.
                    OBS WebSocket traffic stays on localhost. Room access is code-based with no user accounts.
                    If you enable Cloudflare TURN autofill, the long-lived API token stays on the server and the browser only receives short-lived TURN credentials.
                </p>
            </section>

            <div className="article-cta">
                <a href="#host" className="btn btn-primary"><span className="btn-brand-label">Share my screen</span></a>
            </div>
        </div>
    );
}
