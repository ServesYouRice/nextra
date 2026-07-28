# Implementation kanban

Updated: 2026-07-28. Status detail stays to one line.

## In progress

_None._

## Ready

_None._

## Backlog

_None._

## Blocked

- [ ] [T08 UI, accessibility, support](T08-ui-accessibility.md) — needs T03, T04, T07, D05.
- [ ] [T09 Security operations](T09-security-operations.md) — non-UI relay policy, bounded cleanup, host-metric suppression, fatal rejection handling, operations docs, focused 31-test set, and 159-test suite pass; hidden-tab Status polling remains excluded by the requested UI scope.
- [ ] [T10 Release evidence](T10-release-evidence.md) — local release prep, four-case Chromium E2E, artifact build, and packaged Windows smoke pass; remains blocked by T08, T09 UI scope, D03 hardware sync evidence, D04 external release owners/access, and D05 support claim.
- [ ] [T11 Small polish and extraction](T11-polish.md) — needs T01–T10.

## User needs to decide / provide

| ID | Needed | Recommended default | Unblocks |
| --- | --- | --- | --- |
| D01 | DECIDED 2026-07-28: Loopback hosts by default; remote hosting requires an operator token; public WHIP off | — | T05, then T06 and T09 |
| D02 | DECIDED 2026-07-28: Allow H.264 relay on non-loopback HTTP only for a declared trusted home LAN with a clear plaintext warning; require TLS elsewhere | — | T09 |
| D03 | Target OBS/FFmpeg host for the 0/500/1000/1500 ms A/V sync test | Measure on release hardware; do not guess a default | T10 |
| D04 | Signing owner, legal reviewer, clean Windows VM, and target hardware | Name owners and provide access before release certification | T10 |
| D05 | Browser/mobile support claim | Claim only tested desktop Chromium initially; expand after retained Firefox/WebKit/mobile results | T08, T10 |

Record a decision by replacing its row text with `DECIDED YYYY-MM-DD: ...`, then
move newly unblocked cards to **Ready** when their code prerequisites are done.
Each card's own `Depends on` line is the source of truth; a board entry must
repeat it exactly, including decisions inherited through another card.

## Done

- [x] [T06 Backend correctness](T06-backend-correctness.md) — focused transport/room/socket/WHIP/server checks, lint, typecheck, 159-test Node 20 suite, coverage thresholds, and final four-case Chromium gate pass.
- [x] [T05 Operator and WHIP boundary](T05-operator-boundary.md) — operator/network/WHIP/WHEP focused checks, lint, typecheck, and the 151-test Node 20 suite pass.
- [x] [T07 Media capability truth](T07-media-capabilities.md) — focused WebRTC/OBS capability tests, lint, typecheck, and the 146-test Node 20 suite pass.
- [x] [T04 Truthful restart states](T04-restart-states.md) — stable terminal/recoverable transition tests, focused recovery tests, lint, typecheck, and the 143-test Node 20 suite pass.
- [x] [T03 Delayed relay generation](T03-relay-generation.md) — bounded active-generation bootstrap, generation ordering checks, 159-test Node 20 suite, and delayed two-viewer decoded-frame/leave/rejoin Chromium case pass.
- [x] [T02 Clean build and readiness](T02-build-readiness.md) — isolated SPA readiness tests pass; Node 20 release prep passes with 142 tests and coverage thresholds.
- [x] [T01 Reproducible dependencies](T01-dependencies.md) — Node 20 clean install,
  inventory, lint, typecheck, 141 tests, build, packaging, OSS checks, and both production audits pass.

## Parked; no implementation without a new user card

- Packager migration, containers/multiple replicas, persistence, recording,
  multiple presenters, chat/reactions, E2EE, accounts, and i18n.
- Worker pools or relay worker threads unless T10 measurements breach thresholds.
- A/V timestamp redesign unless the measured sync matrix shows drift.
