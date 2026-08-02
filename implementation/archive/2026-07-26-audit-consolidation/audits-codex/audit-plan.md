# Nextra Production Audit Plan

## Purpose and constraints

This audit assesses whether Nextra is ready for production use and distribution. It is documentation-only: no application, configuration, build, or test code will be changed. Findings will be based on repository inspection and safe verification commands, and every issue will state its severity, location, production impact, recommendation, launch-blocker status, and related risks or dependencies.

## Project and stack map

| Area | Observed implementation | Audit focus |
| --- | --- | --- |
| Web client | React 19, Vite 7, hash-based routing, Socket.IO client | User journeys, accessibility, responsive behavior, lifecycle/state correctness, browser compatibility |
| Application server | Node.js 20+, Express 5, Socket.IO | Request trust boundaries, error handling, lifecycle, rate limits, graceful shutdown, static delivery |
| Real-time media | mediasoup WebRTC, browser capture, simulcast | Transport lifecycle, reconnection, resource ownership, capacity and failure behavior |
| OBS ingest | WHIP endpoint, OBS WebSocket setup, H.264/AV1 paths | Authentication, encoder configuration, A/V behavior, fallback and recovery |
| Viewer egress | WebRTC, optional WHEP, fMP4 relay fallback | Join authorization, playback transitions, slow viewers, fallback limits, cleanup |
| Public connectivity | Cloudflare Quick Tunnel, configured public URL, optional TURN/Cloudflare TURN | Origin validation, proxy trust, secret handling, tunnel failure/degradation |
| Operations | Health/readiness endpoints, status UI, logs, metrics, runtime benchmarks | Observability, safe defaults, capacity evidence, incident diagnostics |
| Distribution | Vite build, Windows `caxa` package, release workflow | Reproducibility, signing, clean-machine validation, rollback and dependency integrity |
| Quality controls | ESLint, TypeScript check-JS project, Node test runner, Playwright | Gate reliability, coverage depth, environment dependencies, end-to-end realism |

There is no database, durable user account system, or application-level authentication layer. Rooms and bearer/capability tokens form the primary access-control boundary; most runtime state is in memory.

## Core user flows to inspect

1. A host opens the app, chooses browser capture, creates a room, grants capture permission, shares the room link/code, changes quality/audio settings, and stops streaming.
2. A host configures OBS through WebSocket or manually, publishes via WHIP using H.264 or AV1, observes ingest health, and recovers from OBS or media-worker interruption.
3. A viewer opens a direct room link or enters a room code, supplies a passphrase when required, receives WebRTC media, falls back to relay where necessary, uses playback controls, and leaves/rejoins.
4. Host and viewers survive socket reconnects, host reloads, tunnel churn, media transport failures, worker restarts, and full server shutdown/restart.
5. An operator configures local/LAN/public access, tunnel and TURN options, checks health/readiness/status/metrics, packages/releases the app, and diagnoses failures.
6. An unauthenticated or abusive client attempts room enumeration, excessive room creation/joining, unauthorized media control, origin/proxy spoofing, oversized messages, or capability-token misuse.

## Audit method

### Phase 1 - Structural and dependency review

- Inventory tracked source, runtime assets, configuration, scripts, workflows, dependencies, and generated artifacts.
- Trace client routes and server HTTP/Socket.IO/WHIP/WHEP surfaces.
- Compare documented behavior and defaults with implementation.

### Phase 2 - UI and product review

- Walk every route and the host/viewer happy paths, denial paths, empty/loading/error states, reconnect states, and completion states.
- Inspect semantic HTML, focus management, keyboard access, live announcements, color/contrast risks, reduced-motion support, and responsive CSS.
- Review user-facing claims, terminology, validation, recovery guidance, and product trust cues.

### Phase 3 - Logic, security, and architecture review

- Trace room/session ownership, media resource cleanup, async acknowledgements, timers/listeners, reconnect/reclaim logic, and failure propagation.
- Review every external-input boundary, origin/proxy handling, tokens/passphrases, rate limits, security headers, subprocess execution, secret exposure, and dependency posture.
- Evaluate event-loop/memory pressure, relay fanout, media buffering, capacity limits, and multi-process/scaling constraints.

### Phase 4 - Production and test verification

- Run the repository's non-destructive lint, type-check, unit/integration, coverage, build, packaging-evaluation, open-source, and dependency-audit checks where practical.
- Inspect CI/release ordering and compare automated coverage with production-critical scenarios.
- Record environmental or external validation that cannot be proven in this workspace.

### Phase 5 - Reporting and consistency pass

- Write separate UI, logic, security, performance, testing, deployment/production-readiness, architecture, and nice-to-have reports.
- Deduplicate cross-cutting issues by giving each one a canonical detailed entry and linking concise references elsewhere.
- Rank blockers and recommended work by user harm, exploitability, likelihood, blast radius, and recovery cost.
- Recheck every path/line reference and ensure recommendations are specific enough to implement and verify.

## Planned deliverables

- `ui-issues.md`
- `logical-issues.md`
- `security-issues.md`
- `performance-issues.md`
- `testing-gaps.md`
- `deployment-risks.md`
- `architecture-review.md`
- `production-readiness.md`
- `nice-to-haves.md`

## Severity and blocker rubric

| Severity | Meaning |
| --- | --- |
| Critical | Credible path to severe compromise, broad data/media exposure, unrecoverable failure, or a core product flow that cannot operate |
| High | Likely production failure or security issue with major user/operator impact and no reliable workaround |
| Medium | Material reliability, usability, security, or maintainability problem with a workaround or limited blast radius |
| Low | Bounded defect, hardening gap, or polish issue with modest production impact |
| Nice-to-have | Optional improvement that increases trust, usability, operability, or future scalability |

An issue is a production blocker when shipping without it would make a supported core flow unsafe, consistently broken, operationally unverifiable, or contrary to the stated release contract. External approvals and topology tests can also be blockers even when the code itself is correct.
