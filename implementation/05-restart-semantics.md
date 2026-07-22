# Packet 05 - Truthful restart and failed-reclaim semantics

Finding: CF-05. Prerequisite: Packet 01. Use high effort and a separate diff review.

## Objective

Preserve same-process transient reconnect/reload recovery, but treat full process
replacement as session-ending. Host and viewers must leave stale playback state
and receive a clear new-room path rather than an impossible resume promise.

## Read first

- shutdown/worker-death flow in `server.js`
- reclaim, host disconnect, room destroy in `lib/socket.js`, `lib/rooms.js`
- Host reconnect/recovery effects and cleanup in `src/HostView.jsx`
- Watch restart/reconnect effects in `src/WatchView.jsx`
- `lib/workerRecovery.js`, recovery and real-server tests
- deployment/recovery claims in README and `docs/service-deployment.md`

## State contract

| Event | Expected result |
| --- | --- |
| Brief socket disconnect, same process/room | Existing reclaim/rejoin behavior may resume. |
| Host reload with opted-in recovery, same process | Existing host token may reclaim. |
| Graceful server replacement | Room is terminal; both roles say it ended. |
| Mediasoup worker death requiring process restart | Room is terminal; no seamless media claim. |
| Reclaim returns room-not-found/token-invalid | Host cleans stale session and offers a new room. |

## Plan

1. Give restart/room-ended payloads explicit reason and terminal/recoverable fields.
   Remove copy implying the old in-memory room will resume after process replacement.
2. Return stable machine-readable reclaim failure codes (room missing, token invalid,
   non-recoverable) instead of making clients parse text.
3. Add Host handling for terminal restart and terminal reclaim failure: stop/close
   local transports/recorders/timers, clear persisted recovery data and stale code,
   keep user settings, show the reason, and offer Start/Create new room.
4. Make Watch terminal handling stop playback and say the room ended. It may retain
   the old code for explanation/copy but must not silently loop forever.
5. Preserve retry/resume only for events explicitly marked recoverable and for
   same-process room existence.
6. Ensure shutdown cleanup does not emit redundant host-stopped work back into a
   dying server and all client resources close idempotently.
7. Add transition-table tests plus integration coverage for brief reconnect,
   opted-in reload, server replacement, worker death, failed reclaim, and cleanup.
8. Update README/deployment text: supervisor restarts the service, not the session.

## Invariants

- No persistence/database is introduced.
- Same-process reload recovery is not broken.
- Terminal cleanup is idempotent and preserves reusable UI settings.
- Old room links/tokens are never represented as live after replacement.
- Users receive one clear terminal state, not competing reconnect/error banners.

## Acceptance criteria

- Failed Host reclaim never leaves `isSharing`/Streaming with a dead room.
- Viewer terminal state stops retries/playback and explains the room ended.
- Same-process reconnect/reload recovery tests continue to pass.
- Worker/server replacement tests assert truthful terminal behavior and zero leaked resources.
- Documentation has no automatic session-continuity claim.

## Dispatch objective

```xml
<objective>
Implement explicit recoverable-versus-terminal session transitions. Keep
same-process reconnect/reload recovery, but on process replacement or terminal
reclaim failure clean Host/Watch media state, retire the old room, and offer a
new-room path. Add stable failure codes and transition/integration tests.
</objective>
```
