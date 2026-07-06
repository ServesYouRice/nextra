# Nice-to-Haves

Improvements that are not defects but would make Nextra feel more complete, trustworthy, and maintainable as a real product. Organized into the requested categories.

---

## High-impact nice-to-haves

These meaningfully change how finished the product feels or how much operators trust it.

### N-1 Optional room passphrase / host approval for viewers
Today the 6-char room code is the *only* gate on watching a stream (`security-issues.md` S-9). For anyone streaming something sensitive, an optional room passphrase, or a "host approves each viewer" lobby, would be a significant trust upgrade — and it fits the existing socket handshake model (add a `passphrase` check in `join-room`, `lib/socket.js:1201`).

### N-2 Persist host session across a full page reload / crash
Host state is entirely in-memory in the React component; a hard reload loses the room (the `reclaim-host` token exists in `hostTokenRef` but isn't persisted). Storing the host token + room code in `sessionStorage` (as already done for OBS password and BYOK TURN, `HostView.jsx:39-40`) and auto-reclaiming on reload would make hosting far more resilient — hosts routinely reload.

### N-3 Show viewers *what* they're waiting for, and a shareable QR code
The viewer "Waiting for host…" and host room-links area would benefit from a QR code for the watch link (mobile viewers), and the host could see a live list/count with connection quality. High perceived-polish, low effort (QR via a tiny inline generator to respect the CSP/no-external-request stance).

### N-4 Graceful "server is shutting down / restarting" signal to clients
On `SIGINT`/`SIGTERM` (`server.js:1223`) and on worker-death auto-restart (`:1049`), clients are dropped without a heads-up. Emitting a `server-shutdown` event so viewers show "Reconnecting to server…" instead of a generic failure would smooth the most jarring moment (especially since the auto-restart is designed to be recoverable).

### N-5 First-run / onboarding guidance on the Host page
A first-time host faces resolution, fps, OBS mode, tuning, TURN, and public-link concepts at once (`ui-issues.md` U-12). A short guided "Browser or OBS?" first-run flow, or inline "what's this?" popovers, would reduce the learning cliff. The How-To view exists but isn't surfaced contextually.

---

## Product polish

### N-6 Consistent, dismissible notifications (toasts)
See `ui-issues.md` U-8 — replace scattered inline alerts with a small toast system and ensure error text clears on recovery.

### N-7 Richer empty/waiting/loading states
See U-9 — echo the room code on the viewer wait screen, add a "copy & share" nudge on host idle, and make the various spinners/placeholders consistent.

### N-8 Self-hosted fonts (drop the Google Fonts dependency)
See `security-issues.md` S-6 — bundling Inter/JetBrains Mono removes an external request on every load, improves offline/LAN use, tightens CSP, and better matches the "self-hosted, nothing leaves your machine" positioning.

### N-9 Copy-link affordances everywhere a code/URL appears
`CopyField` is nice; extend the pattern (e.g. WHEP URL, WHIP URL, bearer token in the manual OBS panel already use code blocks but not one-click copy for the token — `HostView.jsx:1604`).

### N-10 Surface stream health to the host
The host already receives rich `room-metrics`; a compact "stream health" indicator (relay vs WebRTC split, dropped-chunk count from `relay.droppedOversized`, fallback restart count) would help hosts diagnose viewer complaints without opening the Status page.

---

## Developer-experience improvements

### N-11 Break up `HostView.jsx` (1762 lines) and `WatchView.jsx` (1337 lines)
Both are single components with 25–40 state atoms and 4+ near-duplicate "reset all state" blocks (e.g. `WatchView` reset at `:766-784`, `:1130-1147`, `handleLeave:1048-1064`). Extract subcomponents (SettingsPanel, ObsConfigPanel, RoomLinks, ViewerControls) and a `useViewerSession` / `useHostSession` hook that owns the lifecycle + a single `resetSession()` — this removes the duplication that makes state bugs easy (see `logical-issues.md` L-9/L-12 patterns).

### N-12 Break the module dependency cycle (`socket.js` ↔ `whipRoutes.js` ↔ `rooms.js`)
Lazy `require`s inside functions (`rooms.js:241`, `whipRoutes.js` importing `./socket`) hide a cycle. Extract a `relayController` module that both depend on so requires move to file top and the flow is statically analyzable (`logical-issues.md` L-11).

### N-13 Replace the `registerSocketHandlers._ioRef` global with explicit passing
`lib/socket.js:1101` stashes the io instance on the function object as a global; `startFallbackRelay` falls back to it (`:663`). Thread `io` through explicitly (it usually is) and drop the ambient reference — it makes testing (T-2) and reasoning easier.

### N-14 Structured logging instead of `console.log`
The server logs heavily via `console.log` with `[WHIP]`/`[Fallback]`/`[Nextra]` prefixes (hundreds of call sites). A leveled logger (pino/winston) with a `LOG_LEVEL` and JSON option would make production logs filterable and shippable, and would let the very chatty WHIP debug logging (`whipRoutes.js:283-291,313,328` etc.) be silenced by default. `MEDIA_DEBUG_LOGS` already gates some of it — generalize that.

### N-15 A `dev` experience note: `nut-js` is an undeclared optional dependency
`@nut-tree-fork/nut-js` is `require`d at runtime (`socket.js:136`) but not in `package.json`, so the default media-control path is the PowerShell/xdotool fallback. Either declare it as an optional dependency with docs, or make the fallback the documented default. (Cross-ref `security-issues.md` S-3.)

### N-16 Type-checking / JSDoc enforcement
The code has good JSDoc in places (`ffmpegRelay.js`, `fmp4RelayPlayer.js`) but no TypeScript or `checkJs`. Turning on `// @ts-check` + `jsconfig.json` with `checkJs` would catch a class of the shape/undefined bugs cheaply, given the JSDoc already present.

---

## Architecture / stack recommendations

### N-17 mediasoup worker pool
See `performance-issues.md` P-1 — move from one worker to a per-core pool with per-room router assignment. This is the single biggest capacity/robustness change and isolates worker crashes from the whole process.

### N-18 Move relay media processing off the main thread
See `performance-issues.md` P-2 — Worker threads / child processes for H.264 depacketizing + FFmpeg orchestration so media crunching never blocks signaling.

### N-19 Optional persistence layer for multi-instance / horizontal scale
State is intentionally in-memory (correct for the single-host product). *If* a hosted multi-instance offering is ever desired, room/session state would need an external store (Redis) and sticky routing. Not needed for the current product — flagged only so the in-memory assumption is a conscious boundary, not an accident.

### N-20 Consider replacing/forking `caxa` for packaging
`caxa` is effectively unmaintained and the packaging story is Windows-only via `.bat` (`update-nextra-exe.bat`, `restart.bat`). A more actively-maintained packager (e.g. `pkg` successor, or Node SEA — Single Executable Applications, now stable in Node 20+) would de-risk the distribution pipeline and enable macOS/Linux binaries. (Cross-ref `production-readiness.md`.)

### N-21 Provide a Docker image / compose for the "server on a box" use case
Some operators will want Nextra on a small VPS behind a real reverse proxy (the code already supports `TRUST_PROXY`, `SHARE_BASE_URL`, forwarded headers). A `Dockerfile` + example `docker-compose` with coturn would make that a supported path instead of a DIY one.

---

## Future roadmap ideas

- **Recording** — the fMP4/WebM pipeline is already producing muxed output; an opt-in "record this stream to disk" is a natural extension.
- **Multiple simultaneous hosts / screens per room** — the room model is single-producer today; a co-presenter mode is a plausible next step.
- **Chat / reactions sidebar** — Socket.IO is already the transport; a lightweight room chat would round out the "watch together" experience.
- **Adaptive quality signaling to viewers** — surface the current tier and let viewers request lower latency vs. higher quality.
- **Metrics export** — a `/metrics` Prometheus endpoint (distinct from the human `/api/metrics`) for operators running it as a service (cross-ref `production-readiness.md`).
- **i18n** — all copy is hard-coded English; externalizing strings would broaden reach.
- **Accessibility pass to WCAG AA** — the baseline is good (skip link, focus-visible, reduced-motion); a formal audit (contrast, focus trap N U-5, screen-reader flows) would make it defensibly accessible.
