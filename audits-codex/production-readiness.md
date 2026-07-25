# Production Readiness Assessment

## Verdict

**Not ready for production release.** The codebase has a thoughtful single-node design and a substantial automated test suite, but the committed revision cannot be installed reproducibly, its release command is not clean-checkout safe, the default public browser-sharing path has a late-viewer relay failure, and a public client can create host rooms without operator authorization. Restart messaging and readiness also promise more continuity/health than the process can provide.

This verdict is based on source inspection and the checks recorded below. It is not a claim that every deployment mode is broken: direct browser WebRTC and many bounded single-host behaviors are well tested. The release must be held until the blocker list is closed and the external validation evidence is recorded.

## Production blockers

| Priority | Blocker | Evidence | Exit condition |
| --- | --- | --- | --- |
| P0 | Clean install and release chain are broken | T-1, T-3, S-8, D-1 | Valid reviewed lockfile; `npm ci`, audit, CI, packaging, SBOM, and clean build pass on supported Linux/Windows |
| P0 | Release preparation depends on an ignored pre-existing client build | T-2 | Clean checkout `release:prep` passes with build/test ordering or isolated test build fixed |
| P0 | Late public relay viewers may never receive a decodable initialization segment | L-1, U-1, T-4 | Fresh-generation/initialization contract fixed and delayed-viewer decoded-frame E2E passes |
| P0 | Public clients can allocate host rooms and exhaust capacity | S-1 | Server-side operator authorization/local-only creation enforced and abuse tests pass |
| P0 | Restart/recovery semantics are false for in-memory rooms | L-2, U-6, A-1 | Either rooms are recreated/rejoined correctly or all clients enter an honest terminal/recreate state; recovery tests cover it |
| P0 for service deployment | Readiness can be green without the client or enabled media dependencies | L-7, D-5 | Profile-aware readiness removes unusable instances from traffic and has integration tests |
| P0 for public distribution | Signing/legal/clean-machine/load/churn/topology evidence is open | T-9, D-2, D-3 | Named owners sign off retained results for the exact release artifact and supported environment |

## Release sequence

1. Repair `package-lock.json`, recreate dependencies with `npm ci`, and rerun every check before interpreting any current green result as release evidence.
2. Make `release:prep` clean-checkout safe and prevent stale ignored `dist/` from satisfying integration tests.
3. Fix the public relay generation/init contract and add delayed-join decoded-frame coverage.
4. Require a local/operator capability for room creation; rate-limit public WHIP ingest and narrow privileged LAN behavior.
5. Correct restart UX and readiness semantics for the intentionally in-memory, single-replica architecture.
6. Address the medium correctness/accessibility findings or explicitly narrow advertised support where a fix is deferred.
7. Run the signed packaged build on clean Windows and complete target hardware, long churn, real OBS, tunnel, TURN/strict-NAT, browser, mobile, and accessibility validation.
8. Publish the exact signed artifact with checksum, SBOM, source reference, support envelope, release notes, and rollback instructions.

## Minimum release acceptance criteria

- A fresh clone on supported Node 20 completes `npm ci`, production audit, lint, typecheck, unit/integration tests, browser tests, coverage, build, packaging evaluation, and packaged smoke without relying on ignored files.
- The public browser path demonstrates a delayed viewer receiving decoded frames through relay conditions and cleans up all room/relay resources afterward.
- Unauthorized public `create-room`, host-control, metrics, WHIP, and WHEP actions fail without allocating material resources or revealing credentials.
- Worker death, server replacement, tunnel loss, host disconnect, and viewer reconnect each produce tested, truthful terminal or recovery states.
- `/readyz` behavior matches documented deployment profiles and all features advertised as required.
- Supported Chromium/Firefox/WebKit and mobile scope is either tested or explicitly narrowed. Core routes pass keyboard and screen-reader checks.
- Three retained target-host capacity runs and a 30-60 minute churn run meet documented CPU, memory, latency, frame, and cleanup thresholds.
- The exact Authenticode-signed artifact passes clean-machine install/run/uninstall, checksum/SBOM verification, legal review, and rollback rehearsal.

## Checks executed

| Check | Result |
| --- | --- |
| `npm run lint` | Pass |
| `npm run typecheck` | Pass |
| `npm test` | 141 tests pass, with stale dependency/build caveat |
| `npm run test:coverage` | Pass; 76.83% lines / 65.57% branches / 81.61% functions across four selected files |
| Production build to isolated temporary output | Pass using existing local dependencies |
| `npm run oss:check` | Pass |
| `npm run evaluate:packaging` | Fail: invalid `package-lock.json` |
| `npm run audit:prod` | Fail: npm cannot load a lockfile |
| POC production dependency audit | Pass: 0 vulnerabilities |
| Rendered browser inspection | Not executed: no in-app browser backend was available |

## Supported-scope recommendation

The shortest credible route to release is a clearly labeled, single-host, single-replica personal streaming product with bounded rooms/viewers, best-effort Quick Tunnel, and no seamless restart promise. A hosted multi-tenant or high-availability service would require a materially different authorization, state, affinity, capacity, privacy, and operations design.
