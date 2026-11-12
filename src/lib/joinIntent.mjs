// A one-shot note left by the home page: "the viewer already asked to join this
// code". The Watch page takes it when it opens with the same code.
const KEY = 'nextra.joinIntent.v1';
const MAX_AGE_MS = 10_000;

export function getSessionStorageSafely(windowLike) {
    try {
        return windowLike?.sessionStorage ?? null;
    } catch {
        return null;
    }
}

export function rememberJoinIntent(code, storage, now = Date.now()) {
    try {
        storage?.setItem(KEY, JSON.stringify({ code, at: now }));
    } catch {
        // Storage blocked: the viewer just presses Join on the Watch page.
    }
}

export function takeJoinIntent(code, storage, now = Date.now()) {
    try {
        if (!storage) return false;
        const raw = storage.getItem(KEY);
        if (raw === null || raw === undefined) return false;
        storage.removeItem(KEY);
        const note = JSON.parse(raw);
        return Boolean(note)
            && note.code === code
            && typeof note.at === 'number'
            && now - note.at <= MAX_AGE_MS
            && now - note.at >= 0;
    } catch {
        return false;
    }
}
