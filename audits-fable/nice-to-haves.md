# Nice-to-Haves

Product-lens review: what would make Nextra feel complete for real users, beyond the defects in the other files. Grouped as requested. Items already deliberately deferred with acceptance criteria in `REMAINING-WORK.md` §4 (recording, multi-presenter, chat, viewer quality picker, i18n, formal WCAG) are referenced, not duplicated.

---

## High-impact nice-to-haves

1. **Viewer auto-start when the host goes live** (pairs with L-8/U-1). The single change that makes the product feel "live" instead of "click-to-retry". Muted-autoplay fallback already exists in `playVideoElement`.
2. **Host session-death banner + one-click re-share** (pairs with L-6/U-2). After restart/reclaim-failure, offer "Start a new room" that reuses all current settings.
3. **Named-tunnel onboarding.** The quick tunnel's URL churn (every restart = dead links) is the #1 trust risk for repeat hosts. Add a How-To section and a first-run hint: "Sharing regularly? Set up a free named tunnel for a permanent link" with the three required env values.
4. **Support matrix page** (U-6): which browsers/OS work as host vs viewer vs OBS, in `HowToView` and README.
5. **Viewer count / "who's watching" trust signals for viewers.** Viewers currently see only video. A tiny "LIVE · N watching" pill (host-toggleable) makes the room feel alive and confirms connectivity.
6. **Copy-link affordance on the Watch page.** Viewers often re-share; currently only hosts get copy fields/QR.
7. **Pre-flight check panel for OBS hosts**: one button that verifies WHIP listener ready, OBS reachable on :4455, FFmpeg present, tunnel active — the four things that currently fail one at a time.

## Product polish

- Passphrase-aware join flow tone (U-3) and friendly error mapping (U-10).
- Fullscreen button state (U-9); persistent OBS status live region (U-11).
- `#status` auto-pause in hidden tabs (U-7).
- Remember viewer's last room code (sessionStorage) for one-click rejoin after browser restart.
- Toast when the public tunnel URL changes mid-session (hosts currently must notice the share panel silently updating via `server-config`).
- 720p profile for constrained hosts (L-9) — also the natural answer to the bandwidth warning.
- Landing page: the six feature cards are static text; linking each to the relevant How-To anchor costs nothing.
- PWA: manifest + icons exist; a tiny service worker for offline shell + "install app" affordance would complete it (viewers on repeat visits).

## Developer experience improvements

- **Split `lib/socket.js` (2,300 lines).** Natural seams already visible: relay fanout, fallback pipeline orchestration (`startFallbackRelay` is 440 lines), room event handlers, metrics. The pipeline/generation pattern (`RoomMediaPipeline`) shows the codebase knows how; finish the job. Same for `HostView.jsx` (P-6).
- Extract client reconnect/resume decision logic to pure modules and unit-test (T-4) — the `watchPlaybackMode.mjs` pattern is already established.
- One shared `formatBytes`, metrics-payload builder, URL-resolution helper (L-13).
- `npm run verify:fast` (lint + typecheck + unit tests, no build/package) for inner-loop use; document that `release:prep` is the slow full gate.
- Repo hygiene: `branding-concepts/` (design exploration) and `poc-mediasoup/` (machine-compat probe) at the root confuse newcomers; move under `docs/` or `tools/` with a README line each. `restart.bat`/`update-nextra-exe.bat` deserve a `scripts/windows/` home.
- CONTRIBUTING.md with the merge rules that would have prevented L-1 (green CI required; never hand-resolve lockfile conflicts — regenerate).
- Align `actions/setup-node` pins across CI jobs (T-7).

## Architecture / stack recommendations

- **Keep the current architecture.** In-memory single-replica + supervised restart is the right call for this product; the multi-instance triggers are correctly documented in `REMAINING-WORK.md` §3. Do not add a database or Redis without the hosted-product trigger.
- When the caxa reevaluation trigger fires, Node SEA (or a Tauri/Electron shell if a tray UI is ever wanted) is the path — already documented in `docs/packaging-evaluation.md`; no action now.
- Consider `io.to(room)` adapter fanout for relay chunks if benchmarks breach thresholds (P-1) before reaching for worker threads.
- The logger (`lib/logger.js`) supports JSON + levels but the codebase logs via bare `console.*` with prefix tags; adopting `logger.child({ room })` in socket.js would make per-room log filtering trivial for operators. Low priority.

## Future roadmap ideas

- Opt-in recording from the muxed relay output (already fully specified as a trigger-gated item — the fMP4 pipeline makes this nearly free: tee fragments to disk).
- Viewer-selectable quality/latency (deferred in REMAINING-WORK §4; the simulcast layers already exist server-side).
- Multiple presenters per room; chat/reactions (deferred; would force the first real re-architecture of room state — schedule deliberately).
- Stats history on `#status` (sparklines from the last N minutes, client-side ring buffer — no storage needed).
- Optional room TTL / scheduled end time with a countdown for webinar-style use.
- E2E-encrypted rooms (insertable streams) as a differentiator for the privacy-focused self-hosting audience — significant effort; incompatible with the FFmpeg relay path, so scope carefully.
