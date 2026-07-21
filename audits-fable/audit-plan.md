# Nextra — Production-Readiness Audit Plan

Audit date: 2026-07-21 · Auditor: Claude (Fable) · Branch: `claude/production-readiness-audit-muvkpo` (from `main` @ `500e04b`)

This is an **audit only**. No application code was modified. The only working-tree changes are the files in `audits-fable/` (plus a local, uncommitted `npm install` / `vite build` performed to verify the toolchain — see "Verification performed" below).

---

## 1. Stack identification

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 20.19 (CommonJS server, ESM client) |
| HTTP server | Express 5 + Helmet (nonce-based CSP) + compression, optional self-signed HTTPS (`lib/https.js`) |
| Signaling | Socket.IO 4 (`lib/socket.js`, 2,300 lines — room lifecycle, WebRTC signaling, relay fanout) |
| Media SFU | mediasoup 3 (single worker + router, shared WebRtcServer, `lib/mediasoup.js`) |
| OBS ingest | WHIP over a dedicated loopback HTTP listener on :3001 (`lib/whipRoutes.js`, `lib/whip.js`) |
| Standards egress | WHEP (opt-in, `lib/whepRoutes.js`, `lib/whep.js`) |
| Fallback relay | FFmpeg child process (NVENC or libx264) fed depacketized H.264 + Ogg/Opus over pipes, emitting fMP4 (`lib/ffmpegRelay.js`, `lib/h264Depacketizer.js`, `lib/oggOpusMuxer.js`, `lib/fmp4Parser.js`) |
| Browser relay | Host `MediaRecorder` WebM chunks over Socket.IO → viewer MSE (`WatchView` relay path) |
| Public sharing | Cloudflare Quick Tunnel / named tunnel via `cloudflared` child process (`lib/tunnel.js`, `lib/tunnelSupervisor.js`) |
| TURN | BYOK TURN (static or HMAC ephemeral), optional Cloudflare TURN credential mint (`lib/cloudflareTurn.js`) |
| Frontend | React 19 + Vite 7 SPA, hash routing, lazy-loaded views (`src/App.jsx`, `HostView`, `WatchView`, `StatusView`, `HowToView`, legal pages) |
| State | 100 % in-memory (`lib/sessionRegistry.js`); no database, no accounts, ephemeral rooms by design |
| Packaging | `caxa` single-file Windows EXE + Authenticode signing workflow (`scripts/package-app.js`, `.github/workflows/release.yml`) |
| Tests | `node --test` unit/integration suites (141 tests), Playwright browser media gate, churn/benchmark harnesses |
| CI | GitHub Actions: `ci.yml` (verify = `release:prep`, browser-media, windows-package), `release.yml` (signed tag release) |

No backend database, no auth system (room codes + optional scrypt passphrases + host bearer tokens), no third-party analytics.

## 2. Core user flows

1. **Browser host**: `#host` → Start Sharing → `getDisplayMedia` → mediasoup producers → room code / local link / public tunnel link / QR → live quality switching → stop (with confirm when viewers present) → optional reload-recovery reclaim.
2. **OBS host**: `#host` + "Use OBS" → room created → OBS auto-configured over obs-websocket (or manual WHIP URL + bearer token) → WHIP ingest → prewarmed FFmpeg fMP4 fallback relay for tunnel viewers; optional AV1 + BYOK TURN mode.
3. **Viewer**: `#watch/CODE` or code entry (+ optional passphrase) → join → WebRTC playback, with automatic fallbacks: WebM relay (browser rooms), fMP4 relay (OBS rooms), tunnel fail-fast, reconnect/rejoin recovery, optional viewer→host media play/pause.
4. **External player**: WHEP URL for GStreamer/ffplay-class players (opt-in).
5. **Operator**: `#status` dashboard (local-only by default), `/api/metrics`, opt-in `/metrics` OpenMetrics with token, `/healthz` + `/readyz`, systemd/NSSM deployment per `docs/service-deployment.md`, packaged EXE auto-tunnel.

## 3. Audit method

1. Full read of `server.js`, `config.js`, all of `lib/` (socket, rooms, whip/whep routes, ffmpegRelay, pipeline, tunnel, registry, mediasoup, network, https, logger), all of `src/` (views, hooks, contexts, components, media libs), CI workflows, `.env.example`, packaging scripts, and docs.
2. **Toolchain verification on a clean checkout** (this is where the highest-severity findings came from):
   - `npm ci` — **fails**: committed `package-lock.json` is invalid JSON.
   - `npm install` (lockfile untouched) — succeeds.
   - `npm run lint` — **fails**: 6 errors.
   - `npm run typecheck` — passes.
   - `npm test` — 139/141 pass; 1 fail (`serverIntegration`) traced to a test-vs-build ordering defect; passes after `npm run build`.
   - `npm run build` — passes (3.6 s).
3. Trace of race conditions, resource lifecycles, rate limits, trust boundaries (forwarded headers, origins, tokens), and client/server state machines.
4. Findings triaged into the audit files below, each with severity, location, impact, fix, and blocker status.

## 4. Audit deliverables

| File | Scope |
|---|---|
| `ui-issues.md` | UI/UX, navigation, states, accessibility, responsive behavior + prioritized UI fix list |
| `logical-issues.md` | Logic, async/races, error handling, resource lifecycles + **Production Blockers** section |
| `security-issues.md` | Trust boundaries, tokens, rate limiting, CSP, secrets handling |
| `performance-issues.md` | Event-loop, fanout, memory ceilings, client rendering |
| `testing-gaps.md` | CI health, coverage gaps, environment-dependent tests |
| `production-readiness.md` | Go/no-go checklist, deployment risks, ordered fix plan |
| `nice-to-haves.md` | High-impact extras, polish, DX, architecture, roadmap |

## 5. Context: prior remediation

The repo has already absorbed a large audit-remediation effort (PR #19) and documents remaining externally-blocked work in `REMAINING-WORK.md` (signing credentials, target-host load evidence, real-topology matrix, legal review). This audit deliberately re-verified rather than trusted those claims; where `REMAINING-WORK.md` is accurate it is cross-referenced instead of duplicated. The headline result of this audit is that **the repository's own quality gate (`release:prep`) does not currently pass from a clean checkout** — details in `logical-issues.md` and `testing-gaps.md`.
