# Codex Deep Project Audit

Audit date: 2026-07-10 to 2026-07-11

Audited commit: 9bc13f7

Scope: browser client, signaling, mediasoup, WHIP/WHEP, FFmpeg fallback, security, dependencies, performance, packaging, CI, operations, and tests.

## Verdict

The project is a credible prototype and LAN beta, but it is not ready for public production.

The main launch blockers are:

1. Leaving the Host route can leave screen capture and media publication running invisibly.
2. Public AV1 playback through the packaged Quick Tunnel is not reachable with the default media-plane topology.
3. The production lockfile contains a high-severity remotely triggerable WebSocket denial-of-service vulnerability.
4. Fallback relay startup and destruction are not serialized or centrally owned, allowing duplicate pipelines and leaked transports, consumers, timers, and buffers.
5. The Windows release artifact is unsigned and the packaging flow does not yet establish a complete production release or license-compliance chain.

## Report map

- [Production blockers](01-production-blockers.md)
- [Correctness and security](02-correctness-security.md)
- [Performance and refactoring](03-performance-refactoring.md)
- [Operations and packaging](04-operations-packaging.md)
- [Testing gaps](05-testing-gaps.md)
- [Remediation roadmap](06-remediation-roadmap.md)
- [Reconciliation with audits-fable](07-reference-reconciliation.md)

## Validation results

| Check | Result |
|---|---|
| Unit tests | 80 passed, 0 failed |
| ESLint | Passed |
| Production build | Passed |
| OSS preflight | Passed |
| Root production dependency audit | Failed: 4 high and 1 moderate |
| poc-mediasoup dependency audit | Failed: 1 high |
| Coverage probe | 54.08% overall; critical runtime modules are mostly 10% to 18% |
| Nextra.exe SHA-256 | Matches Nextra.exe.sha256 |
| Nextra.exe Authenticode | Not signed |
| cloudflared.exe Authenticode | Valid |
| Tracked working tree before report creation | Clean |

The coverage percentage includes files that make the aggregate appear healthier than the application-critical paths. It should not be used as a release-readiness score.

## Priority register

| ID | Priority | Finding | Production impact |
|---|---|---|---|
| B-01 | Blocker | Host route unmount does not own session shutdown | Privacy and ghost-stream risk |
| B-02 | Blocker | Default public AV1 topology is unreachable | Advertised playback mode fails |
| B-03 | Blocker | Vulnerable ws and tar versions in lockfile | Remote DoS and failed release gate |
| B-04 | Blocker | Fallback relay startup and teardown races | Duplicate FFmpeg pipelines and leaks |
| B-05 | Blocker | Unsigned, incomplete release chain | Trust, provenance, and distribution risk |
| CS-01 | High | OBS producer replacement retains stale tracks | Frozen playback after reconnect |
| CS-02 | High | WebM queue drops arbitrary stream fragments | Playback corruption |
| CS-03 | High | fMP4 generations leak listeners and URLs | Increasing memory and reconnect instability |
| CS-04 | High | WHIP/WHEP admission is non-atomic | Capacity bypass and leaked sessions |
| CS-05 | High | Browser send resources lack explicit ownership | PeerConnection and producer leaks |
| CS-06 | High | join-room retry is not idempotent | Incorrect membership after delayed acknowledgements |
| CS-07 | High | TURN credentials are publicly harvestable | Relay bandwidth abuse |
| CS-08 | High | Credential minting is an unprotected GET | Provider quota and credential abuse |
| CS-09 | High | Remote OS media control defaults on | Surprising remote side effects |
| CS-10 | High | Forwarded-header trust includes arbitrary LAN peers | Spoofed client identities and rate-limit bypass |
| OP-01 | High | Quick Tunnel is used as a production path | Unsupported scale and unstable URLs |
| OP-02 | High | Tunnel subprocess supervision is incomplete | Hung or permanently lost public link |
| PF-01 | High | One worker/router conflicts with advertised capacity | CPU and event-loop saturation |
| PF-02 | Medium | Recorder restarts for every fallback viewer | Discontinuities and CPU spikes |
| PF-03 | Medium | fMP4 parser repeatedly copies pending data | Avoidable hot-path cost |
| PF-04 | Medium | H.264 fragment assembly lacks continuity checks | Corruption after RTP loss |
| OP-07 | Medium | Packaged logs rotate only at startup | Unbounded disk growth |
| OP-09 | Medium | restart.bat kills any owner of port 3000 | Destructive local operation |
| T-01 | High | Critical integration paths are largely untested | Regressions reach releases undetected |

## What is already solid

- The current build, lint, unit tests, and OSS preflight pass.
- Socket events generally validate payload shape and room membership.
- Producer access is scoped to rooms.
- Origin validation, rate limiting, CSP nonces, and static caching are present.
- The shared mediasoup WebRtcServer materially improves port usage.
- Relay queues have explicit size caps and FFmpeg has a restart budget.
- WHEP setup has a connection deadline.
- The packaged cloudflared binary has a valid signature.
- Nextra.exe has a matching checksum, even though the executable itself is not signed.
- UI audit items U-1 through U-12 are resolved at the audited commit.

## Severity meaning

- Blocker: must be resolved or explicitly disabled before a public production release.
- High: likely user-visible failure, security exposure, or resource leak under realistic use.
- Medium: important reliability, scalability, maintainability, or hardening work.
- Low: polish or defense-in-depth with limited immediate production impact.
