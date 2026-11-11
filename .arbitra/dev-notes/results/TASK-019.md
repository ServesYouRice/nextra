# TASK-019 (lane rooms)

Fixed and committed as fe5c592 on `lane/rooms` (base dea3f1e). Files: `lib/rooms.js`, `lib/sessionRegistry.js`, `tests/rooms.test.js`, `tests/sessionRegistry.test.js`. `lib/socket.js` was not touched.

- The prompt says to reuse the `removeViewer` cleanup "without unmapping the new mapping"; this is `removeViewerFromRoom(room, socketId)`, shared by `removeViewer` and the new `leavePreviousRoom(socketId, nextRoom)`. The viewer's consumers and recv transport in the previous room are closed as `removeViewer` already does.
- `commitRoom` calls `leavePreviousRoom` after `rooms.set`, so it skips the previous room when it is the new room itself (a stale mapping to the same code).
- Per Q-004 default, the previous room's `hostSocketId` is never changed. A host socket of A that is mapped into B keeps A's host role; destroying A no longer deletes its mapping to B. socket.js still refuses that switch, so no handler behaviour changes.
- `reclaimHostRoom` unmaps the old host only if it is still mapped to that room, and removes the reclaiming socket from the room it was mapped to before. A reclaiming socket that is already a viewer of the same room stays in that room's viewers, as today (single-room behaviour unchanged).
- No existing test needed a change. Failing output before the fix: `C:\Users\V\AppData\Local\Temp\claude\c--Users-V-arbitra\53025464-426b-4472-9c62-52c45e3849f5\scratchpad\rooms-TASK-019-before.txt`.
- The prompt's verify step says to ask before running `node --test tests/rooms.test.js tests/sessionRegistry.test.js`; the brief tells the lane to run touched files itself, so it was run.
- Left for PROGRESS.md: tick item 19 (`TASK-019`); the `results.json` entry is in `TASK-019.json` beside this file.
