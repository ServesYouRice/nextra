import React from 'react';
import CopyField from './CopyField';
import { inviteLinkRows } from '../lib/inviteLinks.mjs';

// Viewers may type the code with or without the hyphen (normalizeRoomCode
// drops it), so the card shows it split in two for reading aloud.
function formatRoomCode(code) {
    const text = String(code || '');
    return text.length > 3 ? `${text.slice(0, 3)}-${text.slice(3)}` : text;
}

/**
 * The invite card's content: the room code first, then one row per link that
 * exists (public, local, player), each with its own copy button. The best link
 * to share is marked (see inviteLinkRows): the public one when there is one,
 * otherwise the local one if another device can open it. The rows, the note
 * about a missing public link and any children (the manual OBS setup) share
 * the card's one scrolling list, so the card keeps the preview's height.
 */
export default function RoomSharePanel({
    roomCode,
    localWatchLink,
    publicWatchLink,
    showPublicLink,
    publicLinkHint,
    whepPlaybackUrl,
    children,
}) {
    const links = inviteLinkRows({ localWatchLink, publicWatchLink, showPublicLink, whepPlaybackUrl });
    const shownCode = formatRoomCode(roomCode);

    return (
        <>
            <h2 className="invite-card-title">Invite viewers</h2>
            <CopyField
                className="invite-code"
                label="Room code"
                value={shownCode}
                copyButtonLabel="Copy room code"
            />
            <div className="invite-links">
                {links.map(({ key, recommended, ...link }) => (
                    <CopyField
                        key={key}
                        className={`invite-link${recommended ? ' invite-link-recommended' : ''}`}
                        {...link}
                        tag={recommended ? <span className="invite-tag">Share this</span> : null}
                    />
                ))}
                {!showPublicLink && <p className="invite-note">{publicLinkHint}</p>}
                {children}
            </div>
        </>
    );
}
