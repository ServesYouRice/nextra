import React from 'react';
import CopyField from './CopyField';
import ShareQrCode from './ShareQrCode';

export default function RoomSharePanel({
    formattedRoomCode,
    localWatchLink,
    publicWatchLink,
    showPublicLink,
    publicLinkHint,
    whepPlaybackUrl,
}) {
    const preferredLink = showPublicLink ? publicWatchLink : localWatchLink;
    return (
        <div className="room-code-display">
            <CopyField label="Room Code" value={formattedRoomCode} strong />
            <div className="room-links-row">
                <CopyField label="Local Link" value={localWatchLink} />
                {showPublicLink && <CopyField label="Public Link" value={publicWatchLink} />}
                {whepPlaybackUrl && <CopyField label="External Player (WHEP)" value={whepPlaybackUrl} />}
            </div>
            {!showPublicLink && <span className="copy-hint">{publicLinkHint}</span>}
            {whepPlaybackUrl && <span className="copy-hint">The WHEP link plays in GStreamer and other WHEP-compatible players.</span>}
            <ShareQrCode value={preferredLink} />
        </div>
    );
}
