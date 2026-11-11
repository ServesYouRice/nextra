TASK-028 (lane socket): create-recv-transport now re-validates membership after the transport allocation. Verify command (`node --test tests/socketRecvTransportDeparture.test.js`, 7 tests), lint, typecheck and `npm test` (853 tests, 0 failed) pass. Failing output before the fix: `C:\Users\V\AppData\Local\Temp\claude\c--Users-V-arbitra\53025464-426b-4472-9c62-52c45e3849f5\scratchpad\socket-TASK-028-before.txt`.

Prompt notes:
- The prompt's quoted code and the "departure paths" are unchanged by TASK-012 to TASK-016/019; the handler is at about line 2231 of lib/socket.js now.
- The check sits after `attachTransportStateHandlers`, as TASK-013 did for create-send-transport, so the transport's 'close' listener clears it from the ignored list after `markTransportForShutdown`.
- The prompt says to write the test with "fake io/socket EventEmitters". It uses a real socket.io server on a loopback port 0 and the injected deferred `createWebRtcTransport`, like tests/socketHostSendPath.test.js: the real server runs the actual leave-room and disconnect handlers and sets `socket.connected` itself. No `server.js` is started, so `claimServerPorts()` does not apply.
- Cases beyond the three the prompt asks for: the viewer moved to another room during the await (room identity) and the room destroyed during the await (`findRoomBySocket` null). The two overlapping-call tests guard the "keep true" raced-transport cleanup and pass before and after.
- A viewer that leaves and re-joins the same room during the await still passes the check (same room object, a member again) and gets its transport stored; that is deliberate, it is a live member of the same live room.
- The prompt's "ask before running" for the verify command does not apply to a lane agent; the brief says to run the item's files.
- Left for PROGRESS.md: tick item 28 (`TASK-028`); the `results.json` entry is in `TASK-028.json` beside this file.
