# Architecture Review

## Current system shape

| Layer | Responsibility | Principal implementation |
| --- | --- | --- |
| React client | Host capture/OBS control, viewer playback, status, legal/help routes | `src/HostView.jsx`, `src/WatchView.jsx`, `src/StatusView.jsx`, `src/App.jsx` |
| Control plane | Room admission, host/viewer lifecycle, relay signaling, metrics | `server.js`, `lib/socket.js`, `lib/rooms.js`, `lib/sessionRegistry.js` |
| Media plane | mediasoup transports/producers/consumers; browser WebM relay; OBS WHIP/WHEP and FFmpeg/fMP4 fallback | `lib/mediasoup.js`, `lib/whipRoutes.js`, `lib/whepRoutes.js`, `lib/fmp4Relay.js` |
| Edge/runtime | Cloudflare tunnel, optional TURN, process supervision, Windows packaging | `lib/tunnelSupervisor.js`, `lib/turn.js`, `scripts/package-app.js` |
| State | In-memory rooms, tokens, resources, transports, and metrics | One Node process; no durable database or distributed coordinator |

The shape is reasonable for the stated personal, single-node product: the browser control plane is lightweight, mediasoup handles real-time media, and the OBS/browser paths reuse the same room abstraction. The principal architectural risk is not the technology choice; it is that several lifecycle protocols are implicit across very large modules and are not enforced as state machines or shared contracts.

## Strengths worth retaining

- Media cleanup and limits are treated as first-class concerns: bounded rooms/viewers, relay queue checks, stale-resource cleanup, and real-worker recovery tests already exist.
- Browser capture and OBS ingest have intentionally different fallbacks, which reflects real deployment constraints instead of pretending Cloudflare HTTP tunneling carries UDP media.
- Secrets are generally capabilities rather than user identities, sensitive values are redacted from logs, and short-lived TURN credentials are supported.
- Packaging, signing, SBOM, license artifacts, health endpoints, and external validation procedures are already designed into the project.
- The documentation honestly scopes multi-instance deployment and lists outstanding external evidence.

## A-1 - The single process is both the control plane and the media ownership boundary

- **Severity:** Medium
- **Location:** `server.js`; `lib/socket.js`; `lib/sessionRegistry.js`; `lib/rooms.js`; `lib/mediasoup.js`
- **Description:** One Node process owns HTTP, Socket.IO, room credentials, relay buffers, WHIP/WHEP resources, and the single mediasoup worker. Process replacement destroys all authoritative room state.
- **Why it matters for production:** A crash or deployment ends every room, and ordinary rolling deployment or horizontal scaling is impossible without room affinity and external coordination.
- **Recommended fix:** For the current product, make single-node/restart-destructive behavior explicit and enforce one replica. Add truthful maintenance UX and fast clean recreation. Introduce external state/affinity only if high availability or multi-instance hosting becomes a committed requirement.
- **Blocker before production:** No for a documented personal/single-node deployment; yes for HA claims.
- **Related risks/dependencies:** L-2, D-6, mediasoup router locality, token persistence.

## A-2 - Critical lifecycles are implicit across monolithic event handlers

- **Severity:** Medium
- **Location:** `src/HostView.jsx` (~2,000 lines); `src/WatchView.jsx` (~1,400 lines); `lib/socket.js` (~2,200 lines)
- **Description:** Room ownership, reconnect, relay generation, recorder startup, consumer teardown, fallback, and retry logic are distributed among effects, refs, timers, and socket callbacks. The unused relay viewer-transition ref associated with L-1 is one symptom.
- **Why it matters for production:** Illegal or unhandled state transitions become likely as features grow, while timeout-based tests can miss races that only appear under delayed joins and reconnects.
- **Recommended fix:** Extract explicit host, viewer, and relay state machines with named transitions, invariants, and idempotent enter/exit effects. Keep protocol adapters thin and test transition tables independently before changing transport technologies.
- **Blocker before production:** No, but the specific L-1/L-2 lifecycle defects are blockers.
- **Related risks/dependencies:** P-7, testability, React effect ownership, reconnection semantics.

## A-3 - The Socket.IO protocol has no shared runtime schema or compatibility version

- **Severity:** Medium
- **Location:** event payload construction and validation in `src/HostView.jsx`, `src/WatchView.jsx`, and `lib/socket.js`
- **Description:** Event names and payload shapes are duplicated between JavaScript client and server. Validation is handler-specific, and there is no negotiated protocol version or generated contract.
- **Why it matters for production:** Client/server drift can silently turn a deploy or cached client into a broken join, especially for optional fields and relay generations.
- **Recommended fix:** Define shared runtime schemas for every inbound/outbound event, infer editor types from them, validate at both trust boundaries, and include a protocol version plus explicit incompatible-client response.
- **Blocker before production:** No for atomic single-artifact releases; required before independently deployed clients/servers.
- **Related risks/dependencies:** N-7, CSP/cache policy, rolling deploy limitations.

## A-4 - Media fallback paths duplicate coordination without one transport-neutral contract

- **Severity:** Medium
- **Location:** browser WebRTC/WebM paths in `HostView`/`WatchView`; OBS WHIP/WHEP/fMP4 paths in server libraries
- **Description:** Direct WebRTC, browser relay, WHEP, and fMP4 fallback each express readiness, generation, liveness, and teardown differently. UI and server code infer which path is healthy rather than consuming one normalized session state.
- **Why it matters for production:** Capability detection and fallback copy can disagree with actual transport readiness, producing issues such as L-1, L-5, and D-5.
- **Recommended fix:** Introduce a small transport-neutral contract: `starting`, `ready`, `degraded`, `failed`, generation ID, last-media timestamp, capabilities, and terminal reason. Adapt each media path to it without forcing the data planes into one implementation.
- **Blocker before production:** No; fix existing fallback correctness first.
- **Related risks/dependencies:** OBS/browser feature differences, telemetry cardinality, user-facing error mapping.

## A-5 - Admission, authorization, and media ownership are coupled to ephemeral room records

- **Severity:** Medium
- **Location:** `lib/rooms.js`; create/join/reclaim handlers in `lib/socket.js`; WHIP/WHEP resource maps
- **Description:** Room codes simultaneously locate an in-memory object, while host/viewer/media capabilities authorize actions against it. There is no separate operator identity or durable admission boundary.
- **Why it matters for production:** This is simple for personal use but makes public host authorization (S-1), auditing, revocation, restart restoration, and multi-instance design difficult.
- **Recommended fix:** Add a narrow operator/admin capability for privileged room creation and diagnostics now. Preserve random per-room capabilities. Only introduce accounts or a database if product requirements demand durable ownership/history.
- **Blocker before production:** S-1 is a blocker; durable identity is not.
- **Related risks/dependencies:** Threat model, privacy obligations, D-6.

## A-6 - Observability is useful but not aligned to deployable service levels

- **Severity:** Low
- **Location:** `/healthz`, `/readyz`, `/metrics`, status snapshots, client lifecycle logs
- **Description:** The system exposes valuable component data, but readiness is not profile-aware, active media freshness is not a service-level signal, and no release envelope ties metrics to supported capacity.
- **Why it matters for production:** Operators can observe counters without knowing which conditions require failover, restart, or traffic removal.
- **Recommended fix:** Define deployment profiles and a small SLO set: join success, time to first decoded frame, active-media freshness, relay drops, worker restarts, and component readiness. Document alert thresholds from target-host tests.
- **Blocker before production:** No, except readiness correctness in L-7/D-5.
- **Related risks/dependencies:** D-3, metrics access control, performance baselines.

## Recommended architectural direction

Keep the current single-node React/Node/mediasoup architecture for the intended release. First repair the lifecycle and trust-boundary defects. Then extract shared schemas and explicit state machines behind existing interfaces. Do not add a database, microservices, multi-worker distribution, or a new packager merely for architectural neatness; each should require a concrete durability, scaling, or platform trigger and equivalent media/recovery tests.
