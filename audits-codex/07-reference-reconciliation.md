# Reconciliation with audits-fable

The audits-fable folder was used as a reference, but every major item in this report was checked against the audited commit rather than copied forward automatically.

## Confirmed current findings

The following reference themes remain valid:

- fallback relay startup race
- partial and inconsistent fallback teardown
- insufficient runtime crash/failure ownership
- join retry/idempotency risk
- fMP4 listener and generation cleanup
- WHEP/WHIP lifecycle and concurrency gaps
- one mediasoup worker/router
- main-thread relay and parsing pressure
- insufficient integration and browser testing
- large modules with mixed ownership

The Codex report expands these with:

- the Host route ghost-sharing/privacy blocker
- the public AV1/loopback/Quick Tunnel topology blocker
- current dependency advisories and failing release gate
- stale-track behavior after OBS producer replacement
- WebM corruption when arbitrary queue chunks are dropped
- TURN credential harvesting
- overly broad private-network proxy trust
- credential-minting endpoint abuse
- tunnel child-process pipe and termination defects
- executable signing, provenance, and distribution gaps

## Resolved findings that should not be reopened

audits-fable/ui-issues.md marks U-1 through U-12 resolved on 2026-07-10. The audited HEAD includes that work.

Resolved themes include:

- literal ellipsis rendering
- join re-entry guarding
- live settings feedback
- Stop confirmation with viewers
- modal focus trapping
- narrow-layout overflow
- product-copy consistency improvements
- stale UI error clearing
- host/viewer empty-state guidance
- inert hidden OBS controls
- watch URL parsing
- placement of advanced settings

These should remain regression-test targets, not be reported as current defects without new evidence.

## Finding that is no longer accurate as originally stated

The reference claim that all tunneled viewers collapse to one synthetic IP is not accurate in the current implementation.

server.js now extracts CF-Connecting-IP or X-Forwarded-For for recognized public share requests. The remaining problem is different: shouldTrustRequestForwardedHeaders accepts too broad a set of private-network peers, allowing LAN spoofing.

The current action is therefore to narrow proxy trust, not to add forwarded-header support from scratch.

## Materially improved older architecture concerns

The shared mediasoup WebRtcServer removes the former per-WebRtcTransport listener/port explosion. Port capacity should not be described using the older one-port-pair-per-viewer model.

That improvement does not solve:

- single-worker CPU capacity
- incorrect loopback announced candidates for public direct media
- relay main-thread pressure
- UDP probe/rebind races used by auxiliary media paths

## How to maintain these audits

When fixing an item:

1. Add a regression test first where practical.
2. Update the finding with commit, date, and verification evidence.
3. Mark it resolved rather than deleting the historical reasoning.
4. Re-run related cross-cutting checks; lifecycle fixes often affect several findings.
5. Keep product claims and deployment documentation synchronized with the actual supported topology.

The audits-codex folder should be treated as a point-in-time technical report, not an automatically current issue tracker.
