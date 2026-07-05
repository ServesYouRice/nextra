# Production Readiness — Deployment, Observability, Ops & Overall Verdict

This file covers deployment/ops/observability gaps and then gives the **cross-cutting go/no-go verdict** and a **recommended fix order** spanning every audit file.

Severity legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low.

---

## Deployment & ops findings

### D-1 🟠 No process supervision guidance; main-process crash is unrecovered
- **Location:** `server.js` (worker-death auto-restart at `:1049` covers only the mediasoup subprocess; nothing restarts the Node process itself).
- The mediasoup worker-death handler cleverly relaunches on worker crash, but a crash of the **main process** (e.g. an unhandled rejection, see `logical-issues.md` L-2) is terminal. There is no documented systemd unit, pm2 config, or Windows service wrapper. The packaged exe relies on the user re-launching.
- **Fix:** Ship/ document a supervisor (systemd `Restart=always`, or pm2, or a Windows service) and add the top-level rejection/exception handlers (L-2). For the exe, consider a lightweight watchdog.

### D-2 🟠 No real health/readiness endpoint
- **Location:** the closest thing is `/api/config` (used as a liveness probe by `probeExistingNextraInstance`, `server.js:403-454`) and `/api/metrics` (auth-gated).
- There is no dedicated `/healthz` / `/readyz` returning a simple 200 with worker/relay status for load balancers, uptime monitors, or container orchestration. `/api/config` leaks config (S-1) and isn't a semantic health check.
- **Fix:** Add an unauthenticated, minimal `/healthz` (process up, worker alive) and a `/readyz` (router created, ports bound). Keep it free of sensitive fields.

### D-3 🟡 Logging is `console.*` only; no levels, rotation, or shipping in server mode
- **Location:** hundreds of `console.log/warn/error` across `server.js` and `lib/*`; the packaged path adds file logging + rotation via `lib/startupRuntime.js` (pruning to 10 files, `:40-59`) but that only runs for the **exe** (`NEXTRA_PACKAGED`).
- Running via `npm start` gives unstructured stdout with very chatty WHIP debug lines (`whipRoutes.js` logs full DTLS params, SDP fingerprints, codec lists on every ingest). No level control, no JSON, no correlation ids.
- **Fix:** Introduce leveled/structured logging with a `LOG_LEVEL` (see `nice-to-haves.md` N-14); default WHIP verbose logging off. Extend the startupRuntime file-logging behavior to the non-packaged path optionally.

### D-4 🟡 No metrics export for machine consumption
- **Location:** `/api/metrics` (`server.js:693`) is JSON for the human Status page.
- Operators running Nextra as a service have no Prometheus/OpenMetrics endpoint. The counters already exist (`runtimeMetrics`, `roomRelayMetrics`) — exposing them in Prometheus format is low effort.
- **Fix:** Add an optional `/metrics` (token-gated) in Prometheus text format.

### D-5 🟡 Packaging & update pipeline is Windows-only and fragile
- **Location:** `scripts/package-app.js` (caxa), `update-nextra-exe.bat`, `restart.bat`; caxa is effectively unmaintained (N-20).
- No macOS/Linux binary; the update story is "rebuild the exe and replace it." `restart.bat` kills whatever is on port 3000 (`taskkill /F`) which is blunt (could kill an unrelated process on that port).
- **Fix:** See N-20/N-21 — evaluate Node SEA, and provide a Docker path for server deployments. Make `restart.bat` verify it's killing Nextra (match the process, not just the port).

### D-6 🟡 No backup / rollback / config-management story
- **Location:** state is in-memory (no DB — appropriate). Config is `.env` + env vars; the self-signed cert is cached under `./certs` (gitignored).
- There is nothing to back up for room state (correct — it's ephemeral), but there is also no documented rollback for a bad deploy beyond "keep the previous exe." The stale-`indexHtmlTemplate` issue (`logical-issues.md` L-7) means in-place rebuilds need a restart.
- **Fix:** Document that state is ephemeral by design (so operators don't expect persistence), and give a simple deploy/rollback recipe (keep the prior `dist/` + exe; restart after rebuild). If TLS certs matter, note that deleting `./certs` regenerates them.

### D-7 🟢 CI is solid but single-platform and no coverage/e2e gate
- **Location:** `.github/workflows/ci.yml` runs `release:prep` (lint + `node --test` + build + `oss:check` + `npm audit --omit=dev`) on `ubuntu-latest`, Node 20.
- Good: linting, tests, build, an open-source secrets/preflight check (`scripts/opensource-preflight.js` scans tracked files for keys/PEM blocks — nice), and a production `npm audit`. Gaps: no Windows job (the product ships a Windows exe), no coverage gate (`testing-gaps.md` T-6), no e2e (T-4), and `npm audit` failing (`audit:prod`) will hard-fail CI on any advisory, which can block unrelated PRs.
- **Fix:** Add a Windows build job that at least runs `package-app.js`; consider `npm audit` as non-blocking (report) or pinned. Add coverage reporting.

### D-8 🟢 Secrets hygiene is good — acknowledge
- `.gitignore` excludes `.env*`, `certs/`, `*.key/*.crt/*.pem`, the exe, and cloudflared binaries; `git ls-files` shows only `.env.example` tracked (no secrets committed). `opensource-preflight.js` actively scans for accidental key/token commits. This is above-average hygiene for a project of this size — keep it.

---

## Overall production-readiness verdict

**Nextra is a well-engineered application that is close to production-ready for its intended use case** (a user runs it on their own machine and shares a stream over LAN or an opt-in tunnel). The code shows real care: reconnect/recovery state machines, keyframe-anchored A/V sync, bounded backpressure everywhere media flows, restart budgets, a crash-loop-guarded worker auto-restart, CSPRNG room codes, nonce-locked script CSP, and clean secret hygiene.

It is **not yet ready for an unattended, internet-exposed, multi-room deployment** without addressing a small, concentrated set of issues — none of which require an architectural rewrite.

### Go / No-Go by deployment posture

| Posture | Verdict |
|---|---|
| **LAN-only, host's own machine, tunnel off** | ✅ Ready after UI polish (U-1, U-2) and the L-1 relay race fix. |
| **Public tunnel, casual sharing** | ⚠️ Fix L-1, L-3/S-4 (rate-limit identity), S-1 (TURN creds), L-2 (rejection guard) first. |
| **Unattended service, many rooms** | ❌ Also needs P-1 (worker pool), P-2 (off-thread media), D-1/D-2 (supervision + health), and the L-5 client leak fix. |

---

## Recommended fix order (cross-cutting, all files)

Ranked by (risk × likelihood) ÷ effort. IDs reference the sibling audit files.

### Tier 0 — Do before any public exposure
1. **L-1** 🔴 Fix the fallback-relay start **race** (claim the slot synchronously). *Corrupts OBS relay + leaks resources under normal timing.*
2. **S-1** 🔴 Stop `/api/config` from handing out 24h HMAC **TURN credentials**; shorten TTL and issue per-room. *Credential/bandwidth theft.*
3. **L-2** 🟠 Add top-level `unhandledRejection` / `uncaughtException` handlers (+ supervisor). *One rejection kills all rooms.*
4. **L-3 / S-4** 🟠 Fix the shared `'public-share-proxy'` **rate-limit identity** for tunnel viewers. *Self-DoS + defeated abuse controls.*

### Tier 1 — Before a real launch
5. **L-5** 🟠 Fix the fMP4 player **listener/URL leak** across generations.
6. **L-4 / U-2** 🟠 Make `join-room` **idempotent** server-side + add Join button loading state.
7. **U-1** 🟠 Fix the visible `Waiting for OBS…` **literal**. *(One line — do it immediately; it's only low in this list because it's cosmetic.)*
8. **S-6 / N-8** 🟡 Self-host fonts, tighten CSP.
9. **D-2** 🟡 Add `/healthz` / `/readyz`.
10. **U-3, U-4, U-5, U-8** 🟡 Host live-settings clarity, Stop-Sharing confirm, Modal focus trap, notification/error-clear consistency.

### Tier 2 — Hardening & scale
11. **P-1** 🟠 mediasoup **worker pool** (and lower default `MAX_ACTIVE_ROOMS` until then).
12. **P-2** 🟠 Move relay media processing **off the main thread**.
13. **T-2 / T-1** 🟠 Integration tests for signaling (lock down L-1) + `/api/config` credential-leak regression test.
14. **L-6, L-7, L-8, L-9** 🟡 WHEP timer clear, index.html cache, `/api/*` 404, recv-transport race.
15. **D-1, D-3, D-4, D-5** 🟡 Supervision docs, structured logging, metrics export, packaging modernization.

### Tier 3 — Product & DX polish
16. Everything in `nice-to-haves.md` (room passphrase, host-session persistence, component/module refactors, Docker, roadmap).

---

## One-line summary

Solid, thoughtfully-built self-hosted screen-sharing app; **ship it for LAN/personal use after a handful of Tier-0/Tier-1 fixes**, and treat the worker-pool + off-thread-media + integration-test work (Tier 2) as the gate for running it as an exposed, multi-room service.
