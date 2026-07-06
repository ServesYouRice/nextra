# Nextra — Production-Readiness Audit Plan

**Audited commit branch:** `claude/production-readiness-audit-m8906l`
**Date:** 2026-07-04
**Auditor role:** Senior engineer / product-minded reviewer / production-readiness auditor
**Scope:** Inspection, reasoning, and recommendations only. No production code was modified. Findings live entirely in `audits-fable/`.

---

## 1. What Nextra is

Nextra is a **self-hosted, low-latency screen-sharing / live-streaming application**. It is a single Node process that a host runs on their own machine; viewers connect with a room code or a shared link. There is no multi-tenant backend, no database, and no user accounts — all state is in-memory and per-process. It is distributed both as source and as a packaged Windows `Nextra.exe`.

### Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 20.19 |
| HTTP / signaling | Express 5, Socket.IO 4 |
| Media SFU | mediasoup 3 (single worker + single router) |
| OBS ingest | WHIP (WebRTC-HTTP Ingestion) over a **plain-HTTP** side server (default port 3001) |
| External egress | WHEP (WebRTC-HTTP Egress) — optional, disabled by default |
| Relay fallback | FFmpeg → fMP4 (H.264 only), streamed over Socket.IO to an MSE player; plus a legacy WebM/MediaRecorder relay for browser-capture rooms |
| Public sharing | cloudflared "quick tunnel" (spawned child process) |
| TLS | Optional self-signed cert (`selfsigned`), off by default |
| TURN | Optional global TURN, room-scoped BYOK TURN for AV1, optional Cloudflare TURN autofill |
| Client | React 19, Vite 7, hash-based routing, `mediasoup-client`, native `MediaSource` / `MediaRecorder` |
| OBS control | Browser `WebSocket` to obs-websocket v5 (`ws://127.0.0.1:4455`) |
| Packaging | `caxa` → `Nextra.exe`; `rcedit` for icon; Windows `.bat` helpers |
| CI | GitHub Actions: `lint` + `node --test` + `build` + open-source preflight + `npm audit` |

### Key source map

```
server.js              Entry point: Express app, HTTPS/HTTP, Socket.IO wiring, /api routes,
                       rate-limit tracker, tunnel + TURN startup, worker-death auto-restart.
config.js              All configuration + env parsing; ICE/TURN builder.
lib/
  socket.js  (2137 L)  Socket.IO signaling: rooms, transports, produce/consume, relay,
                       OBS fallback relay orchestration, remote media toggle.
  rooms.js             In-memory room registry + lifecycle + stale cleanup.
  mediasoup.js         Worker/router/WebRtcServer/transport creation.
  whip.js / whipRoutes.js   OBS WHIP ingest (SDP parse, producer creation, sprop capture).
  whep.js / whepRoutes.js   External WHEP egress sessions.
  ffmpegRelay.js       FFmpeg spawn/restart wrapper + fMP4 parser events.
  fmp4Parser.js, h264Depacketizer.js, h264Sprop.js   Media byte-level helpers.
  tunnel.js            cloudflared discovery + spawn.
  cloudflareTurn.js    Cloudflare TURN credential fetch.
  https.js             Self-signed cert generate/cache.
  network.js           IP normalization + forwarded-header trust.
  portResolver.js      Free-port finder for WHIP HTTP server.
  startupRuntime.js    Packaged-exe logging + crash dialog (Windows).
src/
  App.jsx              Hash router + landing + nav + footer + 404.
  HostView.jsx (1762)  Host UI: browser capture + OBS config + relay recorder + BYOK TURN modal.
  WatchView.jsx (1337) Viewer UI: mediasoup playback + WebM relay + fMP4 fallback + recovery.
  StatusView.jsx       Metrics dashboard (polls /api/metrics).
  HowTo/Privacy/Copyright views.
  lib/                 mediasoupClient, fmp4RelayPlayer, obsWebSocket, obsOutputModel,
                       watchPlaybackMode.
  components/          BrandLogo, CopyField, ErrorBoundary, Modal, StatusPill.
  context/SocketContext.jsx
```

---

## 2. Core user flows (the things that must work in production)

1. **Browser-capture host** — Host page → pick resolution/fps → *Start Sharing* → `getDisplayMedia` → mediasoup send-transport → produce video/audio → share room code / link. Optional WebM relay recorder prewarms when a public tunnel is active without TURN.
2. **OBS / WHIP host** — Host enables OBS mode → Nextra creates room → auto-configures OBS over WebSocket → OBS pushes WHIP to the plain-HTTP side server → server creates producers → prewarms the FFmpeg fMP4 relay.
3. **WebRTC viewer** — `#watch/CODE` → join-room → load device → create recv-transport → consume producers → play. Tunnel viewers fail WebRTC fast and fall to relay.
4. **Relay / fMP4 viewer** — For H.264 OBS rooms or tunnel-only viewers: MSE player consumes fMP4 fragments (or WebM chunks for browser rooms) over Socket.IO.
5. **WHEP external player** — Optional. GStreamer/other WHEP clients play `/whep/watch/CODE`.
6. **Public tunnel sharing** — cloudflared quick tunnel gives a `*.trycloudflare.com` link.
7. **Host reconnect / room reclaim** — Host socket drops → grace timer → `reclaim-host` with host token restores the room.
8. **Status dashboard** — `/#status` polls `/api/metrics` (local-only unless token configured).

---

## 3. Audit methodology

- Full read of `server.js`, `config.js`, and every file in `lib/`.
- Full read of `App.jsx`, `HostView.jsx`, `WatchView.jsx`, `StatusView.jsx`, client `lib/` and `components/`, `SocketContext`.
- Review of tests (`tests/`, 15 files), CI (`.github/workflows/ci.yml`), packaging scripts, `.gitignore`, `.env.example`, `README.md`, `index.html`, `vite.config.mjs`.
- Traced the five media flows above end-to-end across client ↔ signaling ↔ media.
- Findings are grounded in specific `file:line` references and split by concern into the sibling audit files.

## 4. Severity rubric

| Severity | Meaning |
|---|---|
| **Critical** | Data loss, security breach, or crash that will occur in normal production use. Fix before launch. |
| **High** | Significant malfunction, security weakness, or UX breakage under realistic conditions. Strongly recommended before launch. |
| **Medium** | Real problem with a workaround or limited blast radius; schedule soon after launch. |
| **Low** | Minor correctness/polish issue; low urgency. |
| **Nice-to-have** | Not a defect; an improvement that increases trust, completeness, or maintainability. |

"**Blocker**" is called out per finding independently of severity — a High item may or may not be a launch blocker depending on the deployment posture (LAN-only vs. public tunnel).

## 5. Deliverables in this folder

| File | Contents |
|---|---|
| `00-audit-plan.md` | This document. |
| `logical-issues.md` | Logic, async, races, leaks, state bugs + **Production Blockers**. |
| `ui-issues.md` | UI/UX, a11y, responsive, states, forms + **Recommended UI Priorities Before Production**. |
| `security-issues.md` | Auth, credential exposure, origin/IP trust, spawn surface, CSP/TLS. |
| `performance-issues.md` | SFU scaling, relay pipeline, client render costs. |
| `testing-gaps.md` | Coverage map + missing tests. |
| `nice-to-haves.md` | High-impact / polish / DX / architecture / roadmap. |
| `production-readiness.md` | Deployment/ops/observability + overall go/no-go + **recommended fix order** across all files. |

## 6. Headline assessment (detail in `production-readiness.md`)

Nextra is a genuinely capable, thoughtfully-built app: it already handles many hard edge cases (reconnect recovery, keyframe anchoring, backpressure caps, restart budgets, rate limiting, worker-death auto-restart). It is **close to production-ready for its intended "run it on your own PC and share a link" use case.**

The blockers are concentrated in a few places: a fallback-relay start **race** that can spawn duplicate FFmpeg pipelines, the **shared rate-limit bucket** for all tunnel viewers, **unauthenticated TURN-credential exposure** via `/api/config`, a **client MSE listener/URL leak** across relay generations, and the **absence of a top-level unhandled-rejection guard** on the non-packaged server path. None require an architectural rewrite.
