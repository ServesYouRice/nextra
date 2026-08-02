import React from 'react';
import CopyField from './CopyField';

export default function RoomSharePanel({
    localWatchLink,
    publicWatchLink,
    showPublicLink,
    publicLinkHint,
    whepPlaybackUrl,
}) {
    return (
        <div className="room-code-display">
            <div className="room-links-row">
                <CopyField label="Local Link" value={localWatchLink} />
                {showPublicLink && <CopyField label="Public Link" value={publicWatchLink} />}
                {whepPlaybackUrl && <CopyField label="External Player (WHEP)" value={whepPlaybackUrl} />}
            </div>
            {!showPublicLink && <span className="copy-hint">{publicLinkHint}</span>}
            {whepPlaybackUrl && <span className="copy-hint">The WHEP link plays in GStreamer and other WHEP-compatible players.</span>}
            <span className="copy-hint room-lifetime-copy">
                Room links work only while this room is active in the current Nextra server process. Stopping sharing or restarting Nextra retires them.
            </span>
        </div>
    );
}
