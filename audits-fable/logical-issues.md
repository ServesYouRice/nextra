# Logical Issues

Findings from the application logic, async handling, and implementation-quality review. Each finding: severity, location, problem, production impact, recommended fix, blocker status.

---

## L-1 · Committed `package-lock.json` is corrupted (invalid JSON)

- **Severity:** Critical
- **Location:** `package-lock.json` ~line 2400 (`node_modules/color-convert` entry)
- **Problem:** A botched merge glued two dependency objects together. Inside `color-convert`'s `dependencies`, `"color-name": "~1.1.4"` is followed (without a comma or closing brace) by `"string-width"`, `"strip-ansi"`, `"wrap-ansi"` and an `engines` block belonging to a different package. The file no longer parses: `JSON.parse` throws `Expected ',' or '}' … at line 2403`.
- **Verified:** `npm ci` fails with `EUSAGE … can only install with an existing package-lock.json` (npm treats the unparseable file as missing). Every CI job (`verify`, `browser-media`, `windows-package`) and the signed release workflow start with `npm ci`/`npm run package`, so **all CI and the release pipeline are broken on `main` right now**.
- **Why it matters:** No reproducible installs, no CI signal, no releasable artifact. Also defeats supply-chain pinning — anyone running `npm install` resolves fresh versions.
- **Fix:** Regenerate with `npm install --package-lock-only` (or delete + `npm install`) on Node 20, inspect the diff, commit. Add a CI-fast guard: `node -e "JSON.parse(require('fs').readFileSync('package-lock.json'))"` or simply rely on `npm ci` failing loudly at the top of the pipeline (it does — the issue is it was merged anyway; consider requiring green CI before merge).
- **Blocker:** **Yes** — hard blocker for any release.

## L-2 · `npm run lint` fails (6 errors) — the release gate is red

- **Severity:** High
- **Location:** `src/HostView.jsx:549,589`, `src/StatusView.jsx:80`, `src/WatchView.jsx:257` (`react-hooks/set-state-in-effect`), `src/WatchView.jsx:1332` ×2 (`react-hooks/refs`)
- **Problem:** `release:prep` starts with `npm run lint`, which exits non-zero. Four are synchronous `setState` inside effect bodies; two flag `joinedRoomCodeRef.current` being read during render (`You're in room {formatRoomCode(normalizeRoomCode(joinedRoomCodeRef.current || codeInput))}`).
- **Why it matters:** The repo's own quality gate cannot pass, so CI is red independent of L-1. The `react-hooks/refs` one is also a real correctness smell: a ref mutation does not trigger re-render, so the room label shown in the "Waiting for host" overlay can be stale until an unrelated state update happens to re-render (in practice `setJoined` re-renders first, so today it displays correctly — but it works by coincidence, not by contract).
- **Fix:** For WatchView 1332, mirror the joined room code into state (a `joinedRoomCode` state alongside the ref) and render the state. For the `set-state-in-effect` cases, derive during render or wrap in the event/subscription callback as the rule suggests. If a rule is judged too strict, downgrade it explicitly in `eslint.config.mjs` rather than shipping a red gate.
- **Blocker:** **Yes** (CI must be green to release).

## L-3 · `serverIntegration` test depends on `dist/` but `release:prep` runs tests before `build`

- **Severity:** High
- **Location:** `tests/serverIntegration.test.js:217` (asserts `GET /watch/example` → 200 + `<div id="root">`), `package.json` `release:prep` script, `.gitignore:11` (`dist` is ignored)
- **Problem:** The SPA catch-all returns **503 "build required"** when `dist/index.html` is absent. `release:prep` order is `lint → typecheck → test → test:coverage → build → …`, so on a clean checkout the test deterministically fails before build runs.
- **Verified:** `npm test` fails 1/141 with `503 !== 200` on a fresh clone; after `npm run build` the same test passes.
- **Fix (either):** (a) move `npm run build` before `npm test` in `release:prep`, or (b) have the test build a stub `dist/index.html` fixture in a temp dir and point the server at it, or (c) make the test accept the documented 503 page when `dist` is absent and assert the 200 path in the packaged smoke test only. Option (a) is the one-line fix.
- **Blocker:** **Yes** (same reason as L-2 — the gate cannot pass as committed).

## L-4 · `FALLBACK_AUDIO_OFFSET_MS` default (1500 ms) contradicts the current A/V-sync design

- **Severity:** Medium
- **Location:** `config.js:368` (default `1500`), `.env.example:92` (documents 1500 with the pre-redesign rationale), vs `lib/socket.js:888-892` and `lib/ffmpegRelay.js:166-170` (comments state audio/video are now **keyframe-anchored** and the offset is "an optional fine-tune (**default 0**)")
- **Problem:** The relay was redesigned so audio and video start on the same keyframe event, eliminating the need for a fixed offset — the code comments say the default is 0, but the shipped default is still 1500 ms. With the new anchoring, every OBS-fallback room delays audio 1.5 s behind the picture by default.
- **Why it matters:** Out-of-the-box lip-sync error of ~1.5 s on the OBS fallback path (the main path for tunnel viewers). Users will perceive the product as broken; the knob exists precisely to avoid this.
- **Fix:** Decide which is true. If keyframe anchoring works as described, change the default to `0` in `config.js` and rewrite the `.env.example` comment. If field evidence says 1500 is still needed, fix the two code comments instead. Validate with a real OBS session (see `REMAINING-WORK.md` §2).
- **Blocker:** No, but should be resolved before promoting the OBS fallback path.

## L-5 · Socket.IO viewer transports get the host bitrate profile (8 Mbps), bypassing the viewer tier

- **Severity:** Medium
- **Location:** `lib/mediasoup.js:72-77` (`purpose` param: `'whep'`/`'viewer'` → 600 kbps initial BWE, otherwise 8 Mbps) vs `lib/socket.js:1507` and `lib/socket.js:1544` (`createWebRtcTransport(router)` with no purpose for both send **and recv** transports)
- **Problem:** The comment says "WHEP/viewer transports use conservative BWE to avoid remote congestion", but the Socket.IO `create-recv-transport` path — the main browser-viewer path — never passes `purpose: 'viewer'`, so every browser viewer starts at `initialAvailableOutgoingBitrate: 8_000_000`.
- **Why it matters:** Remote/WAN viewers on constrained links get an aggressive initial send estimate; the first seconds can burst, overflow queues, and cause early freezes before congestion control converges. WHEP viewers behave differently from Socket.IO viewers for no reason.
- **Fix:** Pass `{ purpose: 'viewer' }` in the `create-recv-transport` handler. Keep the host/send path at the high profile.
- **Blocker:** No.

## L-6 · Host UI has no `server-restarting` handling — host page shows stale "Streaming" after a server restart

- **Severity:** Medium
- **Location:** `server.js:1477` (emits `server-restarting` to all sockets), `src/WatchView.jsx:749` (handled), `src/HostView.jsx` (no listener)
- **Problem:** On graceful shutdown/worker-death restart, viewers get a "Server restarting; reconnecting…" overlay, but the host page ignores the event. After the restart the in-memory room is gone; the host's `reclaim-host` on reconnect fails (it only warns to console: `HostView.jsx:877`), yet `isSharing` stays `true`, the status bar keeps saying "Streaming", and the room code/links shown are dead.
- **Why it matters:** The host — the one person who can fix the situation by re-sharing — is the only participant who isn't told the session died. Real-world impact: host keeps presenting to nobody.
- **Fix:** Add a `server-restarting` listener in HostView, and treat a failed `reclaim-host` on reconnect (room not found) as terminal: run `cleanup()` and surface "Server restarted — start sharing again to get a new room code."
- **Blocker:** No, but high user-pain for the supervised-restart recovery story the server explicitly implements.

## L-7 · `create-room` with a passphrase blocks the event loop with `scryptSync`

- **Severity:** Low
- **Location:** `lib/rooms.js:119` (`crypto.scryptSync(passphrase, salt, 32)`)
- **Problem:** Room creation hashes the passphrase synchronously (~50–100 ms at default scrypt cost). Verification (`verifyRoomPassphrase`) is already async — only creation blocks. On a media server, a 50–100 ms event-loop stall causes RTP-adjacent work (relay chunk fanout, socket acks) to jitter.
- **Why it matters:** Bounded by the create-room rate limit (10/min/IP) so it is not a DoS, but each passphrase-protected room creation adds a visible latency spike for every active stream on the box.
- **Fix:** Use the async `crypto.scrypt` and make `createRoom` async (its only caller is already inside an async-friendly handler), or hash lazily on first join.
- **Blocker:** No.

## L-8 · Misleading viewer copy: "The stream starts automatically once the host begins sharing"

- **Severity:** Medium (correctness of behavior vs copy)
- **Location:** `src/WatchView.jsx:1330-1334` overlay vs `onNewProducer` (`WatchView.jsx:699-717`)
- **Problem:** For browser-ingest rooms, `new-producer` only sets `hasProducer(true)` when the viewer is not yet watching — it never starts playback. The overlay then swaps to a "Watch Stream" button the viewer must click. Only OBS rooms with `preferRelayFirst` auto-enter fallback playback. The promised auto-start does not exist on the most common path.
- **Why it matters:** Viewers who joined early and switched tabs wait forever on a promise the app doesn't keep.
- **Fix:** Either auto-invoke `handleWatch()` from `onNewProducer` when `joined && !watching` (autoplay-muted to satisfy gesture policies — the code already downgrades to muted on `NotAllowedError`), or change the copy to "Press Watch Stream when the host goes live." Auto-start is the better product behavior; the muted-autoplay fallback already exists.
- **Blocker:** No.

## L-9 · Host bandwidth warning recommends a quality tier that doesn't exist

- **Severity:** Low
- **Location:** `src/HostView.jsx:479-481` ("Consider 720p.") vs `QUALITY_PROFILES` (`4k`, `1440p`, `1080p` only)
- **Problem:** The warning tells hosts to pick 720p; the resolution dropdown has no 720p option (and never applies one).
- **Fix:** Add a 720p profile (capture 1280×720, proportional relay/OBS bitrates) or reword to "Consider 1080p @ 30 fps."
- **Blocker:** No.

## L-10 · Optional native dependency `@nut-tree-fork/nut-js` is required at runtime but absent from `package.json`

- **Severity:** Low
- **Location:** `lib/socket.js:138` (`require('@nut-tree-fork/nut-js')` inside `loadNutJs`), error copy at `lib/socket.js:178` tells macOS users to "install @nut-tree-fork/nut-js"
- **Problem:** The remote media-control feature prefers nut-js and falls back to PowerShell `keybd_event` (Windows) / `xdotool` (Linux); macOS has no fallback. The dependency is not declared anywhere (not even `optionalDependencies`), so it can never be present in a packaged build, making the primary path dead code and macOS support impossible as shipped.
- **Fix:** Either declare it as an `optionalDependency` (weigh native build cost in the caxa package), or delete the nut-js path and document media control as Windows/Linux-only. Update the macOS error message accordingly.
- **Blocker:** No (feature is opt-in and defaults off).

## L-11 · Unbounded/slow-leaking bookkeeping maps (minor)

- **Severity:** Low
- **Location:**
  - `server.js:743` `cloudflareTurnMintByIp` — entries are never pruned. Only local/LAN clients can reach the endpoint, so growth is bounded by LAN size; still, it's a leak.
  - `lib/socket.js:79` `ignoredTransportIds` — removed only when the transport emits `close`; transports torn down via worker death may never emit, leaving residual IDs for the process lifetime.
- **Why it matters:** Negligible in normal operation; matters for the long-uptime supervised-service profile this project targets (the churn suite watches for exactly this class of drift).
- **Fix:** Sweep `cloudflareTurnMintByIp` in the existing 5-minute cleanup interval; clear `ignoredTransportIds` wholesale in `cleanupGlobalResources()` / on worker death.
- **Blocker:** No.

## L-12 · `reclaim-host` and WHIP bearer-token comparisons are not constant-time

- **Severity:** Low
- **Location:** `lib/rooms.js:163` (`room.hostToken !== hostToken`), `lib/whipRoutes.js:258` (`token !== room.hostToken`)
- **Problem:** Host tokens (48 hex chars, 192-bit) are compared with `!==`. The server already has `timingSafeStringEqual` in `server.js:667` for the metrics token — the same rigor isn't applied here. Practical exploitability over a network is nil given token entropy, but it's an inconsistency in an otherwise carefully hardened codebase.
- **Fix:** Reuse `timingSafeStringEqual` (move it into `lib/network.js` or a small `lib/auth.js`).
- **Blocker:** No.

## L-13 · Duplicated logic worth consolidating (maintainability)

- **Severity:** Low
- **Location / examples:**
  - Room-metrics payload assembly duplicated between `emitHostMetricsSummary` (`lib/socket.js:414-452`) and the `get-room-metrics` handler (`lib/socket.js:1448-1477`) — 25 near-identical fields; they have already drifted (`relayAllowed` default handling differs subtly).
  - `formatBytes` implemented three times (`src/HostView.jsx:268`, `src/StatusView.jsx:6`, `src/components/HostDiagnostics.jsx:3`) with slightly different GB handling.
  - Share-URL/forwarded-header resolution exists in three flavors in `server.js` (`getShareBaseUrl`, `getShareBaseUrlFromHeaders`, `getShareBaseUrlForSocket`).
  - `trimBuffer()` and `evictOldBuffer()` in `src/lib/fmp4RelayPlayer.js` are byte-for-byte identical functions.
  - `parseUrlHostParts` (`server.js:172`): `trimmed.startsWith('[') ? \`https://${trimmed}\` : \`https://${trimmed}\`` — both branches identical; the ternary is dead.
- **Fix:** Extract a single `buildRoomMetricsPayload(room, summary)`, one shared `formatBytes`, one URL-resolution helper. None of these are behavior bugs today; they are drift generators.
- **Blocker:** No.

## L-14 · WatchView reconnect handler races the passphrase state

- **Severity:** Low
- **Location:** `src/WatchView.jsx:1133-1231` (`onReconnect` → `joinRoomAndLoadDevice(roomCode)`) with `passphrase` from state
- **Problem:** On socket reconnect the viewer silently re-joins with the passphrase held in state. If the viewer originally joined via a passphrase and the host has since **rotated the room** (new room, same code cannot happen — codes are unique — but a *different* room can reuse the code after destroy+create), the rejoin can land in a different room without the viewer re-consenting, or fail with a passphrase prompt that resets all state. Edge-case, but the failure path resets to the join form losing context, which is correct-but-abrupt.
- **Fix:** Acceptable as-is; if polishing, keep `joinedRoomCodeRef` displayed in the error copy ("Room ABC-123 is gone…").
- **Blocker:** No.

## L-15 · `HostView` unmount teardown relies on a `setTimeout(0)` StrictMode dance

- **Severity:** Low (fragility)
- **Location:** `src/HostView.jsx:849-862`
- **Problem:** Effect cleanup defers `host-stopped` + `cleanup()` by one macrotask so StrictMode's replay can cancel it. It works, but it means a real unmount (e.g., navigating `#host` → `#watch` while sharing) tears the session down asynchronously; any code that navigates and immediately re-mounts HostView within the same task could cancel a legitimate teardown. It also couples correctness to StrictMode timing.
- **Fix:** Gate on an explicit "session active" ref instead of a timing window, or accept and document. Low priority; behavior today is correct in both dev and prod builds.
- **Blocker:** No.

---

## Production Blockers

Must be fixed before launch (see `production-readiness.md` for the full ordered plan):

1. **L-1** — Regenerate the corrupted `package-lock.json`; nothing installs reproducibly and all CI/release workflows fail.
2. **L-2** — Make `npm run lint` pass (6 errors in HostView/WatchView/StatusView).
3. **L-3** — Fix `release:prep` ordering (build before test) or remove the test's hidden `dist/` dependency.
4. **L-4** — Resolve the 1500 ms vs 0 ms audio-offset contradiction before exposing the OBS fallback path to real users (conditional blocker: only if OBS fallback is in the launch surface).

Items already tracked in `REMAINING-WORK.md` (signing secrets, target-host benchmarks, real-topology matrix, legal review) remain valid release conditions and are not duplicated here.
