# Implementation board

Updated: 2026-08-01. This is the only active Markdown file in `implementation/`.
The completed T01–T16 cards and their evidence are archived in
[`archive/2026-08-01-implementation-completion/COMPLETED-CARDS.md`](archive/2026-08-01-implementation-completion/COMPLETED-CARDS.md).
Earlier audits and superseded plans remain historical evidence under
`archive/2026-07-26-audit-consolidation/`.

## Current status

T18 and T19 are done. T17 is the only remaining card; it is blocked on an
external network/TURN setup, not on a pending user decision.

### In progress

_None._

### Ready

_None._

### Backlog

_None._

### Done

#### T19 — Stop OBS when the room it streams to goes away

User-reported: killing the server or closing the host page mid-stream leaves OBS
streaming, and the next session misbehaves.

WHIP is client-driven: a session ends only when OBS sends
`DELETE /whip/broadcast/:resourceId`, and OBS ignores ICE/DTLS teardown. The
server's only leave-detector is `dtlsstatechange` (`lib/whipRoutes.js`), which a
SIGKILL never triggers. obs-websocket is the only channel that can stop OBS, and
it was wired to exactly one call site: the Stop sharing button.

Two changes, both in the browser:

- `src/lib/obsWebSocket.js`: `stopActiveStream()` moved out of the `if (autoStart)`
  block in `configureObsStream()`. `SetStreamServiceSettings`, `SetVideoSettings`,
  `SetProfileParameter`, and `SetOutputSettings` all ran unconditionally below it,
  so with auto-start off they rewrote settings underneath a live output — the
  obs.dll video-pipeline race already noted in that file. A stream that outlived
  its target is still `outputActive`, making this the common path on the second
  Start sharing.
- `openObsControlChannel()` holds one identified obs-websocket connection for the
  session. `stopObsStream()` opens, identifies, and closes per call, and that
  handshake cannot finish during unload, so unload paths could not use it. The
  channel writes `StopStream` synchronously; the browser flushes queued data
  before the close frame. `withObsConnection()` gained a non-finite
  `transactionTimeoutMs` opt-out to support it.
- `src/HostView.jsx`: `stopObsIngest()` prefers the open channel and falls back to
  `stopObsStream()` when there is none (e.g. after a reload-recovery reclaim). It
  runs on pagehide, non-pagehide unmount, the start-sharing failure path, Stop
  sharing, and `terminateHostSession` — which covers a graceful server shutdown,
  since the `room-ended` broadcast is the only warning OBS can get.

Reload recovery is deliberately untouched: it keeps the room alive across
pagehide, so OBS should keep streaming. A killed or crashed server still cannot
signal anything; the reconfigure fix is what stops that from breaking the next
session.

Checks: `npm run lint`, `npm run typecheck`, `npm test` (197 pass, 4 new in
`tests/obsWebSocket.test.js`), `npm run build`. The 4 new tests were confirmed
failing against the pre-change `src/lib/obsWebSocket.js` via `git stash`.
`README.md` troubleshooting table gained a row for the surviving gap.

#### T18 — Responsive layout pass across all views

User-reported: the How to Use and Host tabs did not scale across resolutions,
and the Host settings cards kept their height until the page grew a scrollbar.

Measured before the change (Playwright, `src/index.css` as shipped):

- `/#host` with OBS ingest selected: video stage 160 px wide at 1024 px, 416 px
  at 1280 px. The side panel is `flex: 0 0 auto` with a hard width, so the stage
  absorbed every pixel the two settings cards took.
- `/#host` page height a constant 965 px: +197 px over a 1366x768 viewport and
  +245 px over 1280x720, in both ingest modes. No `max-height` media query
  existed anywhere in the stylesheet.
- `/#how-to`: prose fixed at 680 px (27% of a 2560 px screen) while the browser
  support table overflowed into a sideways scroll at *every* width, 1024 through
  2560.

After:

- Stage ≥ 560 px at 1024/1280/1440/1600 px with OBS on (was 160/416/576/672).
- `/#host` fits 1366x768 and 1280x720 with no page scroll, both ingest modes.
- Support table no longer overflows at any width (630 px → 899-1118 px).
- Article prose 640 px, legal 704 px — within 8 px of the previous design.

Changes, all in `src/index.css` except the last two:

- Shared layout tokens; vertical rhythm clamps on `vh` so it compresses on short
  viewports, `vh` rather than `dvh` to avoid mobile URL-bar reflow.
- Host tiers at 1280 px (cards stop sharing a row) and 900 px (column stacks).
  1280 is where two side-by-side cards still leave the stage above 560 px;
  keeping them side by side also keeps the page short, since stacked cards sum
  their heights instead of the taller one winning.
- `--stage-chrome` bounds the 16:9 stage by leftover viewport height.
- Articles became a breakout grid: prose at `--article-measure`, the support
  table spanning the full width. `h2`/`.article-cta` top margins were reduced to
  compensate for grid items not collapsing margins.
- Fixed a specificity bug: the `@media (max-width: 900px)` `.host-side-panel`
  override lost to `.host-side-panel:has(.settings-expanded)` and never applied.
- `tests/browser/ui-semantics.spec.mjs`: reflow matrix widened to 9 widths x 7
  routes, plus vertical-fit and stage-width tests for `/#host`. The two new test
  groups were confirmed failing on the pre-change tree before any CSS was edited.
- `README.md`: tested-width list and the two host breakpoints.

Checks: `npm run lint`, `npm run typecheck`, `npm test` (194 pass),
`npx playwright test` (46 pass, both projects), `npm run build`.

Known gap: at 1280x720 with OBS selected the page still scrolls ~38 px, because
a WHIP preflight warning banner is showing. That banner only appears when the
server has WHIP disabled, as the test server does; the layout itself fits. The
vertical-fit test allows for visible `.alert` height rather than encoding that
environment quirk.

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
