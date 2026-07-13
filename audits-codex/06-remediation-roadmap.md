# Remediation Roadmap

This sequence is ordered by user risk and dependency between fixes. It is not a cosmetic refactor plan.

## Phase 0 — Contain immediate release risk

1. Upgrade ws, tar, and related Socket.IO dependencies.
2. Update or quarantine the vulnerable poc-mediasoup package.
3. Rerun tests, build, OSS preflight, and production audits.
4. Disable public AV1 when the media plane is loopback-only.
5. Correct end-to-end encryption and TURN-connectivity claims.
6. Default remote media control to off.
7. Stop distributing or promoting the current unsigned executable as production-ready.

Exit criteria:

- Root and nested production audits pass.
- CI release:prep passes.
- UI prevents unsupported public AV1 sessions.
- Security and encryption copy matches the actual architecture.

## Phase 1 — Establish resource ownership

1. Implement HostSession.
2. Implement RoomMediaPipeline.
3. Move every fallback transport, consumer, timer, buffer, and child process under that owner.
4. Add synchronous fallback startup serialization and generation cancellation.
5. Make room destruction invoke one idempotent close operation.
6. Track browser send transport and both producers.
7. Add route-unmount and concurrent-start regression tests.

Exit criteria:

- Repeated and concurrent close calls are safe.
- Route navigation leaves no active capture or publication.
- Failed fallback startup returns every resource count to baseline.
- Two simultaneous start requests create one pipeline.

## Phase 2 — Make ingest and viewer sessions race-safe

1. Implement atomic WHIP/WHEP capacity reservations.
2. Add session generation IDs.
3. Close partial resources in finally.
4. Unify Socket.IO and WHEP room caps.
5. Track consumers and MediaStreamTracks by producer/consumer ID.
6. Replace same-kind tracks atomically after OBS reconnect.
7. Make join-room idempotent or non-retryable.

Exit criteria:

- Parallel admission cannot exceed capacity.
- Late callbacks cannot modify replacement sessions.
- OBS reconnect does not leave ended tracks.
- Delayed join acknowledgements cannot corrupt membership.

## Phase 3 — Stabilize playback generations

1. Treat WebM overflow as generation failure instead of dropping arbitrary bytes.
2. Add SourceBuffer time-range eviction.
3. Separate fMP4 generation and lifetime cleanup.
4. Cancel stale initialization callbacks.
5. Stop restarting MediaRecorder for every new viewer.
6. Validate H.264 RTP sequence/timestamp continuity.
7. Replace repeated fMP4 Buffer.concat with a segmented queue.

Exit criteria:

- Reconnect churn has stable heap/listener counts.
- Buffer pressure recovers predictably.
- New fallback viewers do not interrupt existing viewers.
- Packet loss cannot merge unrelated H.264 fragments.

## Phase 4 — Secure public exposure

1. Restrict automatic proxy trust to loopback.
2. Require explicit trusted proxy CIDRs.
3. Remove TURN credentials from public config.
4. Issue short-lived credentials only after authorization.
5. Protect and rate-limit credential minting.
6. Remove metrics query-string authentication.
7. Validate all environment settings at startup.
8. Add explicit API/protocol 404 behavior.

Exit criteria:

- LAN clients cannot spoof public client identity.
- Anonymous clients cannot harvest TURN credentials.
- Invalid configuration fails before listeners start.
- Security integration tests cover public, proxy, and LAN cases.

## Phase 5 — Replace the public networking contract

1. Decide whether production supports direct public media, a colocated relay, or fallback-only tunnel playback.
2. Implement named-tunnel/custom-domain support if public production is a goal.
3. Add TunnelSupervisor with output draining, backoff, URL changes, and reliable termination.
4. Publish a supported topology matrix.
5. Add real external-network media tests.

Exit criteria:

- Every advertised codec/mode works in each advertised topology.
- Tunnel restarts do not silently strand the host.
- Direct media and signaling reachability are monitored separately.

## Phase 6 — Build a real release pipeline

1. Align version metadata with tags.
2. Separate browser build dependencies from server runtime dependencies.
3. Pin and verify cloudflared.
4. Run packaging only after the complete quality gate.
5. Build and smoke-test on Windows.
6. Include licenses, notices, source instructions, and SBOM.
7. Authenticode-sign and timestamp Nextra.exe.
8. Publish provenance and checksums from CI.

Exit criteria:

- Release artifacts are reproducible from a clean tag.
- The exact published executable passes its smoke test.
- Signatures and provenance validate independently.
- Distribution materials have completed license review.

## Phase 7 — Establish the supported scale envelope

1. Add worker, transport, relay, heap, and event-loop metrics.
2. Run LAN and public load tests.
3. Lower defaults to measured safe values.
4. Add room-affine worker/router pooling if required.
5. Move relay parsing/fanout away from the main event loop if measurements justify it.
6. Add active log rotation, readiness, and supervisor documentation.

## Final production gate

Do not label the project production-ready until all of the following are true:

- No unresolved Blocker findings.
- Production dependency audits pass for every package.
- Host unmount cannot leave sharing active.
- Fallback and ingest teardown are leak-free under churn.
- Advertised public AV1 has a demonstrated working topology or is disabled.
- TURN and proxy trust tests pass.
- Long-run memory/resource counts stay within a defined envelope.
- Windows artifacts are tested, signed, and accompanied by required distribution materials.
- Monitoring distinguishes process health, media-worker health, tunnel health, and actual media reachability.
