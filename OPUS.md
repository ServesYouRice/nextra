# OPUS Audit — Nextra (`P2Pvideo`)

**Date:** 2026-05-30
**Scope:** Whole repository — React/Vite client (`src/`), Node/Express + Socket.IO + mediasoup server (`server.js`, `lib/`), packaging (`scripts/`), config, docs, tests.
**Method:** Direct line-by-line read of the tracked source, including all of `server.js`, `config.js`, every `lib/*.js`, the React entry/host/watch views and `src/lib/*`, and `scripts/*`. The only files *not* read in full (low-risk, excluded from specific claims): the static legal views (`HowToView.jsx`, `PrivacyView.jsx`, `CopyrightView.jsx`), `src/index.css`, and the `*.bat` helpers. (`poc-mediasoup/server.js` is a 29-line "does mediasoup compile here" smoke test — harmless leftover.)

> Note on method: an earlier exploration pass in this session returned corrupted tool output describing a different (Electron/MediaMTX) project. That was a tooling artifact and is **not** this codebase. Every finding below is taken from the actual `nextra` source.

---

## 1. Executive summary

Nextra is a self-hosted, low-latency screen-sharing app: a React 19 SPA (Vite) talking to an Express 5 + Socket.IO + **mediasoup** SFU, with two ingest paths (browser `getDisplayMedia` and OBS via **WHIP**), an **FFmpeg → fMP4/MSE relay** fallback for H.264 OBS rooms, optional **AV1** (WebRTC-only, BYOK TURN), an optional standards-based **WHEP** viewer egress, a built-in **Cloudflare quick tunnel** for public links, and Cloudflare TURN credential autofill. It is packaged to a single `Nextra.exe` via `caxa` + `rcedit`.

**Overall the project is in good shape.** The architecture is coherent, the security posture is genuinely thoughtful (CSP w/ per-request nonce, timing-safe token compare, locally-gated forwarded-header trust, room-scoped TURN, server-side-only Cloudflare token, rate/connection limits, an open-source secret-scan preflight), there is a real `node --test` suite, and the hardest real-world constraint — that a Cloudflare quick tunnel cannot carry mediasoup's UDP media — is explicitly detected and handled by failing fast to relay. A follow-up reconciliation with `CODEX.md` confirmed three additional must-fix items: runtime dependency audit failures, OBS password persistence in `localStorage`, and shared-config dotenv loading that makes tests depend on ambient `.env`. The remaining items range from "fix before a public release" down to nits.

| Severity | Count | Theme |
|---|---|---|
| 🟠 High | 9 | dependency audit failures, browser secret storage, ambient-env tests, network-surface surprise, fresh-clone run UX, worker-death handling, unenforced cap, hot-path sync logging, shipped dev cruft |
| 🟡 Medium | ~10 | CORS breadth, static asset perf, websocket-only resilience, O(n) metrics, per-request helmet, no CI gating, test gaps, god-modules, single-worker ceiling, metadata |
| ⚪ Low / Nit | ~12 | NODE_ENV/dev-origin ambiguity, Vite dev allowlist, schema-hardening backlog, report markdown ignore rule, dead ternary, default mismatch, dup helpers, CSP `unsafe-inline`, POC cruft, circular dep |

---

## 2. Strengths (worth keeping)

- **CSP with a per-request nonce** for scripts ([server.js:77-100](server.js#L77-L100)) and **timing-safe** metrics-token comparison ([server.js:604-617](server.js#L604-L617)).
- **Forwarded-header trust is gated to local/private proxy peers** ([lib/network.js:34-51](lib/network.js#L34-L51)), avoiding naive `X-Forwarded-For` spoofing.
- **Tunnel/UDP reality is handled, not ignored**: viewers fail fast (2s) on tunnel origins without TURN and prefer relay ([src/WatchView.jsx:299-345](src/WatchView.jsx#L299-L345), [src/lib/watchPlaybackMode.mjs](src/lib/watchPlaybackMode.mjs)).
- **WHEP hardening**: viewer-filtered RTP capabilities so a video-only offer can't allocate an audio consumer, per-IP rate limit, global session cap, and error-path resource cleanup ([lib/whepRoutes.js:116-335](lib/whepRoutes.js#L116-L335), [lib/whep.js:457-539](lib/whep.js#L457-L539)).
- **Supply-chain preflight** that scans tracked files for secrets/binaries before publishing ([scripts/opensource-preflight.js](scripts/opensource-preflight.js)).
- **A genuine test suite** covering the pure modules ([tests/](tests/)).

---

## 3. 🟠 High-severity findings

### H1 — Media plane binds `0.0.0.0` and announces the LAN IP regardless of `BIND_HOST`
[lib/mediasoup.js:24-32](lib/mediasoup.js#L24-L32)
```js
const effectiveListenIp = config.RTC_LISTEN_IP === '127.0.0.1' ? '0.0.0.0' : config.RTC_LISTEN_IP;
const listenIps = [{ ip: effectiveListenIp, announcedIp: config.LAN_IP }];
```
The default `BIND_HOST=127.0.0.1` ([.env.example:5](.env.example#L5)) makes users reasonably believe the app is "local only." But mediasoup deliberately overrides a loopback `RTC_LISTEN_IP` to `0.0.0.0`, so the **media plane (UDP 40000–40099) listens on all interfaces and advertises the LAN IP** even when the HTTP control plane is localhost-bound. Combined with access being gated only by a 6-char room code, anyone on the LAN who learns/guesses a code can pull media. This is defensible for LAN viewing, but it's a surprising widening of the attack surface relative to the documented default and should be called out (and ideally made explicit/opt-in).
- **Fix:** document this clearly; consider keying media-interface exposure off an explicit `EXPOSE_LAN`/`RTC_LISTEN_IP` rather than silently overriding loopback, and/or add per-room join secrets beyond the code.

### H2 — `npm start` on a fresh clone serves a blank page (no `dist/`)
[server.js:722-757](server.js#L722-L757), [package.json:10](package.json#L10), [README.md:322-327](README.md#L322-L327)
`start` is `node server.js`, which serves the built SPA from `dist/` and falls back to `res.sendFile(indexHtmlPath)`. On a fresh clone there is no `dist/` (it's gitignored and only produced by `npm run build`), so `getIndexHtml` returns `null` and the app serves a 404/blank root. Yet README's "For Developers" labels `npm start` as "start dev server," and the Quick Start shows `npm install` → `npm start`. The actual dev path is `npm run dev` (concurrently server + Vite).
- **Impact:** a new contributor following the README gets a blank page and no obvious error.
- **Fix:** make `start` build-if-missing or print a clear "run `npm run build` first" message; fix the README labels (`npm start` is the *production* server; `npm run dev` is dev).

### H3 — mediasoup worker death kills the whole process with a misleading log and no restart
[lib/mediasoup.js:15-18](lib/mediasoup.js#L15-L18)
```js
worker.on('died', () => {
    console.error('Mediasoup Worker died unexpectedly. Restarting in 2s...');
    setTimeout(() => process.exit(1), 2000);
});
```
It logs "Restarting" but actually just `process.exit(1)` — there is no supervisor in `server.js` and no `npm start`-level auto-restart, so a worker crash drops every room with no recovery. The packaged exe also has no relauncher.
- **Fix:** either implement real worker recreation (new worker + router, migrate/redrop rooms) or correct the message to "Shutting down" and document that an external supervisor is required.

### H4 — Documented relay-viewer cap (`MAX_FALLBACK_VIEWERS`) is never enforced
[config.js:311](config.js#L311), [lib/socket.js:1455-1478](lib/socket.js#L1455-L1478), [README.md:218](README.md#L218)
`fallback-consume-start` adds the socket to `room.fallbackViewers` unconditionally; there is no check against `config.MAX_FALLBACK_VIEWERS` (README advertises "Max concurrent relay viewers: 50"). `MAX_FALLBACK_CHUNK_SIZE` ([config.js:312](config.js#L312)) similarly looks unused. Relay fan-out is the most bandwidth-/CPU-intensive path, so an unbounded relay audience is a real resource-exhaustion vector.
- **Fix:** enforce `MAX_FALLBACK_VIEWERS` in `fallback-consume-start` (reject with an error past the cap), and apply/remove `MAX_FALLBACK_CHUNK_SIZE`.

### H5 — Synchronous, unbounded `ffmpeg-error.log` write in the FFmpeg stderr hot path
[lib/ffmpegRelay.js:184-194](lib/ffmpegRelay.js#L184-L194)
```js
require('fs').appendFileSync('ffmpeg-error.log', `[FFmpeg:${this.roomCode}] ${line.trim()}\n`);
```
For every FFmpeg stderr line this does a **synchronous** append to a file in the **current working directory**, with no rotation/size cap. Problems: (1) blocks the event loop on a high-frequency path; (2) unbounded growth; (3) in the packaged exe the CWD may be read-only, so `appendFileSync` throws *inside* the `stderr 'data'` handler. There's already a structured startup-log facility ([lib/startupRuntime.js](lib/startupRuntime.js)) that should be reused.
- **Fix:** drop the per-line file write (console already logs it), or route it through the existing log dir with size limits and async/`try`-guarded writes.

### H6 — A machine-specific recovery script is committed and rewrites `server.js`
[extract.js](extract.js)
This 39-line script reads a **hardcoded absolute path** on the author's machine (`C:\Users\V\.gemini\antigravity\brain\…\overview.txt`) and **overwrites `server.js`** by reassembling it from log fragments. It's clearly one-off developer recovery cruft; shipping it is confusing and dangerous (a stray `node extract.js` would clobber `server.js`).
- **Fix:** delete `extract.js` (and confirm `restart.bat` / `update-nextra-exe.bat` are intended to ship; they read as personal helpers).

### H7 — Production dependency audit currently fails
[package-lock.json](package-lock.json), [package.json](package.json)
`npm audit --omit=dev` currently reports 5 moderate vulnerabilities in the production graph:
- `qs` denial of service, `GHSA-q8mj-m7cp-5q26`.
- `ws` uninitialized-memory disclosure, `GHSA-58qx-3vcg-4xpx`, pulled transitively through `engine.io`, `engine.io-client`, and `socket.io-adapter`.

This is the most clear-cut release blocker because it is runtime dependency risk and `npm audit fix` is offered as a clean fix.
- **Fix:** run `npm audit fix`, inspect the lockfile, then rerun lint, tests, build, and `npm audit --omit=dev`. Add the production audit check to release gating.

### H8 — OBS WebSocket password is persisted in `localStorage`
[src/HostView.jsx:289-308](src/HostView.jsx#L289-L308), [src/HostView.jsx:494](src/HostView.jsx#L494)
`loadStoredObsPassword` / `persistObsPassword` use `window.localStorage`, and the password is auto-persisted on change. The same file already uses `sessionStorage` for BYOK TURN secrets, so the OBS path is inconsistently weaker than the adjacent secret-handling precedent.

`localStorage` is long-lived and readable by any script that runs in the origin. That makes this a real browser-secret storage issue, especially while the CSP still requires `style-src 'unsafe-inline'`.
- **Fix:** default the OBS password to session-only or in-memory storage. If persistence is kept, make it explicit opt-in with a clear "remember password" control.

### H9 — Shared config loads ambient `.env`, including during tests
[config.js:2](config.js#L2), [package.json:12](package.json#L12)
`config.js` calls `require('dotenv').config()` at module top level. Any module or test that imports config now inherits whatever is in the developer's local `.env`; `node --test` is not hermetic by default.

This is a reproducibility and CI hazard. It can hide configuration bugs locally and make tests pass/fail based on machine state rather than test fixtures.
- **Fix:** load dotenv at application entry points (`server.js`, scripts that truly need it), not inside shared config. In tests, set explicit fixture env values and clear process-level mutations between cases.

---

## 4. 🟡 Medium-severity findings

### M1 — `Access-Control-Allow-Origin: *` on WHIP and WHEP routes
[lib/whipRoutes.js:26-31](lib/whipRoutes.js#L26-L31), [lib/whepRoutes.js:53-58](lib/whepRoutes.js#L53-L58)
WHIP is additionally protected by a per-room bearer token (good). WHEP is protected only by room-code secrecy + rate limit (5/min/IP) + global cap (30); `*` means any web page can drive WHEP session creation against a known/guessed code. 6-char codes from a 32-char alphabet make brute force impractical under the limiter, and `WHEP_ENABLED` defaults `false`, so this is contained — but `*` is broader than needed.
- **Fix:** scope CORS to known origins (LAN/share/tunnel) instead of `*`, at least for WHEP.

### M2 — O(rooms) work on every metrics emit
[lib/rooms.js:278-280](lib/rooms.js#L278-L280), [lib/socket.js:347-349](lib/socket.js#L347-L349)
`emitHostMetrics` calls `getAllRoomStats()` (which rebuilds stats for *all* rooms) and then `.find()`s the one room — on every `consume`/`produce`/`join`/viewer-count change. With `MAX_ACTIVE_ROOMS=100` this is tolerable but needlessly O(n); `getRoomStats(roomCode)` is O(1).
- **Fix:** use `findRoomByCode`/`getRoomStats(code)` in the single-room metric path.

### M3 — `helmet()` middleware re-instantiated on every request
[server.js:82-100](server.js#L82-L100)
The per-request CSP nonce is good, but rebuilding the entire helmet middleware factory per request is heavier than necessary.
- **Fix:** construct helmet once and inject only the nonce into the CSP header per request (helmet supports a function value for the directive).

### M4 — No CI; release gating is manual
[package.json:11-15](package.json#L11-L15)
`lint`, `test`, `oss:check`, and `release:prep` exist as scripts, but there is no `.github/workflows` (or equivalent) to enforce them, so the secret-scan/lint/test gates only run if a human remembers. For something intended for public GitHub Releases this is a real gap.
- **Fix:** add CI running `npm run release:prep` on PRs/tags.

### M5 — Test coverage gaps
[tests/](tests/)
Good unit coverage of pure modules (config, network, rooms, whip/whep SDP, fmp4Parser, ffmpegRelay, cloudflareTurn, obsOutputModel, watchPlaybackMode, socketTransportRecovery). **No** tests exercise the Socket.IO handlers in `lib/socket.js`, the Express WHIP/WHEP route handlers end-to-end, or any React component — i.e., the largest and most stateful files are the least tested.
- **Fix:** add handler-level tests for `registerSocketHandlers` (room lifecycle, rate limits, consume auth) and route tests for WHIP/WHEP.

### M6 — God-modules
[lib/socket.js](lib/socket.js) (~1849 lines), [src/HostView.jsx](src/HostView.jsx) (~1751), [src/WatchView.jsx](src/WatchView.jsx) (~1341)
`socket.js` mixes signaling, room lifecycle, FFmpeg/relay orchestration, metrics, and OS media-key control in one file; the two views carry dozens of `useState`/`useEffect`/refs each. This is the main maintainability/testability risk.
- **Fix:** extract the fallback-relay orchestration and metrics out of `socket.js`; split the views into hooks/subcomponents (e.g. an OBS-config panel, a relay-player hook).

### M7 — Single mediasoup worker = single-core ceiling
[lib/mediasoup.js:8-22](lib/mediasoup.js#L8-L22)
One worker/router serves all rooms, so all WebRTC work is pinned to one core while `MAX_ACTIVE_ROOMS` defaults to 100. Fine for the intended personal/small-group use, but the config defaults imply more headroom than a single worker provides.
- **Fix:** for scale, create a worker pool (one per core) and assign rooms across them; or lower `MAX_ACTIVE_ROOMS` to match reality.

### M8 — `package.json` metadata gaps + circular dependency smell
[package.json:1-4](package.json#L1-L4): no `author`, `license` (a `LICENSE` file is tracked but unreferenced), `repository`, or `engines`. Also `rooms.js` lazy-requires `whepRoutes` inside `destroyRoom` ([lib/rooms.js:231](lib/rooms.js#L231)) to break a `rooms ↔ whepRoutes` cycle, and `whipRoutes` top-level-requires `socket` ([lib/whipRoutes.js:11](lib/whipRoutes.js#L11)) — circular wiring that works but is fragile.
- **Fix:** fill metadata (incl. `engines.node`); invert the room/route dependencies (pass callbacks/`io` in rather than cross-requiring).

### M9 — Built assets miss compression and immutable caching
[server.js:737-746](server.js#L737-L746), [package.json](package.json)
The Express static handler only special-cases HTML as no-store. Hashed Vite assets under `dist/assets` do not get immutable cache headers, and there is no compression middleware/dependency. This is not a correctness bug, but it is a straightforward production performance win.
- **Fix:** serve Brotli/gzip through the reverse proxy or Express, keep HTML no-store, and set `Cache-Control: public, max-age=31536000, immutable` for hashed assets.

### M10 — Socket.IO is forced to websocket-only mode
[src/context/SocketContext.jsx:8-12](src/context/SocketContext.jsx#L8-L12), [server.js:1045-1059](server.js#L1045-L1059)
The client sets `transports: ['websocket']` and `upgrade: false`. This may be intentional for a self-hosted LAN/tunnel app, but it removes Socket.IO's polling fallback and makes proxy/captive-network compatibility stricter. The server also does not enable Socket.IO connection state recovery.
- **Fix:** document websocket-only as a deployment requirement, or reconsider allowing polling fallback / connection-state recovery. Add reconnect tests around producer creation/removal if the current approach stays.

---

## 5. ⚪ Low-severity & nits

- **Dead ternary**: both branches identical — `const probe = trimmed.startsWith('[') ? \`https://${trimmed}\` : \`https://${trimmed}\`;` ([server.js:115](server.js#L115)).
- **Default mismatch**: `HOST_UPLOAD_MBPS` defaults to `36` ([config.js:263](config.js#L263)) but `HostView` initializes the state to `20` ([src/HostView.jsx:358](src/HostView.jsx#L358)) before the server-config arrives — cosmetic flicker.
- **Duplicated buffer-eviction helpers** `trimBuffer` and `evictOldBuffer` are near-identical ([src/lib/fmp4RelayPlayer.js:130-141](src/lib/fmp4RelayPlayer.js#L130-L141) and [:267-278](src/lib/fmp4RelayPlayer.js#L267-L278)).
- **CSP `styleSrc 'unsafe-inline'`** ([server.js:88](server.js#L88)) is required only because the views use many inline `style={{…}}` props; moving those to CSS would let you drop it.
- **Broad `connectSrc 'ws:' 'wss:'`** ([server.js:90](server.js#L90)) — permissive; Socket.IO is same-origin, so this can be tightened.
- **Production mode ambiguity**: `npm start` does not set `NODE_ENV`, and `server.js` adds loopback Vite dev origins whenever `NODE_ENV !== 'production'` ([package.json:10](package.json#L10), [server.js:325-328](server.js#L325-L328)). This is low severity because the extra origins are loopback-only, but it is still worth making app mode explicit and logging the resolved mode/origins. Also note that `dev:server` passes `--dev`, but server mode is currently `NODE_ENV`-driven.
- **Vite dev host allowlist**: `.trycloudflare.com` is allowlisted for Vite dev/preview ([vite.config.mjs:24](vite.config.mjs#L24)). This is dev-only and should not be treated as a production blocker, but avoid exposing Vite dev/preview as a production surface.
- **Socket payload schemas**: current shallow validation is workable, but shared event schemas would be useful hardening as the Socket.IO contract grows.
- **Audit reports are ignored by Git**: `.gitignore` ignores `*.md` except for allowlisted files, so `OPUS.md` and `CODEX.md` stay untracked unless explicitly unignored or force-added.
- **`poc-mediasoup/`** is a proof-of-concept left in the tree (its `node_modules` is correctly untracked, but the POC itself is shipping cruft).
- **Browser-capture audio**: a silent oscillator track is injected so `MediaRecorder` always has audio for the relay path ([src/HostView.jsx:621-641](src/HostView.jsx#L621-L641)) — clever but worth a comment about why a muted track is added.

---

## 6. Architecture & transport notes (not defects)

- **Public WebRTC needs TURN or a reachable public UDP path.** Cloudflare quick tunnels carry HTTP/WS only; mediasoup ICE candidates announce `LAN_IP`/`PUBLIC_IP` ([lib/mediasoup.js:29-31](lib/mediasoup.js#L29-L31)). The app correctly routes tunnel viewers to relay (H.264) and *requires* BYOK TURN for AV1 — this is consistent across server, client, and README. Direct remote WebRTC needs `PUBLIC_IP` set + UDP 40000–40099 open, or TURN.
- **Two relay bootstraps coexist**: a cached `get-media-init` request and a live `media-init` event. The client tolerates the cached path being unavailable and waits for the live event ([src/WatchView.jsx:491-533](src/WatchView.jsx#L491-L533)), which is good resilience. The server-side handlers (`get-media-init` [lib/socket.js:1620](lib/socket.js#L1620), host→relay `media-chunk`/`media-init` forwarding [lib/socket.js:1569-1618](lib/socket.js#L1569-L1618)) are present and correctly gated via `findRoomByHost` and relay-audience membership.
- **Host disconnect uses a reconnect grace window**: a dropped host keeps the room (and its mediasoup state) alive for `HOST_RECONNECT_GRACE_MS` (5 min) so it can be reclaimed via `reclaim-host` + `hostToken` ([lib/socket.js:1719-1752](lib/socket.js#L1719-L1752)). Reasonable, but note that an abandoned host pins a room + transports for 5 minutes.

---

## 7. Suggested remediation order

1. **H7** fix the production dependency audit (`npm audit fix`, then rerun lint/tests/build/audit).
2. **H8 / H9** stop default OBS-password persistence in `localStorage`; move dotenv loading out of shared config.
3. **H6** delete `extract.js` (and confirm the `.bat` helpers) — trivial, removes a footgun.
4. **H2** fix the fresh-clone run path + README labels — biggest first-contact UX issue.
5. **H4 / H5** enforce `MAX_FALLBACK_VIEWERS`/handle `MAX_FALLBACK_CHUNK_SIZE`; remove the synchronous `ffmpeg-error.log` write — resource-safety on the relay path.
6. **H3** real worker-restart or honest log + documented supervisor expectation.
7. **H1 / M1 / M10** document and tighten the network surface (media interface exposure; WHEP CORS; websocket-only deployment expectation).
8. **M4 / M5** add CI running `release:prep` plus `npm audit --omit=dev`; add handler/route tests for `socket.js` and WHIP/WHEP.
9. **M2 / M3 / M6 / M7 / M9** the perf + maintainability cleanups (O(1) metrics, single helmet instance, module/view splits, worker pool, static asset caching/compression) as ongoing work.
10. **Low/nits** as you touch the surrounding code.

---

*Report generated by Opus against the working tree at commit `a7b4d9a` on `main`. Line references are to that tree.*
