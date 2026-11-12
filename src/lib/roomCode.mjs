export function normalizeRoomCode(value) {
    return String(value || '').trim().toUpperCase().replace(/-/g, '');
}

// Viewers usually receive a full watch link; accept a pasted URL as well as a
// bare code by pulling the code out of a `#watch/CODE` fragment when present.
export function extractRoomCode(value) {
    const text = String(value || '');
    const urlMatch = text.match(/#\/?watch\/([A-Za-z0-9-]+)/i);
    const source = urlMatch ? urlMatch[1] : text;
    return source.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

export function formatRoomCode(code) {
    return code.length > 3 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}
