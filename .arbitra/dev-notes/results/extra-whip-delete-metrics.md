# extra: WHIP DELETE did not tell the host (lane whip, commit 067c9ed on lane/whip)

Found while carrying out run-ccd3ccea's plan; not a plan item.

Real defect, fixed. `DELETE /whip/broadcast/:resourceId` in `lib/whipRoutes.js` called `stopFallbackRelay` and
`closeWhipSession` and answered 200, but never `emitHostMetrics(io, roomCode)`; the ICE/DTLS paths
(`teardownGeneration`, `beginGracePeriod`, `endGracePeriod`) and the go-live path all do.

What else refreshes the host after a DELETE, checked in the code:

- `HostView.jsx` takes `whipConnected`/`fallbackAvailable` only from the `room-metrics` event (and one
  `get-room-metrics` on mount).
- `lib/socket.js` `metricsBroadcastInterval` sends `room-metrics` to every host each
  `METRICS_BROADCAST_INTERVAL_MS` (default 5000, env-configurable), so the page was stale for up to that long, longer if
  the operator raised it.
- A viewer's socket consumer `producerclose` also emits host metrics, but only when a socket viewer has a consumer;
  with none (no viewers, or WHEP/relay viewers only) nothing else fires.

So the page recovers by itself, but late, and the sibling teardown paths deliberately do not wait for the broadcast.

Fix: one line after `closeWhipSession(room)` in the DELETE handler, `if (io) emitHostMetrics(io, roomCode);`, the same
form the other paths use. Placed after the 403 and 404 returns, so a refused or unknown DELETE emits nothing.

Tests (new block in `tests/whipRoutes.test.js`, before the 404 test, away from the rate-limit tests):

- `WHIP DELETE with the host token emits host metrics for that room once, after the teardown`: failed before the fix
  (expected one emit for the room with whipConnected false and no session id, got none); passes after.
- `a WHIP DELETE that is refused or finds no session emits no host metrics`: 403 (no header, wrong token) and 404
  (unknown, stale, orphaned resource whose room is gone) emit none; passed before and after, as it pins the guard.

Failing output: `C:\Users\V\AppData\Local\Temp\claude\c--Users-V-arbitra\53025464-426b-4472-9c62-52c45e3849f5\scratchpad\whip-extra-delete-metrics-before.txt`
(42 pass, 1 fail). After: `...\whip-extra-delete-metrics-after.txt` (43 pass).

Checks on lane/whip: `node --test tests/whipRoutes.test.js` 43/43, `npm run lint` clean, `npm run typecheck`
clean, `npm test` 1296/1296.

Not changed: `teardownGeneration` also sets `room.fallbackAvailable = false` after `stopFallbackRelay`; the DELETE
handler does not, because the real `stopFallbackRelay` (lib/socket.js) already clears it before the metrics are built.
