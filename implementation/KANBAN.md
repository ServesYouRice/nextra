# Implementation kanban

Updated: 2026-07-26. Status detail stays to one line.

## In progress

_None._

## Ready

- [ ] [T01 Reproducible dependencies](T01-dependencies.md) — malformed lockfile
  confirmed; use Node 20.

## Backlog

- [ ] [T02 Clean build and readiness](T02-build-readiness.md) — needs T01.
- [ ] [T03 Delayed relay generation](T03-relay-generation.md) — needs T01.
- [ ] [T04 Truthful restart states](T04-restart-states.md) — needs T01.
- [ ] [T07 Media capability truth](T07-media-capabilities.md) — needs T01.

## Blocked

- [ ] [T05 Operator and WHIP boundary](T05-operator-boundary.md) — needs T01, D01.
- [ ] [T06 Backend correctness](T06-backend-correctness.md) — needs T01, T05 (so D01).
- [ ] [T08 UI, accessibility, support](T08-ui-accessibility.md) — needs T03, T04, T07, D05.
- [ ] [T09 Security operations](T09-security-operations.md) — needs T02, T05, D02 (so D01).
- [ ] [T10 Release evidence](T10-release-evidence.md) — needs T01–T09, D01–D05.
- [ ] [T11 Small polish and extraction](T11-polish.md) — needs T01–T10.

## User needs to decide / provide

| ID | Needed | Recommended default | Unblocks |
| --- | --- | --- | --- |
| D01 | Who may host remotely and whether public WHIP is enabled | Loopback hosts by default; remote hosting requires an operator token; public WHIP off | T05, then T06 and T09 |
| D02 | Security policy for H.264 relay on non-loopback HTTP | Allow only on a declared trusted home LAN with a clear plaintext warning; require TLS elsewhere | T09 |
| D03 | Target OBS/FFmpeg host for the 0/500/1000/1500 ms A/V sync test | Measure on release hardware; do not guess a default | T10 |
| D04 | Signing owner, legal reviewer, clean Windows VM, and target hardware | Name owners and provide access before release certification | T10 |
| D05 | Browser/mobile support claim | Claim only tested desktop Chromium initially; expand after retained Firefox/WebKit/mobile results | T08, T10 |

Record a decision by replacing its row text with `DECIDED YYYY-MM-DD: ...`, then
move newly unblocked cards to **Ready** when their code prerequisites are done.
Each card's own `Depends on` line is the source of truth; a board entry must
repeat it exactly, including decisions inherited through another card.

## Done

_None._

## Parked; no implementation without a new user card

- Packager migration, containers/multiple replicas, persistence, recording,
  multiple presenters, chat/reactions, E2EE, accounts, and i18n.
- Worker pools or relay worker threads unless T10 measurements breach thresholds.
- A/V timestamp redesign unless the measured sync matrix shows drift.
