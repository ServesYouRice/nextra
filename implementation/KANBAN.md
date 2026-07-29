# Implementation record

Updated: 2026-07-29. This is the only active Markdown file in `implementation/`.
Historical audits and superseded plans remain evidence under
`../archive/2026-07-26-audit-consolidation/`.

## Current status

### In progress

_None._

### Ready

_None._

### Backlog

_None._

### Blocked

_None._

## Decisions

| ID | Decision | Unblocked |
| --- | --- | --- |
| D01 | 2026-07-28: Loopback hosts by default; remote hosting requires an operator token; public WHIP is off. | T05, T06, T09 |
| D02 | 2026-07-28: H.264 relay on non-loopback HTTP is allowed only for a declared trusted home LAN with a plaintext warning; TLS is required elsewhere. | T09 |
| D03 | 2026-07-29: Hardware-specific OBS/FFmpeg sync measurement is optional operator validation, not an open-source release gate. | T10 |
| D04 | 2026-07-29: Publish CI-built unsigned artifacts with checksums; signing, legal review, and dedicated release hardware are optional maintainer actions. | T10 |
| D05 | 2026-07-29: Claim desktop Chrome/Edge plus mobile Chrome viewers with a retained mobile-Chrome E2E project; everything else remains “not tested.” | T08, T10 |

## Completed work

### T01 — Reproducible dependencies

Regenerated and validated the dependency graph on Node 20, aligned CI setup-node
pins, and retained clean-install, inventory, lint, typecheck, unit, build,
packaging, OSS, and production-audit gates. Evidence: Node 20 clean install and
141-test release preparation passed.

### T02 — Clean build and truthful readiness

Made integration/release checks independent of a stale ignored `dist/`; production
readiness now reports named HTTP, Socket.IO, mediasoup, SPA, and required-WHIP
components while `/healthz` remains liveness. Evidence: isolated SPA readiness
tests and Node 20 release preparation with 142 tests passed.

### T03 — Delayed H.264 relay generation

Added a recorder/server generation contract: zero-to-one relay demand selects one
fresh generation, later viewers reuse it, stale chunks cannot cross generations,
and last-viewer cleanup clears bounded queues/listeners/timers/buffers/URLs.
Evidence: ordering checks, the 159-test Node 20 suite, and delayed two-viewer
decoded-frame/leave/rejoin Chromium coverage passed.

### T04 — Truthful restart and reclaim states

Distinguished recoverable same-process reconnect/reclaim from terminal room end
after process replacement, worker-fatal restart, missing room, or invalid reclaim.
Host and viewer teardown is idempotent and recovery wording no longer promises
cross-process survival. Evidence: transition/recovery tests, lint, typecheck, and
the 143-test Node 20 suite passed.

### T05 — Operator, LAN, and WHIP boundary

Centralized client classification and constant-time operator authorization before
room allocation, sensitive metrics, TURN minting, and WHIP work. Loopback Host/OBS
remains supported; forwarded spoofing, public host authority, secret leakage, and
over-capacity pending starts are denied. Evidence: focused operator/network/WHIP/
WHEP checks, lint, typecheck, and the 151-test Node 20 suite passed.

### T06 — Contained backend correctness

Marked viewer receive transports for conservative bandwidth, replaced synchronous
room passphrase hashing with bounded asynchronous reservations, and reused the
constant-time comparator while narrowing WebSocket CSP endpoints. Evidence:
focused transport/room/socket/WHIP/server checks, lint, typecheck, the 159-test
Node 20 suite, coverage thresholds, and four-case Chromium gate passed.

### T07 — Authoritative AV1 capability

WebRTC AV1 support now comes from loaded receive RTP capabilities; MSE checks stay
on relay playback and WebGL is only an OBS encoder preference hint. OBS setup uses
bounded set-and-verify candidates with complete H.264 rollback. Evidence: focused
WebRTC/OBS capability tests, lint, typecheck, and the 146-test Node 20 suite passed.

### T08 — UI correctness, accessibility, and support truth

Added state-backed room codes, truthful Watch/quality copy, labelled and stateful
join/fps controls, route titles/focus/announcement, tested support claims, and
representative keyboard/reflow coverage. Evidence: 24-case desktop/mobile Chrome
E2E, the 166-test suite, lint, typecheck, coverage, and build passed.

### T09 — Relay security and bounded operations

Applied the trusted-LAN plaintext relay policy, bounded long-lived collections,
made unexpected rejections supervisor-fatal, suppressed absent-host metrics work,
and stopped all Status polling while hidden with one immediate refresh/interval on
resume. Evidence: focused security/cleanup/visibility checks and the 166-test suite passed.

### T10 — Open-source release gate

CI runs release preparation and retained desktop/mobile Chrome paths. Windows CI
and tagged builds package with caxa, create a SHA-256 checksum, replace the real
mediasoup worker, prove decoded frames and graceful cleanup, and publish unsigned
artifacts without external credentials. Signing, capacity/churn, clean-VM, NAT/TURN,
and hardware A/V sync checks remain optional operator validation. Evidence:
3 workflow tests, 169-test release preparation, 24-case E2E, checksum verification,
artifact build, and packaged worker-recovery/decoded-frame smoke passed.

### T11 — Small polish and extraction

Implemented the actionable low-priority items in independently testable seams:

- protected rooms request a labelled, focused passphrase as an informational
  second step while retaining the entered room code;
- known capture, timeout, transport, and abort failures show a useful next action
  with technical detail retained separately;
- fullscreen exposes pressed state and a tested exit path;
- restricted Status copy describes the local UI instead of a nonexistent token UI;
- the duplicate 400 px CSS rules are one block with retained viewport assertions;
- shared byte formatting, room metric payloads, fMP4 eviction, and media-debug URL
  parsing have behavior tests around the former call-site differences;
- the existing Host/viewer session-controller seam names relay, transport, media,
  queue, listener, timer, and resource ownership; idempotent controller cleanup and
  retained reconnect/rejoin paths cover it, so no broader lifecycle rewrite was made;
- OBS live-region markup was intentionally unchanged because no retained
  assistive-technology test fails, matching the card’s stop condition.

Evidence: 7 focused utility/player/payload tests, lint, typecheck, the 175-test
unit/integration suite, coverage, build, packaging evaluation, OSS checks, both
production audits, all 26 desktop/mobile Chrome E2E cases, artifact build and
SHA-256 verification, plus packaged worker-recovery/decoded-frame/shutdown smoke passed.

## Verification policy

For a new card, add it to this file with dependencies, goal, named source/tests,
acceptance criteria, and exact checks. Move only one card to **In progress** per
executor. Inspect current behavior first, add a focused regression where practical,
implement the smallest complete change, and record only evidence produced by the
current run. A partial change is **Blocked**, not Done.

The standard gates are the focused test, then the smallest relevant subset of
`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and
`npm run test:e2e`; use `npm run release:prep` for the full release gate.

## Parked — requires a new user-approved card

- Packager migration, containers or multiple replicas, persistence, recording,
  multiple presenters, chat/reactions, E2EE, accounts, and i18n.
- Worker pools or relay worker threads unless operator measurements breach thresholds.
- A/V timestamp redesign unless an operator-measured sync matrix shows drift.
- Path-specific Host preflight, a redacted diagnostic bundle, measured capacity/
  headroom, named-tunnel onboarding, viewer copy-link, clearer room/link lifetime,
  and configurable support/legal contacts.
- Protocol schemas until clients and servers can deploy independently.
