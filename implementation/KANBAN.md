# Implementation board

Updated: 2026-08-01. This is the only active Markdown file in `implementation/`.
The completed T01–T16 cards and their evidence are archived in
[`archive/2026-08-01-implementation-completion/COMPLETED-CARDS.md`](archive/2026-08-01-implementation-completion/COMPLETED-CARDS.md).
Earlier audits and superseded plans remain historical evidence under
`archive/2026-07-26-audit-consolidation/`.

## Current status

All repository-local approved cards are complete. T17 is the only remaining card;
it is blocked on an external network/TURN setup, not on a pending user decision.

### In progress

_None._

### Ready

_None._

### Backlog

_None._

### Blocked

#### T17 — Real-network NAT/TURN validation

Dependencies: T05, T07, T10, T13, T14.

Goal: validate the existing public H.264 relay and TURN-backed WebRTC paths from a
viewer outside the host LAN without expanding the supported topology or limits.

Source/tests: `README.md` Internet Sharing and Operations sections,
`tests/browser/media-flow.spec.mjs`, and `scripts/benchmark-runtime.js`.

Acceptance criteria:

- an external-network viewer decodes H.264 relay media through the supported
  public-tunnel path;
- a configured TURN path is exercised across a real NAT boundary and its selected
  route is recorded without exposing credentials;
- the environment, topology, result, and any failure are recorded as
  machine-specific evidence rather than a portable support claim; and
- the default room, viewer, and relay-pipeline limits remain unchanged.

Checks when unblocked: the focused decoded-frame browser flow, one labelled live
WebRTC measurement, and manual external-network H.264 relay and TURN observations.

Blocker: the operator does not currently have the external network/TURN environment
configured. No repository change can substitute for that topology.

## Standing product decisions

| ID | Decision |
| --- | --- |
| D01 | 2026-07-28: Loopback hosts by default; remote hosting requires an operator token; public WHIP is off. |
| D02 | 2026-07-28: H.264 relay on non-loopback HTTP is allowed only for a declared trusted home LAN with a plaintext warning; TLS is required elsewhere. |
| D03 | 2026-07-29: Hardware-specific OBS/FFmpeg sync measurement is optional operator validation, not an open-source release gate. |
| D04 | 2026-07-29: Publish CI-built unsigned artifacts with checksums; signing, legal review, and dedicated release hardware are optional maintainer actions. |
| D05 | 2026-07-29: Claim desktop Chrome/Edge plus mobile Chrome viewers with a retained mobile-Chrome E2E project; everything else remains “not tested.” |
| D06 | 2026-08-01: Keep Authenticode signing out of scope while it requires maintainer-provided credentials; retain the unattended unsigned/checksum path. |
| D07 | 2026-08-01: Keep the conservative default capacity limits; raise them or change media concurrency/timing only for a demonstrated use case backed by target-host evidence. |
| D08 | 2026-08-01: Public version tags publish the tested unsigned executable and checksum with accurate support/source notes; missing or new production dependency licenses fail review. |

## Future scope — requires a new user-approved card

These items are not a committed backlog and do not block the current board.

| Area | Scope and start condition |
| --- | --- |
| Packaging | Replace caxa only after an explicit migration decision and compatibility proof. |
| Hosting architecture | Add containers, multiple replicas, persistence, or accounts only for an approved hosted-product target. |
| Product features | Recording, multiple presenters, chat/reactions, E2EE, and i18n require product scope and acceptance criteria. |
| Media scaling | Add worker pools or relay worker threads only when operator measurements breach the documented thresholds. |
| Media timing | Redesign A/V timestamps only when an operator-measured sync matrix demonstrates drift. |
| Operations | Named-tunnel onboarding and configurable support/legal contacts require an operator-facing product decision. |
| Protocols | Add formal protocol schemas when clients and servers need independent deployment. |

## Verification policy

For a new card, add it to this file with dependencies, goal, named source/tests,
acceptance criteria, and exact checks. Move only one card to **In progress** per
executor. Inspect current behavior first, add a focused regression where practical,
implement the smallest complete change, and record only evidence produced by the
current run. A partial change is **Blocked**, not Done.

The standard gates are the focused test, then the smallest relevant subset of
`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and
`npm run test:e2e`; use `npm run release:prep` for the full release gate.
