# Consolidated finding register

This register deduplicates both audits. Priority is relative to the supported
personal, single-node product—not a hosted multi-tenant or HA service.

## Release conditions

| ID | Priority | Finding | Exit condition | Implementation packet |
| --- | --- | --- | --- | --- |
| CF-01 | P0 | Invalid lockfile; local dependencies do not match the manifest; audit and packaging evaluation cannot run | Reviewed lockfile, clean Node 20 `npm ci`, exact dependency inventory, and all gates pass on Linux and Windows | `01-release-reproducibility.md` |
| CF-02 | P0 | `release:prep` tests an ignored pre-existing `dist/` before build | Clean checkout passes; integration test owns its prerequisite; missing-build behavior is explicitly tested | `02-clean-build-and-readiness.md` |
| CF-03 | P0 | A delayed public browser-relay viewer waits for a live recorder generation that is never emitted | Deterministic delayed-viewer E2E receives decoded frames and cleans up | `03-public-relay-generation.md` |
| CF-04 | P0 for public sharing | Any known public-origin client can create host rooms and fill server capacity | Server-side local/operator capability is checked before allocation; abuse tests pass | `04-operator-boundary-and-whip.md` |
| CF-05 | P0 for recovery claims | Restart messaging promises continuity impossible with in-memory rooms; Host stays stale after failed reclaim | Host/viewer enter a truthful terminal state and Host can create a new room; tests cover server replacement and worker death | `05-restart-semantics.md` |
| CF-06 | P0 for source/service deployment | Readiness can be green without the SPA or an enabled required component | Profile-aware readiness and integration tests match deployment docs | `02-clean-build-and-readiness.md` |
| CF-07 | P0 for public release | Signing, legal, clean-machine, target-host, long-churn, topology, browser, mobile, and accessibility evidence is open | Named owners retain results for the exact artifact and explicitly narrow unsupported scope | `10-release-evidence.md` |

## High-value correctness and security work

| ID | Priority | Finding | Disposition | Implementation packet |
| --- | --- | --- | --- | --- |
| CF-08 | P1/conditional P0 | Publicly mounted WHIP has no per-IP/global admission limit | Rate-limit before expensive work; disable public mount unless declared | `04-operator-boundary-and-whip.md` |
| CF-09 | P1 conditional | Every RFC1918 client can read sensitive metrics and mint paid TURN credentials | Separate loopback operator trust from optional token/CIDR LAN access | `04-operator-boundary-and-whip.md` |
| CF-10 | P1 conditional | Browser/OBS relay media is plaintext on default non-loopback HTTP LAN links | Document precisely; gate insecure relay if untrusted LAN is supported | `09-security-and-operations.md` |
| CF-11 | P1 | Socket.IO viewers get the 8 Mbps host initial estimate | Pass viewer purpose and contract-test 600 kbps selection | `06-contained-backend-fixes.md` |
| CF-12 | P1 | Passphrase room creation uses synchronous scrypt | Async hash behind atomic capacity reservation; concurrency and latency tests | `06-contained-backend-fixes.md` |
| CF-13 | P1 | AV1 WebRTC support is inferred from MP4/MSE support | Inspect WebRTC/mediasoup receive RTP capabilities after device load | `07-media-capability-and-sync.md` |
| CF-14 | P2 | OBS AV1 is hard-disabled by a WebGL renderer heuristic | Treat WebGL as a hint and let OBS encoder verification be authoritative | `07-media-capability-and-sync.md` |
| CF-15 | P1 decision for OBS fallback | 1500 ms audio-offset default contradicts keyframe-anchor comments | Measure real OBS sessions, choose/document one contract, then pin with tests | `07-media-capability-and-sync.md` |
| CF-16 | P1 UX correctness | False auto-start copy, ref-backed room label, and nonexistent 720p advice | Use truthful copy/state/advice with focused tests | `08-ui-accessibility-and-support.md` |
| CF-17 | P1 for accessibility claim | Room-code input lacks a name; routes lack title/focus semantics; frame-rate buttons lack selected state | Semantic fixes plus route/form/toggle accessibility tests | `08-ui-accessibility-and-support.md` |
| CF-18 | P1 evidence / P2 code | Safari, iOS, mobile, relay, and role support claims exceed evidence | Test matrix, capability messaging, and explicitly narrowed support docs | `08-ui-accessibility-and-support.md` |
| CF-19 | P1 evidence | No late-relay test; narrow browser/coverage/packaged-media/capacity evidence | Risk-based tests and retained target-host results; do not chase a cosmetic global coverage number | `10-release-evidence.md` |
| CF-20 | P2 hardening | Ordinary bearer comparison and broad WebSocket CSP | Central constant-time helper and least-privilege tested CSP | `06-contained-backend-fixes.md` |

## Operational, polish, and maintainability work

| ID | Priority | Finding | Disposition | Implementation packet |
| --- | --- | --- | --- | --- |
| CF-21 | P2 | Unswept maps/sets, hidden-tab polling, duplicated event-loop/room metrics work | Small cleanup changes with leak/polling tests; profile before redesign | `09-security-and-operations.md` |
| CF-22 | P2 | Missing alert/rotation guidance and no notice for local quick-tunnel TLS bypass | Documentation/startup diagnostics only | `09-security-and-operations.md` |
| CF-23 | P3 | Host, Watch, and socket lifecycle ownership is monolithic and duplicated | Incremental extraction behind transition tests after blockers | `11-maintainability-and-polish.md` |
| CF-24 | P3 | Passphrase tone/focus, raw errors, fullscreen state, duplicate mobile CSS, status-token copy, and unverified live-region behavior | Batch only after core semantics; validate live-region behavior before changing it | `11-maintainability-and-polish.md` |
| CF-25 | P3/triggered | setup-node drift, archived packager, release publication/rollback gaps | Align CI now; retain caxa until trigger; publish signed artifacts with checksum/SBOM/rollback | `10-release-evidence.md` |

## Explicitly closed or trigger-gated

- Do not implement the historical six lint fixes until lint is rerun against the
  repaired dependency graph.
- Do not add `@nut-tree-fork/nut-js`; supported defaults are Windows native media
  keys and Linux `xdotool`, and the README intentionally excludes nut-js.
- Do not treat viewer passphrase reconnect as a room-confusion vulnerability.
- Do not rewrite the StrictMode unmount timer without a reproducible failing transition.
- Do not harden capability-URL teardown in a way that breaks WHIP/WHEP clients;
  first keep capability URLs out of logs.
- Do not migrate caxa, add a database/Redis, introduce multiple replicas, or
  build PWA/recording/chat/E2EE work as part of this remediation.
