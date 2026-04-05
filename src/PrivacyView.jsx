import React from 'react';

const LAST_UPDATED = 'April 5, 2026';

export default function PrivacyView() {
    return (
        <div className="article-container legal-container">
            <div className="legal-hero">
                <p className="legal-eyebrow">Last updated {LAST_UPDATED}</p>
                <h1>Privacy Policy</h1>
                <p>
                    Nextra is self-hosted screen sharing software. This page explains the data the app handles
                    while a room is active and the responsibilities of the person or organization running a
                    Nextra deployment.
                </p>
            </div>

            <h2>What Nextra handles</h2>
            <div className="article-step">
                <strong>Room and signaling data</strong>
                <p>
                    Nextra processes room codes, temporary transport identifiers, connection events, viewer counts,
                    playback mode state, and similar signaling data needed to create and maintain a live stream.
                </p>
            </div>
            <div className="article-step">
                <strong>Network and diagnostics</strong>
                <p>
                    The host machine and viewers necessarily exchange IP-based network traffic. The app may also log
                    connection failures, transport errors, codec information, and similar diagnostics to help the
                    operator run and debug the stream.
                </p>
            </div>

            <h2>Media handling</h2>
            <div className="article-step">
                <strong>Live forwarding by default</strong>
                <p>
                    Nextra is built for live delivery. Media is transmitted to viewers in real time and is not
                    intentionally stored by the app as a permanent recording by default.
                </p>
            </div>
            <div className="article-step">
                <strong>Temporary buffers</strong>
                <p>
                    Browsers, relay pipelines, and media servers may keep short-lived media fragments in memory so
                    playback can start and recover from stalls. Those temporary buffers are part of transport, not a
                    hosted media library.
                </p>
            </div>

            <h2>Third-party services</h2>
            <div className="article-step">
                <strong>External infrastructure</strong>
                <p>
                    If the operator uses TURN, Cloudflare Tunnel, Cloudflare Realtime, or other network services,
                    those providers may process connection metadata under their own terms and privacy policies.
                    Operators are responsible for choosing providers that fit their deployment.
                </p>
            </div>

            <h2>Retention</h2>
            <div className="article-step">
                <strong>Short-lived session state</strong>
                <p>
                    Active room state exists only while the room is running. Local logs, crash output, or server
                    diagnostics may remain on the operator's machine until they are deleted.
                </p>
            </div>

            <h2>Host responsibility</h2>
            <div className="article-step">
                <strong>The host controls the content</strong>
                <p>
                    Hosts are responsible for what they stream, for obtaining permission to share it, and for making
                    sure they have a valid way to handle privacy, abuse, or copyright complaints tied to their room.
                </p>
                <p>
                    Do not stream copyrighted material, personal data, private conversations, or other sensitive
                    content unless you have the legal right and permission to share it.
                </p>
            </div>

            <h2>Contact and complaints</h2>
            <div className="article-step">
                <strong>Who should receive a request</strong>
                <p>
                    Nextra does not run a centralized streaming service. Privacy requests, takedown notices, and
                    abuse complaints should be sent to the person or organization operating the specific Nextra
                    deployment or room you are trying to report.
                </p>
                <p>
                    For the complaint process operators should follow, see <a href="#copyright">Copyright / Contact</a>.
                </p>
            </div>
        </div>
    );
}
