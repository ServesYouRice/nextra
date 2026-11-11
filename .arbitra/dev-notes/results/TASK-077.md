# TASK-077

socketRequest in src/lib/mediasoupClient.js tags every failure with a phase ('connect', 'ack-timeout', 'disconnect-after-emit', 'server') and retries on the phase instead of the message text. 'connect' (nothing was sent) is retried for every event that gets a second attempt; 'ack-timeout' and 'disconnect-after-emit' only for IDEMPOTENT_EVENTS (get-media-init, reclaim-host, leave-room); 'server' never. create-room and join-room are now emitted once on a timeout or a disconnect after the emit. 13 tests added to tests/mediasoupClient.test.js; one existing test changed from join-room to get-media-init because it pinned the defect.

Left as is, on purpose:
- The prompt says reclaim-host and leave-room are retried too. Only create-room and join-room can double their effect; lib/socket.js handles a repeated reclaim-host (same token, same room) and leave-room (no room gives success) safely, so they keep their retry after a timeout. Say if the owner wants them non-retryable after an emit too: move them out of IDEMPOTENT_EVENTS.
- Default attempts did not change: events outside RETRYABLE_EVENTS (consume, produce, get-rtp-capabilities and so on) still get one attempt, so the constraint "connect failures stay retryable for all events" holds for every event that was retried before. Giving every event a connect-phase retry would add a second connect wait (up to 10 s) before an error on all of them.
- lib/socket.js has a comment in join-room about the retry of a slow join; the server-side re-join still works, the client just no longer relies on it.
- Open question section-84098610a3c7f7be0c63f39f/Q-004 has no default; VAL-109 decided it (drop the retries, no idempotency key).
