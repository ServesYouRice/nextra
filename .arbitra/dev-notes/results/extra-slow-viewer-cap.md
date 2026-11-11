extra-slow-viewer-cap (not a plan item; found while carrying out run-ccd3ccea's plan, raised in extra-late-relay-bootstrap.md "For the owner"): lane/server, from dev 6e85eff. Commit: f1c1191.

Verdict: REAL.
- What the cap measures: lib/socket.js getSocketBufferedBytes = the bytes of the packets in Engine.IO's writeBuffer + ws bufferedAmount. ws bufferedAmount is net.Socket _writableState.length + the ws sender's queue. emitToRelayViewers (WebM) and deliverMp4RelayUnit (MP4) drop a relay viewer when that total passes RELAY_SOCKET_MAX_BUFFERED_BYTES (16 MB).
- How the bootstrap goes out: relay-consume-start sends it in its acknowledgement, one Buffer of up to MAX_RELAY_BOOTSTRAP_BYTES (24 MB). Socket.IO writes the acknowledgement as two Engine.IO packets. The text header is flushed first, and that makes the transport non-writable. The bootstrap then waits in writeBuffer (counted) until that write's callback, and goes to ws as one write. Node keeps a write in _writableState.length until libuv reports it finished.
  - On Linux and macOS, libuv writes what the kernel's send buffer takes (a few MB at most) and finishes the request only once the last byte is in. So the bootstrap counts in full for as long as the link needs to carry the rest.
  - The Engine.IO transport also stays non-writable until that write's callback. So the live chunks pile up in writeBuffer and count on top of it.
- The result: at the first live chunk (300 ms later), the check saw bootstrap + live. A late viewer whose bootstrap was above 16 MB was dropped with "Relay connection is too slow. Reconnecting..." unless its link carried the bootstrap in about 300 ms (450+ Mbps). A smaller bootstrap was dropped once it plus the live chunks queued behind it passed 16 MB. The viewer's recovery rejoins and gets the same bootstrap, or a larger one.
- Why it never showed on Windows: on loopback, Windows takes a single 24 MB write at once, so the bootstrap counted for about 0 ms. It hit Linux and macOS servers.

Proof without depending on the OS
- tests/socketRelayBootstrap.test.js, stallLink(): it overrides the viewer's server-side net.Socket _write/_writev (reached through socket.request.socket) so that any write beyond a 64 KB send buffer is held whole until the test resumes the link.
- Node then counts the held write exactly as it counts libuv's unfinished write on Linux. The probe (server-extra-slowcap-probe.cjs) reads the measure at 20971664 bytes right after the start acknowledgement, and the first live chunk drops the viewer.
- New tests, which run the real server, the real Socket.IO client and the real cap:
  - 'a late relay viewer whose link has not taken its bootstrap yet keeps receiving the live chunks': a bootstrap at the ceiling (RELAY_QUEUE_MAX_BYTES), then 8 live 525 KB slices. FAILED before ("still a relay viewer", false !== true). Now the viewer stays, and the browser queue (relayAppendQueue.mjs) gets bootstrap + 8 slices in order, with no transport-failed.
  - 'the slow-viewer cap (16 MB) / (4 MB) still drops a late relay viewer whose live backlog passes it while the bootstrap is on the way': live 1 MB chunks behind a stalled bootstrap at the ceiling. FAILED before (dropped after 0 MB; expected 16 and 4). Now the viewer is dropped once its live backlog passes the cap, and it gets the relay-backpressure notice.
  - 'the slow-viewer cap drops a relay viewer at the same live backlog once its bootstrap has been written': passed before and after (16). It guards that the allowance ends once Engine.IO has written the bootstrap.
  - 'a late MP4 relay viewer whose link has not taken its bootstrap yet stays in the relay audience': init + a 20 MB keyframe GOP, then a live delta fragment. FAILED before (dropped).
  - 'without Engine.IO send callbacks a bootstrap counts toward the slow-viewer cap, with one warning': FAILED before (the function did not exist).

Fix (lib/socket.js, at the cause: the measure counted a one-off snapshot as backlog)
- trackRelayBootstrap(socket, bytes) runs right after the start acknowledgement, while the bootstrap is still in Engine.IO's write buffer. It records the bytes per socket in a WeakMap and pushes a callback onto conn.packetsFn. Engine.IO runs that callback once the batch holding the bootstrap has been written, which is the same mechanism as its public send callbacks.
- getRelayBacklogBytes() = the measure minus a bootstrap still in flight, never below 0.
- The cap checks in emitToRelayViewers (WebM) and deliverMp4RelayUnit (MP4) use it. MP4 skipping still uses the full measure: a late MP4 viewer is behind live until its bootstrap arrives, and skipping to the next keyframe is the designed catch-up.
- Protection kept: live chunks behind the bootstrap count in full, so a viewer whose live backlog keeps growing is dropped at the same 16 MB, during its bootstrap and after. Peak memory for one late viewer: bootstrap (24 MB at most) + cap.
- The constants tied: the cap no longer bounds the bootstrap, so it can be any size relative to MAX_RELAY_BOOTSTRAP_BYTES. Neither RELAY_SOCKET_MAX_BUFFERED_BYTES (env) nor the ceiling can be changed into this defect again.
  - The tests take the ceiling from RELAY_QUEUE_MAX_BYTES, which the existing test keeps equal to MAX_RELAY_BOOTSTRAP_BYTES, and the cap from config.
  - They check it with the default cap and with a cap of 4 MB, a sixth of the ceiling.
- If Engine.IO ever drops packetsFn, the bootstrap counts as before, with one console warning, and the stalled-link tests fail.
- config.js, README.md and .env.example: the cap's description says a late viewer's bootstrap is not counted.
- Test-file setup: the file sets config.JOIN_RATE_LIMIT_MAX = 1000, because with the new tests it makes 25 joins from 127.0.0.1 and the limit is 20 a minute. startRelayRoom also returns serverSocketOf(). No existing assertion changed.

Proof files (shared scratchpad)
- server-extra-slowcap-probe.cjs: the probe, which shows the measure and the drop on unchanged code.
- server-extra-slowcap-before.txt: the first version of the tests on unchanged code (12 tests, 3 failed).
- server-extra-slowcap-before-final.txt: the final tests on the 6e85eff lib/socket.js (written over the lane's file and restored): 14 tests, 5 failed as listed above.
- server-extra-slowcap-after-unit.txt: socketRelayBootstrap + socketTransportRecovery + socketMediaChunk + relayAppendQueue, 44/44.
- server-extra-slowcap-after-e2e.txt: every browser spec through run-e2e.cjs on the lane's own ports (25256/25257), --workers=1. 137 passed, 13 skipped (the mobile-chrome ui-semantics cases the spec skips), 0 failed. media-flow.spec.mjs 27/27.
- server-extra-slowcap-npmtest.txt: npm test 1524/1524. npm run lint and npm run typecheck were clean.
- server-extra-slowcap-socket-fixed.js.txt: a copy of the fixed lib/socket.js, made while the old file was written over it.

For the owner
- The fix reads one more private Engine.IO field (conn.packetsFn), next to the writeBuffer and transport.socket.bufferedAmount the cap already reads. The tests pin the installed behaviour.
- On a polling transport, the measure counts only writeBuffer. Between the flush and the written callback, the bootstrap is subtracted although it is no longer counted. A polling viewer may then hold up to cap + bootstrap for that one response. This is bounded and brief, and relay viewers use WebSocket first.
- Not shown on a real Linux kernel: Docker is not running, and the only WSL distribution here is docker-desktop. The Linux behaviour follows from libuv's write path. The test reproduces exactly what the server measures in that state.
