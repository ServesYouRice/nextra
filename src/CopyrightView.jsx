import React from 'react';

const LAST_UPDATED = 'April 5, 2026';

export default function CopyrightView() {
    return (
        <div className="article-container legal-container">
            <div className="legal-hero">
                <p className="legal-eyebrow">Last updated {LAST_UPDATED}</p>
                <h1>Copyright, DMCA, and Contact</h1>
                <p>
                    Nextra is self-hosted software, not a centralized content platform. Each stream host or public
                    deployment operator is responsible for the content they transmit and for responding to complaints.
                </p>
            </div>

            <h2>Host and operator responsibility</h2>
            <div className="article-step">
                <strong>Who is responsible</strong>
                <p>
                    If you start or run a Nextra stream, you are responsible for having the rights and permissions
                    needed to share that content. If you operate a public Nextra instance for others, you are also
                    responsible for publishing a monitored contact method for privacy, abuse, and copyright requests.
                </p>
            </div>

            <h2>How to send a complaint</h2>
            <div className="article-step">
                <strong>Send the notice to the operator of the specific stream or deployment</strong>
                <p>
                    A complaint should be directed to the host or instance operator who shared the room link with you.
                    A useful notice should include:
                </p>
                <ul>
                    <li>Your name and a working contact method</li>
                    <li>A description of the copyrighted work, personal data, or abusive content at issue</li>
                    <li>The room link, room code, timestamp, and any other details that identify the stream</li>
                    <li>A statement that you believe the use is unauthorized or otherwise unlawful</li>
                    <li>Your electronic signature or equivalent confirmation that the report is accurate</li>
                </ul>
            </div>

            <h2>What operators should do</h2>
            <div className="article-step">
                <strong>Recommended response process</strong>
                <p>
                    Operators should review complaints promptly, disable the stream or public access when appropriate,
                    and preserve only the limited logs needed to investigate the request. Public operators should keep
                    a monitored abuse or copyright contact email and publish it wherever they distribute room links.
                </p>
            </div>

            <h2>Project-level contact</h2>
            <div className="article-step">
                <strong>Upstream software issues are separate</strong>
                <p>
                    Bug reports, packaging issues, and upstream project questions should go to the maintainer of the
                    software build you installed. Those project-level contacts are separate from complaints about a
                    specific stream hosted by a specific operator.
                </p>
            </div>

            <div className="legal-callout">
                <strong>Practical rule:</strong> if someone shared the room with you, start with that host or the
                operator of that deployment. They are the party who can actually stop the stream, change access, or
                respond to a takedown request.
            </div>
        </div>
    );
}
