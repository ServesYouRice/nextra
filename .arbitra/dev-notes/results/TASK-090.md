TASK-090 (C-210358e42002): fixed on lane/watch (from dev 80da94f), commit 4b268ed.

What changed
- New `src/lib/viewerSession.mjs`: `createViewerSession()` with `begin()` (a join starts a session and returns a token), `invalidate()` (Leave Room and the other resets end the session), `close()` (unmount) and `active`. A token has `isCurrent()`, `assertCurrent()` (throws StaleViewerSessionError), `hasNewerJoin()` and `mayUndoJoin()`. `abandonStaleJoin(token, { mayBeInRoom, leaveRoom })` sends the compensating leave-room (Q-003) and returns the error to throw.
- `joinRoomAndLoadDevice(roomCode, session)` checks the session after join-room, get-rtp-capabilities, getDevice and device.load. The only `setJoined(true)` sits after the last check, with no await between. A stale join writes no ref or state, resets the device module's singleton unless a newer join uses it, and throws.
- The session ends in: handleLeave (before its first await; it also clears a queued recovery and the loading state), the terminal transport-failed branch (loading state cleared too), room-ended, a failed handleJoin, a failed rejoin, and the unmount cleanup (`close()`).
- handleJoin begins its session after the joiningRef guard, so a second click does not end the join in flight. A stale join returns and leaves the view as the ending reset left it (no leave-room, no reset, no error), and the finally still clears joiningRef/joining, so the passphrase second step and the double-submit guard work as before.
- The reconnect rejoin returns at once when the session has ended (Leave Room is waiting for its answer), begins its own session, and when its session is stale returns without resuming (also not the relay fallback after a failed WebRTC start) and without the reset-to-unjoined branch. Its finally clears the loading state only for a current session; every ending reset clears it itself.

Q-003 (compensating leave): sent only when the join-room may have reached the server (not refused with phase 'server', not a request that never left), no newer join began since the session ended, the view is still mounted, and the socket is connected. After an unmount it is never sent: the socket is shared, and a leave-room from a host socket destroys that host's room.

Where the prompt was off, and choices made
- It lists `src/lib/viewerSession.mjs` and `tests/viewerSession.test.js` in read_first as if they existed; both are new. Line numbers were stale; I worked from the code as it stood (TASK-087/088/089 had changed it).
- Step 2 says to bump in "the non-recoverable transport-failed branch". The server only sends recoverable transport-failed to viewers, so that branch is in practice reached by a recoverable failure that arrives while `joinedRef` is false. A join still in flight then goes stale instead of completing over the reset.
- Beyond the steps: `viewerSession.active` stops a reconnect from rejoining while Leave Room waits for its answer (otherwise that rejoin would begin a newer session after the leave and win; reasoned from the code, not browser-tested); handleLeave clears the loading state and a queued recovery. The second browser test showed why the loading state matters: on the unchanged code a Leave followed by Join showed a stuck disabled "Connecting..." button, because the reconnect had set it and only the old rejoin's finally cleared it.
- `abandonStaleJoin` is a module function so the unit tests drive the compensation rules; the join harness in the test file has the shape of joinRoomAndLoadDevice and a source guard ties the two together.
- The prompt's verify commands say "ask before running"; per the brief they were run. Browser runs used run-e2e.cjs on the lane's own ports.

Not covered here (by design)
- recoverTransport (a transport-failed recovery, no join) and handleWatch/handleTryMediasoup do not check the session. They are covered by the playback-attempt ownership of TASK-087: handleLeave's cleanupPlayback supersedes them, but only after the leave-room answer (up to 5 s), so a Watch click or a transport recovery that fails and falls back inside that window can still send a relay start after leave-room. The attempt cleanup that follows stops it.
- enterFallbackMode's un-timed ack callback (C-5a217b5eb0cb, TASK-091) is untouched.

For the owner
- A stale join cannot be told apart from a slow one by the server: if the join-room was processed after leave-room (the server awaits the passphrase check), the viewer is briefly in the room until the compensating leave arrives. The browser test shows this and the leave.
- ui-semantics.spec.mjs was run too (93/93); host-reload-recovery.spec.mjs was not.
