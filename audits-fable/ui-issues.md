# UI / UX Issues

Findings on the user interface, flows, accessibility, responsive behavior, and visual consistency. Severity legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low · 🔵 Nice-to-have.

The app has a **solid a11y baseline** worth acknowledging up front: a skip link (`App.jsx:54`), `:focus-visible` styling and a `prefers-reduced-motion` block (`index.css:109,143`), `aria-current` on active nav (`App.jsx:69`), `role="alert"`/`role="status"` on messages, an `ErrorBoundary` (`components/ErrorBoundary.jsx`), and a `Modal` that closes on Escape/backdrop and restores focus (`components/Modal.jsx`). Findings below are where it falls short of production polish.

---

## U-1 🟠 Escaped-ellipsis literal renders as raw text: `Waiting for OBS…`

- **Severity:** High (visible bug)
- **Blocker:** No, but embarrassing on the primary host screen
- **Location:** `src/HostView.jsx:1620` — `<StatusPill tone="warn">Waiting for OBS…</StatusPill>`

**Problem.** Inside JSX **text nodes**, `…` is not an escape sequence — it renders the literal six characters `…`. The OBS connection status pill on the host page therefore displays **"Waiting for OBS…"** instead of "Waiting for OBS…". Note the sibling at `:1293` correctly uses `'Waiting for OBS...'` (plain dots), confirming this one is a mistake.

**Why it matters.** It appears on the core Host → OBS flow, exactly where a new user is watching for connection status, and reads as broken software.

**Fix.** Use an actual ellipsis character or plain `...`: `Waiting for OBS…`. (Search the codebase for other `\u` sequences inside JSX text — `HostView.jsx:1620` is the confirmed one.)

---

## U-2 🟠 Join / Watch buttons lack a loading/disabled state → double-submit produces confusing errors

- **Severity:** High
- **Blocker:** No
- **Location:** `src/WatchView.jsx:1213` (Join button — no `disabled`, no spinner), `handleJoin:834`; the Watch button *does* disable via `watchLoading` (`:1239`).

**Problem.** The **Join Room** button has no disabled/loading state. `handleJoin` is async (join-room → get-rtp-capabilities → device load). A user who clicks twice, or presses Enter then clicks, fires a second `join-room`; combined with the retry hazard in `logical-issues.md` L-4, the second call returns `Already in a room. Leave first.` and the user sees a hard error even though they joined.

**Why it matters.** First interaction on the viewer flow; the failure text actively misleads ("Leave first" when they never got in).

**Fix.** Add a `joining` state that disables the button and shows "Joining…" while `handleJoin` runs; ignore re-entry. Pair with the idempotent server-side join fix (L-4).

---

## U-3 🟠 Host settings are locked once sharing starts (except fps) with no explanation

- **Severity:** High (UX expectation mismatch)
- **Blocker:** No
- **Location:** `src/HostView.jsx:1359` — the entire settings panel (`resolution`, OBS mode, media-control toggle, OBS config) is gated behind `status === 'idle'`; only the fps toggle remains in the streaming controls (`:1332-1345`).

**Problem.** After *Start Sharing*, the resolution selector, OBS options, and "allow viewers to pause/play" toggle all disappear (the whole `status==='idle'` block unmounts). Yet the code *does* support live quality changes (`applyQualityProfileToLiveStream:861`, effect at `:893`). fps can be changed live but resolution cannot, with no hint why. There is also no way to revoke media-control permission mid-stream.

**Why it matters.** Users reasonably expect to adjust quality while streaming (they can on fps but not resolution), and the abrupt disappearance of the panel reads as the settings being gone rather than intentionally locked.

**Fix.** Keep a compact "live settings" panel while streaming that exposes the changes the code already supports (resolution via `applyQualityProfileToLiveStream`), or explicitly disable-with-tooltip the ones that require a restart. Surface a "stop to change" hint rather than hiding controls.

---

## U-4 🟡 No confirmation on destructive "Stop Sharing" / "Leave Room"

- **Severity:** Medium
- **Blocker:** No
- **Location:** `src/HostView.jsx:1329` (`Stop Sharing` → immediate `handleStopSharing`), `src/WatchView.jsx:1322` (`Leave Room`).

**Problem.** *Stop Sharing* immediately tears down the room and disconnects every viewer with no confirmation. A misclick ends everyone's session; the host must re-share and re-distribute a **new** room code (codes are random per room).

**Fix.** Add a lightweight confirm (native `confirm` or the existing `Modal`) for *Stop Sharing* when viewers are present. *Leave Room* on the viewer side is lower stakes; optional.

---

## U-5 🟡 Modal has no focus trap (focus can escape to the page behind it)

- **Severity:** Medium (a11y)
- **Blocker:** No
- **Location:** `src/components/Modal.jsx:10-26` — focuses the first focusable element on open and restores on close, but does not trap Tab within the dialog.

**Problem.** The BYOK-TURN modal (`HostView.jsx:1628`) is `aria-modal="true"` but Tab/Shift+Tab can move focus to the nav/landing controls behind the backdrop. Screen-reader and keyboard users can interact with obscured content while the modal claims to be modal.

**Fix.** Add a focus trap: on `Tab` at the last focusable element wrap to the first (and vice-versa), scoped to `dialogRef`. The list of focusables is already queried at `:13`.

---

## U-6 🟡 Only two responsive breakpoints; host two-column layout is tight on small screens

- **Severity:** Medium
- **Blocker:** No
- **Location:** `src/index.css` — only `@media (max-width: 900px)` (`:1786`) and `@media (max-width: 640px)` (`:1881`); host layout `.host-layout` is a two-column (`host-video-section` + `host-side-panel`).

**Problem.** The host page packs a video, controls, a settings panel, OBS config, room links, and metrics into two columns. With just two breakpoints the intermediate tablet range and very small phones get cramped stacking. Hosting is desktop-first (screen capture / OBS), so this is lower priority — but the **Watch** page is legitimately used on phones, and the room-links row (`CopyField` ×3) and control button row can overflow at ≤360px.

**Why it matters.** Viewers frequently open the share link on mobile; overflow/cramping there is user-facing.

**Fix.** Add an intermediate breakpoint and verify the Watch controls/room-links wrap cleanly at 320–400px. Confirm the video keeps a sensible aspect ratio without horizontal scroll.

---

## U-7 🟡 Marketing/meta copy is inconsistent with product capability

- **Severity:** Medium (trust/polish)
- **Blocker:** No
- **Location:** `index.html:13` — meta description says *"High-performance 1080p 60fps screen sharing … Zero installs required"*; the app advertises up to **4K@60** (`HostView.jsx:56-78` quality profiles, `App.jsx:118` feature card "Up to 4K @ 60 fps") and hosting the packaged exe is an install.

**Problem.** The SEO/social description undersells resolution (1080p vs 4K) and the "zero installs" claim is only true for viewers, not the host who runs `Nextra.exe`. `og:image` uses a cache-busting `?v=8a4a4017` while other icons don't — minor inconsistency.

**Fix.** Align the meta description with the 4K capability and clarify "no install for viewers." Low effort, improves link previews.

---

## U-8 🟡 Errors surface only as inline alerts; no toast/notification system; some clear too slowly or not at all

- **Severity:** Medium
- **Blocker:** No
- **Location:** e.g. `WatchView.jsx:1193` (`alert alert-error`), `HostView.jsx:1490`; media-control status auto-clears after 3.5 s (`WatchView.jsx:1035`) but most `error` states persist until the next action.

**Problem.** There is no non-blocking notification pattern — everything is an inline block that can push layout around, and several errors have no auto-dismiss so stale messages linger (e.g. a transient reconnect error remains after playback recovers unless another action clears it). Success feedback is sparse (Copy shows "Copied!"; OBS config shows status text; most actions are silent).

**Fix.** Introduce a small toast utility (or standardize the existing `role="status"` blocks with consistent auto-dismiss + a manual close). Ensure recovery paths (`onReconnect`, `onTransportFailed`) clear prior error text on success — some already do (`setError('')`), audit for the ones that don't.

---

## U-9 🟢 Empty / waiting states are minimal and inconsistent

- **Severity:** Low
- **Blocker:** No
- **Location:** `WatchView.jsx:1244` (`Waiting for host to start sharing...`), `HostView.jsx:1286` (`No screen shared yet`), `StatusView.jsx:115` (loading spinner).

**Problem.** Waiting/empty states are bare single-line text without guidance or affordances (e.g. the viewer waiting screen doesn't suggest re-checking the code or show the room they're in; the host idle overlay is a plain sentence). Functional but unfinished-feeling. The Status page and lazy-route `LoadingState` (`App.jsx:99`) are the nicest; the media overlays are the weakest.

**Fix.** Add light guidance to empty states (room code echo on the viewer wait screen, a "share this link" nudge on the host idle state). Purely polish.

---

## U-10 🟢 `aria-hidden` OBS panel remains focusable when hidden

- **Severity:** Low (a11y)
- **Blocker:** No
- **Location:** `src/HostView.jsx:1421-1424` — the OBS config panel is rendered with `aria-hidden={ingestMode !== 'obs'}` but its inputs stay in the DOM and tab order when hidden (it's visually collapsed via `settings-expanded` class, not unmounted).

**Problem.** When OBS mode is off, the OBS config inputs are `aria-hidden` but still keyboard-focusable and can be tabbed into, which is an ARIA anti-pattern (focusable content inside `aria-hidden`).

**Fix.** When hidden, either unmount the panel or add `inert` / `tabindex="-1"` + `disabled` to its controls so it leaves the tab order.

---

## U-11 🟢 Room code input UX: fixed `XXX-XXX` mask assumes exactly 6 chars, no paste normalization feedback

- **Severity:** Low
- **Blocker:** No
- **Location:** `src/WatchView.jsx:1198-1216` — input strips non-alphanumerics, uppercases, slices to 6, inserts a dash.

**Problem.** The masking is reasonable, but pasting a full watch URL (which users will do — they receive a link) dumps the whole URL into the field and gets stripped to the first 6 alphanumerics, which may not be the code. There's no "paste a link or a code" affordance, and no inline validity indicator until submit.

**Fix.** Detect a pasted URL and extract the code from `#watch/CODE`; show inline validity (6/6 chars) before enabling Join.

---

## U-12 🔵 Visual hierarchy on the host page is dense; primary action competes with settings

- **Severity:** Nice-to-have
- **Location:** `src/HostView.jsx:1273-1627`

**Observation.** The host page presents Start Sharing, resolution, fps, OBS toggle, OBS config, tuning profile, room links, viewer count, and metrics with fairly uniform weight. The primary CTA (*Start Sharing*) is a large button (good) but the surrounding settings compete for attention. Consider progressive disclosure (advanced/OBS settings behind a disclosure until needed) so first-run hosts see a clean "pick quality → Start" path.

---

## Recommended UI Priorities Before Production

Ranked by user-facing impact ÷ effort:

1. **U-1 — Fix `Waiting for OBS…` literal.** One-line change; removes a visibly-broken string on the core OBS flow. *(Do first.)*
2. **U-2 — Join button loading/disabled state.** Prevents the misleading "Already in a room" error on the primary viewer action; pairs with logical fix L-4.
3. **U-8 — Ensure error text clears on successful recovery.** Prevents stale/contradictory messages during reconnects.
4. **U-3 — Explain or relax locked host settings while streaming.** Meets user expectations; the live-apply code already exists.
5. **U-5 — Modal focus trap.** Real a11y gap on the only modal.
6. **U-4 — Confirm "Stop Sharing" with viewers present.** Cheap safeguard against ending everyone's session by misclick.
7. **U-6 — Verify Watch page at 320–400px** (viewers are on phones); add an intermediate breakpoint.
8. **U-7 — Align meta copy (4K, viewer-no-install).** Trivial trust polish.
9. **U-10 / U-11 / U-9 / U-12** — a11y hidden-panel, paste-URL code handling, richer empty states, host page hierarchy. Post-launch polish.
