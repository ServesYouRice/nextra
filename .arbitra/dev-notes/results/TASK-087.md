TASK-087 (C-46da39562b9e): fixed on lane/watch (from dev c7489d0), commit dc5ec74.

Proof
- Browser repro in tests/browser/media-flow.spec.mjs ('a relay start superseded by a socket reconnect leaves no stale playback, error or subscription'). An init script wraps the page's WebSocket so the test can hold back incoming `42["media-init"` frames and close the Socket.IO WebSocket. A tunnel-origin viewer clicks Watch, its relay attempt waits for live media-init, then the connection drops and the viewer reconnects and rejoins (onReconnect, the issue's socket-reconnect trigger).
- Unchanged code (HEAD build): failed. About 7 s after the reconnect the superseded attempt rejected ('Relay stream is not ready yet'). handleWatch, still pending from before the reconnect, then ran cleanupPlayback and its WebRTC fallback in the reconnected session, which ended in 'WebRTC mode active (lowest latency).' with no click. After the fix it passes, 3 of 3 with --repeat-each=3; the media-flow spec passes 13 of 13.
- The prompt's unit tests (tests/playbackAttempt.test.js, tests/subscriptionLedger.test.js, 17 tests) cover the attempt helper, the recovery guard and the ledger, including the VAL-156 ordering case. They cannot run on the old code (the modules are new); their source-level guard failed there.

Review checklist (attempt check after every await; every relay stop through the ledger)
- consumeProducer: check at entry; after `consume` ack; after `recvTransport.consume()` (closes the consumer if stale); after `consumer-resume` (same); after `playVideoElement` (its autoplay-denied retry and mute are skipped for a stale attempt).
- startMediasoupPlayback: after `create-recv-transport` (stale: emits close-viewer-transport for that id while connected, no ref written); recvTransportRef is written after that check and the transport is owned by the attempt; after `get-producers`; after each consumeProducer; after the ICE wait. The catch hands any failure to `attempt.settleFailure` (stale: closes its own transport, SupersededAttemptError).
- startRelayPlayback: relay-consume-start goes through `emitClaimedStart` (claim and emit in one synchronous block, refused while disconnected); after the ack (a refused start releases its claim without a stop); the claim is committed to relayClaimRef/relaySubscribedRef only after the check; after `get-media-init`; after the live media-init wait; MediaSource, object URL (owned, revoked by a stale attempt), mediaSourceRef, objectUrlRef and video.src are written after that check; after `sourceopen`; after the first-buffered wait. The listeners (onMediaInit, enqueueChunk, processQueue, updateend) do nothing once the attempt is cleaned up or superseded. The live media-init and sourceopen waits end as soon as the attempt is cleaned up.
- relay-consume-stop is emitted only by `releaseSubscription` (ledger.canRelease: latest claim, socket connected, same socket.id), from three places: useViewerSessionController's relay-subscription owner (committed claim), startRelayPlayback's catch (a claim the attempt still owns), failRelayGeneration (current attempt only). tests/subscriptionLedger.test.js checks the source for direct emits.

Recovery guard
- onTransportFailed (recoverable) and onReconnect run through one guard (replaces reconnectingRef). A transport failure that arrives during a recovery is dropped. A reconnect is queued as the one follow-up, because the new socket.id has to rejoin the room, and runs after the current recovery. The chain shares the intent (wasWatching, mode, fallback) captured when its first recovery began. The terminal transport-failed branch and room-ended drop a queued follow-up.

Where the prompt was off, and choices made
- It cites VAL-145; read as VAL-156 (validation-fixes.md).
- Its read_first lists the new modules and tests as if they existed; they are created here.
- Line numbers matched the code as it was (705 was the single relay check).
- Step 3's 'same synchronous block' rules out socketRequest (it awaits the connect check before emitting), so relay-consume-start now uses emitClaimedStart: a raw emit with a 15 s ack timeout and disconnect rejection, the same as socketRequest's defaults for this non-retried event. As step 3 asks, a disconnected socket now fails the relay start at once ('Not connected to the server, so "relay-consume-start" was not sent. Try again in a moment.') instead of waiting up to 10 s for a reconnect; the callers' existing fallback handles it.
- The prompt's verify commands say 'ask before running'; per the instructions they were run. Playwright ran against scratchpad builds with server.js started by hand on 3210 under the lock (lock released, server stopped via /api/test/shutdown).
- check 13's tidy-up: the dead Blob branch is kept, but its conversion now re-checks the chunk's generation, and enqueueChunk ignores a cleaned-up or superseded attempt.

For the owner
- A reconnect or transport failure that supersedes a Watch click still in progress (the viewer was not yet watching) no longer lets that attempt's caller start the other mode by itself afterwards. The viewer gets the Watch Stream button back with no error and clicks again; that is what the repro asserts. Treating 'a Watch in progress' as wasWatching in the recovery intent would resume instead; not done here.
- A superseded mediasoup attempt still waits out its 2 s/8 s ICE timer: mediasoup-client's close() does not emit connectionstatechange. TASK-088 restructures that wait.
- A reconnect during a transport-failed recovery waits for that recovery to settle (bounded by the attempt's own timeouts). It does not pre-empt it.
- ui-semantics.spec.mjs was not run (the prompt names media-flow only).
- Verification: eslint (4 files) clean; npm run lint and typecheck clean; npm test 1097/1097; node --test of the two new files 17/17.
