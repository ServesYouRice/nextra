# Nextra agent guide

Nextra is a single-node, self-hosted screen-sharing app. Browser capture and OBS
ingest use mediasoup; H.264 can fall back to a Socket.IO media relay. Rooms and
credentials live only in process memory.

## Start here

1. Read `implementation/KANBAN.md`.
2. Work on the assigned card, or the first card under **Ready**. Never start a
   blocked card.
3. Read only that card and the source files it names. Historical audits under
   `archive/` are evidence, not current instructions.
4. Inspect the current code before editing. If the card is already satisfied,
   prove it with its checks and update the board instead of rewriting it.
5. Move the card to **In progress**, implement the smallest complete change, run
   its checks, then move it to **Done** or **Blocked** with one short evidence line.

## Product boundaries

- Keep one process and one replica. A process restart ends active rooms.
- Treat hosting, metrics, TURN minting, and public WHIP as operator actions;
  viewing is public when a room link is shared.
- Preserve browser WebRTC, H.264 relay, OBS WHIP/WHEP, and local packaged flows
  unless the card explicitly changes one.
- Do not add accounts, persistence, Redis, multi-replica support, recording,
  chat, E2EE, a new packager, or a new dependency without a user-approved card.

## Implementation rules

- Match the surrounding code's naming, comments, and structure.
- Prefer a focused behavior test before the fix. Do not weaken or delete tests.
- Avoid adjacent refactors, speculative validation, compatibility shims, and
  abstractions for one-time operations.
- Validate at trust boundaries: user input, network input, credentials, files,
  child processes, and external APIs.
- Update the directly affected README/config example in the same change.
- Do not commit, push, publish, rotate credentials, or change product policy
  unless the user asks.

## Verification and reporting

- Run the focused tests named by the card, then the smallest relevant gates from
  `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and
  `npm run test:e2e`. Use `npm run release:prep` when the card requires the full gate.
- Report only results supported by command output from the current run. State
  skipped or failing checks plainly.
- Final updates stay short: outcome, checks, blocker or next Ready card.

## Expensive reasoning

Use a stronger advisor/reviewer only for a concrete unresolved architecture,
security-boundary, or concurrency decision. Delegate only independent work with
clear file ownership; one coordinator owns `implementation/KANBAN.md`. Do not
create an agent team for a single tightly coupled card.
