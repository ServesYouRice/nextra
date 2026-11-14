// Which of the invite card's links a host can hand to someone else.

// A link whose host is this computer itself (localhost, 127.x.x.x, ::1). Nextra
// listens there unless BIND_HOST says otherwise, and such a link opens on no
// other device, whatever network it is on.
export function isLoopbackLink(link) {
    let hostname;
    try {
        hostname = new URL(String(link || '')).hostname.toLowerCase();
    } catch {
        return false;
    }
    const host = hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost'
        || host.endsWith('.localhost')
        || /^127(?:\.\d{1,3}){3}$/.test(host)
        || host === '::1';
}

/**
 * The link rows of the invite card, in order: public, local, player. The best
 * link to share is marked `recommended`: the public one when there is one,
 * otherwise the local one, unless the local link only opens on this computer.
 * Then no row is marked, because there is nothing to share yet.
 */
export function inviteLinkRows({ localWatchLink, publicWatchLink, showPublicLink, whepPlaybackUrl }) {
    const localOnlyHere = isLoopbackLink(localWatchLink);
    const rows = [
        showPublicLink && {
            key: 'public',
            label: 'Public link',
            value: publicWatchLink,
            copyButtonLabel: 'Copy public link',
            copyName: 'Public link',
            shortenFrom: '/#watch/',
        },
        localWatchLink && {
            key: 'local',
            label: localOnlyHere ? 'Local link · this computer only' : 'Local link · same network',
            value: localWatchLink,
            copyButtonLabel: 'Copy local link',
            copyName: 'Local link',
            shortenFrom: '/#watch/',
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
    const recommendedKey = rows.some((row) => row.key === 'public')
        ? 'public'
        : (localWatchLink && !localOnlyHere ? 'local' : '');
    return rows.map((row) => ({ ...row, recommended: row.key === recommendedKey }));
}

/**
 * The line at the bottom of the invite card while it has no public link: why,
 * and who the local link reaches. Empty when there is a public link.
 */
export function publicLinkNote({ showPublicLink, publicShareStatus, publicShareError, localWatchLink }) {
    if (showPublicLink) return '';
    if (publicShareStatus === 'starting') {
        return 'Public link is starting automatically. Wait a few seconds and it will appear here.';
    }
    const localOnlyHere = isLoopbackLink(localWatchLink);
    if (publicShareStatus === 'error') {
        return `Public link unavailable on this machine. ${publicShareError || 'Built-in tunnel startup failed.'}`
            + (localOnlyHere ? ' The local link only opens on this computer.' : '');
    }
    return localOnlyHere
        ? 'Nobody else can join yet: the local link only opens on this computer and there is no public link. '
            + 'See "No public link?" in How to Use.'
        : 'Works for people on your network. There is no public link on this machine.';
}
