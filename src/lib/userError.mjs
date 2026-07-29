const FAILURE_ADVICE = [
    {
        matches: (message, error) => error?.name === 'AbortError' || /\babort(?:ed)?\b/i.test(message),
        action: 'The request was cancelled. Try the action again.',
    },
    {
        matches: (message) => /screen sharing was cancelled|failed to start sharing|getdisplaymedia|notallowederror/i.test(message),
        action: 'Choose a screen or window, allow sharing, and try again.',
    },
    {
        matches: (message) => /timed out|timeout/i.test(message),
        action: 'The connection took too long. Check your network, then try again.',
    },
    {
        matches: (message) => /transport|\bice\b|\bdtls\b/i.test(message),
        action: 'The media connection failed. Retry the stream; if it repeats, check firewall or TURN settings.',
    },
];

export function describeUserError(error) {
    const detail = typeof error === 'string' ? error : error?.message || String(error || '');
    const match = FAILURE_ADVICE.find((candidate) => candidate.matches(detail, error));
    if (!match) return { action: detail, detail: '' };
    return { action: match.action, detail };
}
