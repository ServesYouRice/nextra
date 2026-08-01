# Production Readiness

Go/no-go assessment and ordered fix plan. Cross-references: L-* = `logical-issues.md`, U-* = `ui-issues.md`, S-* = `security-issues.md`, P-* = `performance-issues.md`, T-* = `testing-gaps.md`.

## Verdict

**Not releasable today — but for reasons that are hours, not weeks, of work.** The architecture, hardening, and recovery machinery are genuinely production-grade (the codebase has clearly absorbed prior audit rounds). What is broken is the delivery pipeline itself: a corrupted lockfile, a red lint gate, and a test-ordering defect mean **the repo's own `release:prep` gate cannot pass from a clean checkout**, so no trustworthy artifact can currently be produced. Beyond that, the externally-blocked items in `REMAINING-WORK.md` (signing, target-host evidence, legal review) still stand.

## Blockers (must fix, in order)

| # | Finding | Effort | Verification |
|---|---|---|---|
| 1 | **L-1** Corrupted `package-lock.json` | ~30 min | `npm ci` succeeds on a clean clone |
| 2 | **L-2** 6 lint errors (HostView/WatchView/StatusView) | ~1–2 h | `npm run lint` exits 0 |
| 3 | **L-3** `release:prep` runs tests before build; `serverIntegration` needs `dist/` | ~15 min | `npm run release:prep` passes on a clean clone |
| 4 | Branch-protect `main` on green CI (L-1 was merged red) | ~10 min | settings |
| 5 | **L-4** Decide 1500 ms vs 0 ms `FALLBACK_AUDIO_OFFSET_MS` (blocker only if OBS fallback is in the launch surface) | decision + OBS session | live OBS lip-sync check + T-3 test |
| 6 | `REMAINING-WORK.md` §1–2: signing secrets + tagged release on clean Windows; target-host benchmark & churn evidence; distribution legal review | external | as documented there |

## Deployment risks (non-blocking, know before you ship)

1. **Ephemeral state is a feature, not a bug — but restarts kill all rooms.** The supervised single-replica contract is documented; the host-side UX gap (L-6/U-2) makes restarts worse than they need to be. Fix L-6 before relying on the auto-restart story.
2. **`dist/` must exist before `npm start`** — the 503 "build required" page handles it gracefully, and packaged builds embed it; only source deployments can hit it. `docs/service-deployment.md` should state `npm run build` as a hard prerequisite.
3. **FFmpeg is a runtime dependency discovered at startup** — absent FFmpeg silently degrades OBS rooms to WebRTC-only (logged, surfaced in `/readyz`). Ops should alert on `readyz.fallbackRelay.nvencProbe`/WHIP status.
4. **cloudflared quick tunnels are best-effort** — ephemeral URLs, no SLA; the supervisor restarts with backoff, and each restart *changes the public URL* (all previously shared links die). Named tunnel + `SHARE_BASE_URL` is the production path; say so prominently in host-facing docs, not just `.env.example`.
5. **Single mediasoup worker = single CPU core for all media routing.** Documented as fine for the 10×10 envelope; the trigger conditions for room-affine workers are already written down (`REMAINING-WORK.md` §2). Don't scale limits without that evidence.
6. **Windows console-close relies on SIGHUP/SIGBREAK handlers** — verified handled (`server.js:1500-1501`) including suppressing worker-death auto-restart during teardown. Good.
7. **RAM sizing:** see P-5 — provision ≥ 4 GiB for the documented limits.

## Health/observability checklist (mostly already done)

- [x] `/healthz`, `/readyz` (readiness includes worker + socket server + WHIP status)
- [x] `/api/metrics` (local/token), OpenMetrics opt-in with mandatory token
- [x] Event-loop delay, active-resource, per-room relay counters
- [x] Request-ID log context (`x-request-id` → AsyncLocalStorage), JSON log format opt-in
- [ ] Alerting recipes (what to page on) — one doc page: readyz≠200, `fallbackRestartCount` climbing, event-loop p95 > threshold, tunnel status=error
- [ ] Log rotation guidance for the systemd/NSSM units in `docs/service-deployment.md`

## Suggested fix order (everything, one list)

1. L-1 lockfile → 2. L-2 lint → 3. L-3 release:prep order → 4. branch protection → 5. L-4 audio-offset decision (+T-3 test) → 6. L-6/U-2 host restart UX → 7. U-1/L-8 viewer auto-start-or-copy → 8. L-5 viewer transport purpose → 9. U-5 ref-in-render → 10. U-6 mobile/Safari messaging → 11. L-7 async scrypt → 12. S-2 CSP connect-src → 13. L-12/S-1 timing-safe tokens → 14. U-3/U-4/U-10 UX batch → 15. L-11 map sweeps → 16. T-4/T-5 client-logic extraction + coverage floors → 17. L-13 dedup batch → 18. remaining polish (U-7/U-8/U-9/U-11, P-4, T-7).

Items 1–4 restore the pipeline; 5–7 close the worst user-visible gaps; the rest are safe to batch into normal development.
