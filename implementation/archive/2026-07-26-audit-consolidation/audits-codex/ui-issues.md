# UI and UX Issues

## Summary

| ID | Severity | Finding | Production blocker |
| --- | --- | --- | --- |
| U-1 | High | Public tunnel viewers can remain stuck in relay connection failure | Yes; canonical logic issue L-1 |
| U-2 | Medium | Waiting copy promises automatic playback that does not happen | No |
| U-3 | Medium | Passphrase-protected rooms require a failed join before showing the passphrase field | No |
| U-4 | Medium | The primary room-code field has no accessible name | No |
| U-5 | Medium | Route changes do not update document title or move/announce focus | No |
| U-6 | Medium | Host UI remains in a stale streaming state after failed restart reclaim | Yes for recovery claims |
| U-7 | Medium | AV1 compatibility warning is based on the wrong browser capability | No |
| U-8 | Medium | Live frame-rate selection is not exposed as a selected state to assistive technology | No |
| U-9 | Low | Congestion warning recommends an unavailable 720p tier | No |
| U-10 | Low | Status page mentions token access but provides no token workflow | No |
| U-11 | Low | Small-phone CSS contains duplicate, conflicting breakpoints | No |
| U-12 | Medium | Cross-browser, responsive, and assistive-technology behavior is not verified | Evidence blocker for a broad support claim |

## U-1 - Public tunnel viewers can remain stuck in relay connection failure

- **Severity:** High
- **Location:** Watch connecting overlay and relay status in `src/WatchView.jsx`; canonical implementation details in L-1 of `logical-issues.md`
- **Description:** Tunnel viewers are sent into relay-first playback, but a late viewer can wait for a live initialization event that the prewarmed host recorder never re-emits. The UI remains on Connecting before eventually showing a technical timeout and attempting an unreachable WebRTC fallback.
- **Why it matters for production:** The default packaged public-sharing journey can fail after the host appears fully live, with no useful recovery action for the viewer.
- **Recommended fix:** Fix the generation contract in L-1, then present a bounded “Preparing compatibility relay” state with a retry action and a diagnostic that distinguishes host relay readiness from viewer network failure.
- **Blocker before production:** Yes.
- **Related risks/dependencies:** MediaRecorder generation, public tunnel, relay queue, T-4.

## U-2 - Waiting copy promises automatic playback that does not happen

- **Severity:** Medium
- **Location:** `src/WatchView.jsx:1318-1335`
- **Description:** The empty viewer state says the stream starts automatically when the host begins. `new-producer` only changes `hasProducer`; the overlay then presents a **Watch Stream** button. Playback requires another user action.
- **Why it matters for production:** A viewer may leave the tab waiting and miss the stream, especially when joining before OBS connects.
- **Recommended fix:** Change the copy to “When the host starts, click Watch Stream.” If true auto-start is desired, attempt it only after an explicit prior user gesture and show an unmute/play fallback when autoplay policy blocks it.
- **Blocker before production:** No.
- **Related risks/dependencies:** Browser autoplay policy, OBS reconnect, accessibility announcements.

## U-3 - Passphrase-protected rooms require a failed join before showing the passphrase field

- **Severity:** Medium
- **Location:** `src/WatchView.jsx:78`, `src/WatchView.jsx:897-918`, `src/WatchView.jsx:1281-1293`
- **Description:** The passphrase input appears only after the server rejects the first join. Direct-link users therefore follow an avoidable submit/fail/submit flow, and the new field is not automatically focused.
- **Why it matters for production:** It makes protected rooms feel broken and adds friction to the security feature users are encouraged to adopt.
- **Recommended fix:** Offer an always-available “Room has a passphrase” disclosure, or add a non-admitting room preflight that returns only `passphraseRequired`. On rejection, focus the passphrase field, preserve the room code, and use specific announced guidance without revealing whether arbitrary room codes exist.
- **Blocker before production:** No.
- **Related risks/dependencies:** Room-enumeration policy, join rate limits, passphrase retry behavior.

## U-4 - The primary room-code field has no accessible name

- **Severity:** Medium
- **Location:** `src/WatchView.jsx:1264-1279`
- **Description:** The room-code input uses a placeholder and help text but no `<label>` or `aria-label`. Placeholder text is not a durable accessible name.
- **Why it matters for production:** Screen-reader and voice-control users encounter an unnamed textbox at the key entry point to the viewer journey.
- **Recommended fix:** Add a visible `<label for>` (“Room code or watch link”) and retain the hint via `aria-describedby`. Ensure errors are associated with the field using `aria-invalid` and `aria-errormessage`.
- **Blocker before production:** No, but required for a WCAG AA claim.
- **Related risks/dependencies:** Automated accessibility testing, form error focus.

## U-5 - Route changes do not update document title or move/announce focus

- **Severity:** Medium
- **Location:** `src/App.jsx:29-93`; `index.html:31`
- **Description:** Hash navigation swaps lazy views but leaves the document title as “Nextra” and leaves keyboard/screen-reader focus on the prior navigation link. The new `<h1>` is not announced as a page transition.
- **Why it matters for production:** Users of assistive technology can lose context, and browser history/tab titles do not identify Host, Watch, Status, or legal pages.
- **Recommended fix:** Associate each route with a title, set `document.title`, and focus an appropriate route heading or the main landmark after user-initiated navigation while avoiding disruptive focus movement on initial load.
- **Blocker before production:** No.
- **Related risks/dependencies:** Hash router behavior, lazy-loading state, back/forward navigation.

## U-6 - Host UI remains in a stale streaming state after failed restart reclaim

- **Severity:** Medium
- **Location:** `src/HostView.jsx:865-882`; `src/WatchView.jsx:704-758`
- **Description:** Watch handles `server-restarting`; Host does not. When reconnect/reclaim fails because the replacement server has no room, Host only writes a console warning and keeps the prior code, viewer count, and Streaming state.
- **Why it matters for production:** The host believes viewers can still use a dead link and has no directed recovery path.
- **Recommended fix:** Handle restart/disconnect explicitly on Host. Show a blocking reconnect state; if reclaim returns terminal room-not-found/token-invalid, clean up local media/session state and offer **Create a new room**, explaining that the old code is retired.
- **Blocker before production:** Yes if restart recovery is advertised; otherwise the copy and terminal behavior must be corrected.
- **Related risks/dependencies:** L-2, server worker recovery, room recreation policy.

## U-7 - AV1 compatibility warning is based on the wrong browser capability

- **Severity:** Medium
- **Location:** `src/WatchView.jsx:847-856`; `src/lib/watchPlaybackMode.mjs`
- **Description:** The warning uses MSE MP4 capability as a proxy for WebRTC AV1 receive support.
- **Why it matters for production:** Users can see a false incompatibility warning or get no warning before a negotiation failure.
- **Recommended fix:** Use WebRTC RTP capabilities after the mediasoup device loads. Explain whether the missing piece is browser decode, TURN reachability, or the host's public media address; those require different remedies.
- **Blocker before production:** No.
- **Related risks/dependencies:** L-5, browser/device matrix.

## U-8 - Live frame-rate selection is not exposed as a selected state to assistive technology

- **Severity:** Medium
- **Location:** `src/HostView.jsx:1538-1551`; compare OBS tuning buttons at `src/HostView.jsx:1490-1505`
- **Description:** The 30/60 fps buttons use only an `active` CSS class. They have neither a labelled group nor `aria-pressed`, unlike the OBS tuning control immediately above.
- **Why it matters for production:** A screen-reader user cannot determine which frame rate is active while streaming.
- **Recommended fix:** Give the group an accessible label and each toggle `aria-pressed`, or use a labelled native select/radio group consistently.
- **Blocker before production:** No.
- **Related risks/dependencies:** Live constraint application and focus styling.

## U-9 - Congestion warning recommends an unavailable 720p tier

- **Severity:** Low
- **Location:** `src/HostView.jsx:60-84`, `src/HostView.jsx:478-481`
- **Description:** The UI recommends 720p although the lowest selectable tier is 1080p.
- **Why it matters for production:** Users cannot follow the warning.
- **Recommended fix:** Recommend 1080p/30 fps or add and validate a 720p tier.
- **Blocker before production:** No.
- **Related risks/dependencies:** L-8, capacity benchmarks.

## U-10 - Status page mentions token access but provides no token workflow

- **Severity:** Low
- **Location:** `src/StatusView.jsx:88-99`; `server.js:797-812`
- **Description:** The denied screen says metrics are available “with a metrics token,” but Status never accepts or sends one. Token use is API-only unless a reverse proxy injects the header.
- **Why it matters for production:** Remote operators are pointed to an option the UI cannot perform.
- **Recommended fix:** State that the in-app dashboard is local-only and link to operator documentation. If remote dashboard access becomes a product feature, use a secure operator-auth flow rather than putting a long-lived metrics token in URL or persistent browser storage.
- **Blocker before production:** No.
- **Related risks/dependencies:** S-2, remote metrics policy.

## U-11 - Small-phone CSS contains duplicate, conflicting breakpoints

- **Severity:** Low
- **Location:** `src/index.css:2042-2091`
- **Description:** Two `@media (max-width: 400px)` blocks duplicate view padding and assign different room-code font sizes; the later rule silently wins.
- **Why it matters for production:** It makes mobile tuning error-prone and obscures the intended 320-400 px layout.
- **Recommended fix:** Consolidate the blocks and keep one explicit small-phone contract. Add viewport tests at 320, 375, 640, 900, and wide desktop widths.
- **Blocker before production:** No.
- **Related risks/dependencies:** U-12, visual regression coverage.

## U-12 - Cross-browser, responsive, and assistive-technology behavior is not verified

- **Severity:** Medium
- **Location:** `playwright.config.mjs:17-26`; `tests/browser/media-flow.spec.mjs`; `src/index.css`
- **Description:** Automated browser coverage is Desktop Chrome only. No retained evidence covers small phones/tablets, Firefox/Safari, keyboard-only operation, screen readers, zoom/reflow, contrast, or axe-style rules. Source includes good foundations (skip link, focus-visible, reduced motion, focus-trapped modal), but that is not equivalent to verification. The in-app browser surface was unavailable during this audit, so no live visual claim is made here.
- **Why it matters for production:** Capture, MediaSource, fullscreen, autoplay, and WebRTC behavior are browser-sensitive, and the host layout expands to multiple fixed-width panels.
- **Recommended fix:** Add Chromium mobile viewport projects plus Firefox and WebKit for non-capture routes; run axe on each route/state; perform manual NVDA/VoiceOver and keyboard passes; retain screenshots for key breakpoints. Document browser support based on results.
- **Blocker before production:** Evidence blocker for claiming broad browser/mobile/WCAG support; not a blocker for a narrowly documented Desktop Chromium launch.
- **Related risks/dependencies:** External media topology testing, platform capture permissions, codec support.

## Recommended UI Priorities Before Production

1. Fix the public relay journey (U-1/L-1) and prove a late viewer receives decoded frames.
2. Replace false restart continuity with deterministic host/viewer recovery UI (U-6/L-2).
3. Correct waiting/passphrase flows and focus behavior (U-2, U-3).
4. Fix the core accessibility semantics (U-4, U-5, U-8).
5. Use authoritative AV1 capability checks and actionable diagnostics (U-7).
6. Correct the congestion/status copy and consolidate small-phone CSS (U-9 through U-11).
7. Complete the explicit browser, responsive, keyboard, and screen-reader evidence matrix (U-12).
