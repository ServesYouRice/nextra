import React from 'react';
import CopyField from './CopyField';

// Viewers may type the code with or without the hyphen (normalizeRoomCode
// drops it), so the card shows it split in two for reading aloud.
function formatRoomCode(code) {
    const text = String(code || '');
    return text.length > 3 ? `${text.slice(0, 3)}-${text.slice(3)}` : text;
}

/**
 * The invite card's content: the room code first, then one row per link that
 * exists (public, local, player). The best link to share, the public one when
 * there is one and otherwise the local one, is marked and has the page's one
 * main button.
 */
export default function RoomSharePanel({
    roomCode,
    localWatchLink,
    publicWatchLink,
    showPublicLink,
    publicLinkHint,
    whepPlaybackUrl,
}) {
    const links = [
        showPublicLink && {
            key: 'public',
            label: 'Public link',
            value: publicWatchLink,
            copyButtonLabel: 'Copy public link',
            copyName: 'Public link',
            shortenFrom: '#watch/',
        },
        localWatchLink && {
            key: 'local',
            label: 'Local link · same network',
            value: localWatchLink,
            copyButtonLabel: 'Copy local link',
            copyName: 'Local link',
            shortenFrom: '#watch/',
        },
        whepPlaybackUrl && {
            key: 'player',
            label: 'Player link · WHEP',
            value: whepPlaybackUrl,
            copyButtonLabel: 'Copy player link',
            copyName: 'Player link',
            shortenFrom: '/whep/watch/',
            labelTitle: 'Plays in GStreamer and other WHEP-compatible players',
            description: 'The player link plays in GStreamer and other WHEP-compatible players.',
        },
    ].filter(Boolean);
    const recommendedKey = links.find((link) => link.key === 'public' || link.key === 'local')?.key;
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
                {links.map(({ key, ...link }) => {
                    const recommended = key === recommendedKey;
                    return (
                        <CopyField
                            key={key}
                            className={`invite-link${recommended ? ' invite-link-recommended' : ''}`}
                            {...link}
                            tag={recommended ? <span className="invite-tag">Share this</span> : null}
                            mainButtonText={recommended ? 'Copy link' : undefined}
                        />
                    );
                })}
            </div>
            {!showPublicLink && <p className="invite-note">{publicLinkHint}</p>}
        </>
    );
}
