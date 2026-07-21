# UI / UX Issues

Scope: `src/App.jsx`, `HostView`, `WatchView`, `StatusView`, `HowToView`, legal views, shared components, `index.css`. Overall the UI is well past prototype quality — loading/empty/error states exist almost everywhere, the modal is a proper focus-trapped dialog, notifications are aria-live, and there is a skip link, `aria-current` nav, and reduced-motion support. The issues below are the residue.

---

## U-1 · Viewer overlay promises auto-start that never happens

- **Severity:** Medium
- **Location:** `src/WatchView.jsx:1330-1334` ("The stream starts automatically once the host begins sharing.")
- **Problem / Why it matters / Fix:** See `logical-issues.md` **L-8** — for browser rooms the viewer must still click "Watch Stream" when the host goes live. Either implement auto-start (muted-autoplay fallback already exists) or fix the copy.
- **Blocker:** No, but it is the single most user-visible broken promise in the product.

## U-2 · Host page never reacts to a server restart

- **Severity:** Medium
- **Location:** `src/HostView.jsx` (no `server-restarting` listener; failed reclaim only `console.warn`s)
- **Problem:** After a server restart the host still shows "Streaming" with a dead room code and links; viewers meanwhile see a proper "Server restarting…" overlay. See `logical-issues.md` **L-6** for the fix.
- **Blocker:** No, but it undermines the auto-restart recovery the server works hard to provide.

## U-3 · Passphrase field only appears after a failed join (two-step join)

- **Severity:** Low
- **Location:** `src/WatchView.jsx:1281-1293` (`passphraseRequired` set only from the join error)
- **Problem:** A viewer with a passphrase-protected link must: enter code → click Join → read the error → discover a new field → re-enter. There is no way to know up front that a passphrase is needed, and the error tone ("Room passphrase required or incorrect") makes the first attempt feel like a failure rather than a normal step.
- **Fix:** Keep the flow (it avoids leaking which rooms are protected) but soften the first-attempt UX: when `requiresPassphrase` comes back with an empty passphrase, show an informational state ("This room needs a passphrase") instead of a red error, and autofocus the new field.
- **Blocker:** No.

## U-4 · Bandwidth warning recommends non-existent 720p option

- **Severity:** Low
- **Location:** `src/HostView.jsx:479-481` — see `logical-issues.md` **L-9**.
- **Fix:** Add the profile or reword.

## U-5 · "Waiting for host" room label rendered from a ref (stale-render hazard + lint error)

- **Severity:** Low (correct today by coincidence; blocks lint)
- **Location:** `src/WatchView.jsx:1332`
- **Problem:** `joinedRoomCodeRef.current` is read during render; ref writes don't schedule renders. Also one of the 6 CI-blocking lint errors (see **L-2**).
- **Fix:** Mirror into state.

## U-6 · Mobile / Safari support is undefined and partially broken, with no user-facing messaging

- **Severity:** Medium
- **Location:** relay paths (`WatchView.jsx:579-581` throws "Use Chrome, Edge, or Firefox" for MSE WebM), host capture (`getDisplayMedia` unavailable on iOS), `index.css` (responsive breakpoints exist: 900/720/640/400 px — layout itself adapts fine)
- **Problem:** The layout is responsive, but the *capabilities* are not communicated: an iPhone viewer joining a browser-ingest room that needs relay fallback gets a raw error string; an iPad "host" gets a generic getDisplayMedia failure. Nothing in the UI or How-To states which browsers/platforms are supported for which role.
- **Why it matters:** Room links get pasted into phone chats; the first mobile viewer experience is an error message.
- **Fix:** (a) Feature-detect at view load and show a friendly capability banner ("On iOS, watching works only while the host's WebRTC path is reachable; relay fallback needs Chrome/Edge/Firefox"). (b) Add a support matrix to `HowToView`. (c) For OBS rooms, the fMP4 relay MIME (`video/mp4; codecs=avc1…`) may actually work in Safari MSE — worth testing and, if it does, routing Safari viewers to the fMP4 path instead of erroring.
- **Blocker:** No for a desktop-first launch; Yes if mobile viewers are in scope.

## U-7 · Status page polls every 5 s even when the tab is hidden

- **Severity:** Low
- **Location:** `src/StatusView.jsx:79-86`
- **Problem:** The 5-second `/api/metrics` poll continues in background tabs indefinitely. Harmless locally, but it keeps the host machine's radio/CPU busy and inflates server logs.
- **Fix:** Pause on `document.visibilitychange`, resume + immediate fetch on visible.
- **Blocker:** No.

## U-8 · Duplicate `@media (max-width: 400px)` blocks and generally monolithic CSS

- **Severity:** Low
- **Location:** `src/index.css:2042` and `:2075` (two separate 400 px blocks), 2,091-line single file
- **Problem:** Duplicate breakpoints invite drift (one block updated, the other forgotten). The single file is workable but at the size where view-scoped files (or CSS modules) would prevent selector collisions.
- **Fix:** Merge the 400 px blocks; consider splitting per-view when next touched. No visual bug found from this today.
- **Blocker:** No.

## U-9 · Fullscreen button ignores keyboard-only viewers' exit path and lacks pressed state

- **Severity:** Low
- **Location:** `src/WatchView.jsx:1386-1400`
- **Problem:** The Fullscreen button requests fullscreen but never reflects state (no `aria-pressed`, label never becomes "Exit Fullscreen"); exit relies on Esc knowledge. Minor, since the native video controls also expose fullscreen.
- **Fix:** Track `fullscreenchange` and toggle label/`aria-pressed`, or drop the custom button and rely on native controls.
- **Blocker:** No.

## U-10 · Error strings are surfaced verbatim from exceptions

- **Severity:** Low
- **Location:** e.g. `src/HostView.jsx:1260` (`Failed to start sharing: ${err.message}`), various WatchView `setError(err.message)`
- **Problem:** Some raw messages are developer-grade ("WHIP session was superseded during startup", `NotReadableError` strings from getDisplayMedia). The common cases (NotAllowedError, timeouts, tunnel-blocked WebRTC) are already translated nicely; the long tail is not.
- **Fix:** Add a small error-message mapper for the known getDisplayMedia/`AbortError`/`NotReadableError` families; keep raw text in a collapsible "details" line for bug reports.
- **Blocker:** No.

## U-11 · OBS auto-config success/error status is not announced to screen readers consistently

- **Severity:** Low (accessibility)
- **Location:** `src/HostView.jsx:1809-1817` — status lines use `role="status"`/`role="alert"` correctly, but the transient "Connecting to OBS..." → success swap replaces the element rather than updating text inside a persistent live region, which some screen readers miss.
- **Fix:** Keep one persistent `role="status"` container and swap its text content.
- **Blocker:** No.

## U-12 · A formal accessibility pass is still outstanding (acknowledged)

- **Severity:** Medium (process gap, not a specific defect)
- **Location:** repo-wide; `REMAINING-WORK.md` §4 explicitly defers WCAG AA / keyboard-only / screen-reader audit
- **Problem:** The foundations are genuinely good (focus trap, skip link, live regions, labels on all inputs I checked, reduced-motion). Unverified areas: color-contrast ratios of the status pills/hints on the dark theme, focus visibility on `.mode-toggle` buttons, and the video-overlay text over live video.
- **Fix:** Run axe + a keyboard-only session across Host/Watch before public launch; fix contrast tokens centrally in CSS variables.
- **Blocker:** Policy-dependent (legal/АDA exposure is deployment-specific).

---

## Recommended UI Priorities Before Production

1. **U-1 / L-8** — Make viewer auto-start real (or fix the copy). Highest-traffic screen, broken promise.
2. **U-2 / L-6** — Tell the host when the session died (server restart / failed reclaim) and reset the UI.
3. **U-5 / L-2** — Fix the ref-in-render room label (also unblocks CI lint).
4. **U-6** — Decide and message the mobile/Safari support story; friendly capability errors.
5. **U-3** — Soften the passphrase two-step join.
6. **U-4** — 720p recommendation mismatch.
7. **U-10** — Error-message mapper for the getDisplayMedia family.
8. **U-12** — Run the deferred accessibility pass (axe + keyboard-only).
9. **U-7 / U-9 / U-8 / U-11** — Polish batch.
