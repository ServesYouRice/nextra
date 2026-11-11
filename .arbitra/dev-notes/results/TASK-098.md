# TASK-098 (lane rooms)

Fixed and committed on `lane/rooms` (base 84c0dd9). Only `tests/roomCreationConcurrency.test.js` changed; `lib/socket.js` and `lib/rooms.js` were not touched.

- The prompt says to wait on an observable signal if `lib/socket.js` awaits more work after `prepareRoom`. It does not: after `await prepareSocketRoom(...)` the cancelled-reservation check, the return and the `finally` release are synchronous (browser ingest has no `_mediaPipeline` to close). So awaiting the deferred promise plus one `setImmediate` is enough, and no timer is used.
- The defect is in the test, so there is no test that fails on unchanged code. Proof is by mutation in a scratch copy (guard in the create-room handler removed): the unchanged test passes, the new one fails. Output files: `rooms-TASK-098-before.txt` and `rooms-TASK-098-after-mutation.txt` in the scratchpad (C:\Users\V\AppData\Local\Temp\claude\c--Users-V-arbitra\53025464-426b-4472-9c62-52c45e3849f5\scratchpad).
- The prompt's second mutation wording, "skipping the disconnect cancellation", would already fail the old test (the pending count never reaches 0); the guard after `prepareRoom` is what the 25 ms sleep was meant to cover, so that is the mutation used.
- `findRoomBySocket` and `findRoomByCode` return `null`, not `undefined`; the new assertions use `null`.
- Left for PROGRESS.md: tick item 98 (`TASK-098`); the `results.json` entry is in `TASK-098.json` beside this file.
