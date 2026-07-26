# T04 — Truthful restart and reclaim states

Depends on T01.

<goal>
Keep same-process reconnect/reload recovery, but end the room cleanly when the
server process is replaced or reclaim is terminal.
</goal>

<read>
`server.js`, `lib/socket.js`, `lib/rooms.js`, `lib/workerRecovery.js`,
`src/HostView.jsx`, `src/WatchView.jsx`, and recovery/real-server tests.
</read>

<contract>
| Event | Result |
| --- | --- |
| Brief disconnect; room still exists | Recoverable retry |
| Host reload; valid token; same process | Reclaim |
| Process replacement or worker-fatal restart | Terminal room-ended state |
| Room missing or token invalid during reclaim | Terminal Host reset; offer new room |
</contract>

<do>
1. Add stable reason codes plus explicit `recoverable`/`terminal` state.
2. On terminal Host state, idempotently close media/timers/listeners, clear stale
   room recovery data, preserve reusable settings, and expose Create new room.
3. On terminal Watch state, stop playback/retry and explain that the room ended.
4. Remove wording that promises session survival across process replacement.
5. Add transition and integration tests for every row above and zero leaks.
</do>

<accept>
Failed reclaim cannot leave a false Streaming state; terminal viewers stop; all
same-process recovery tests still pass; no persistence is introduced.
</accept>
