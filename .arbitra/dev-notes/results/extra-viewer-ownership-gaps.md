extra-viewer-ownership-gaps (not a plan item; found while carrying out run-ccd3ccea's plan, left open by TASK-087..091, plus a fifth gap from lane/server's extra-late-relay-bootstrap): lane/watch, from dev 21b10e1. Fast-forwarded to dev d3bda4a before the work and to dev 50e67b7 before the commit; the socketRelayBootstrap.test.js conflict was resolved by keeping both sides. Commit: 5517816 (one commit for all fixes).

Verdicts
1. recoverTransport and the fMP4 relay (TASK-091): REAL, fixed.
2. Playback started, failing or recovering while Leave Room waits for its answer (TASK-090): REAL in all three paths, fixed.
3. rejoinAfterReconnect's `normalizeRoomCode(codeInput)` fallback (TASK-091): NOT REAL, left as it is.
4. fmp4RelayPlayer.js's own fallback-consume-start retry (TASK-091): HARMLESS, left as it is.
5. A late relay viewer drops the live chunks between the relay-consume-start answer and the get-media-init answer (lane/server): REAL, fixed.

1. recoverTransport and the fMP4 relay
- Code: recoverTransport ran cleanupPlayback() and setFallbackMode(false)/setFallbackState(null). cleanupPlayback stops the player but leaves fallbackClaimRef, isEnteringFallbackRef and the server's subscription alone. A start still waiting for its answer kept its claim and its entering flag.
- When it happens: the server sends a fallback viewer no transport-failed ("during relay/fallback switch" branch of handleViewerTransportFailure), but it does send one when the WebRTC transport fails before it has processed the viewer's fallback-consume-start. That is the window of "Switch to Relay Mode", and of an OBS relay-first viewer whose recv transport the server still has.
- What the viewer saw (browser test, unchanged code): after the transport-failed the auto-enter path never asked again (the entering flag blocked it). The viewer saw Watch Stream and "Stream connection interrupted. Reconnecting...". The late answer then started a player while fallbackMode was false, so nothing on screen belonged to it, and its subscription was never stopped.
- Fix (WatchView, on top of TASK-091's ledger and exitFallbackMode):
  - recoverTransport now calls exitFallbackMode(). The player stops, and the claim goes back through releaseSubscription: one fallback-consume-stop, sent only while it is the latest start on the same connected socket.id. The entering flag is cleared, and a late answer finds its claim gone ('stale': no player, no stop).
  - The recovery intent's wasFallbackMode, captured but never read before, now resumes the relay with enterFallbackMode(), as rejoinAfterReconnect does.
  - The transport-failed effect moved below handleLeave, because its dependency list now names enterFallbackMode/exitFallbackMode. The text is unchanged apart from the lines above and the session checks of gap 2.

2. Leave Room's wait (up to 5 s for the leave-room answer)
- Code: handleLeave ended the session first, but called cleanupPlayback only after the answer. handleWatch, handleTryMediasoup and recoverTransport did not look at the session. onTransportFailed starts a recovery whenever joinedRef is true, which it still is during the wait. Watch Stream and Try WebRTC stay on screen until the answer.
- Proven by three browser tests (unchanged code): a Watch start that failed in the wait sent relay-consume-start and get-media-init; a transport-failed in the wait restarted WebRTC (create-recv-transport, get-producers, consume, connect-transport, consumer-resume); Try WebRTC in the wait did the same.
- Fix:
  - handleLeave runs cleanupPlayback() before it awaits leave-room. Every attempt in flight is superseded at once (TASK-087's ownership) and ends as a SupersededAttemptError, so nothing falls back to the other mode. Every other end of a session (room-ended, the terminal transport-failed branch, a failed rejoin, unmount) already cleaned up in the same synchronous block.
  - handleWatch, handleTryMediasoup and recoverTransport take `viewerSession.current()` at entry, before they change anything, and return when there is none. Each of their fallback branches also checks `session.isCurrent()`, as rejoinAfterReconnect does.
  - Visible change: on Leave Room the picture goes away at the click, not after the answer.

3. rejoinAfterReconnect's codeInput fallback: not real
- The fallback is only read when joinedRoomCodeRef is empty while joinedRef is true, no terminal room end happened and `viewerSession.active` holds. That never happens:
  - joinedRoomCodeRef is set to the joined code in the same synchronous commit as the only setJoined(true) (joinRoomAndLoadDevice).
  - Every write that empties it (Leave Room, the terminal transport-failed branch, a failed handleJoin, a failed rejoin) follows a viewerSession.invalidate(), so the rejoin returns at `if (!viewerSession.active) return;` first.
- codeInput cannot change while joined either:
  - The code field is rendered only in the `!joined` branch.
  - setCodeInput is called only from its onChange.
  - App mounts WatchView with key={route}, so a new #watch/CODE remounts the view (the unmount ends the session with close()).
- So the fallback is dead code that, if it ran, would give the code of the joined room. It is left in place, as instructed. Removing it would also take codeInput out of the reconnect effect's dependencies; that is a tidy-up for the owner.

4. fmp4RelayPlayer.js's raw fallback-consume-start: harmless
- What it is: after 15 s without an init segment (at most 3 times) the player sends fallback-consume-start with a raw callback, and re-arms its 15 s timer before it sends.
- Why it cannot break the ledger's ownership:
  - The player only runs while fallbackClaimRef holds the claim of the start that created it.
  - Every path that lets go of that claim while the viewer stays in the room on the same connection stops the player first, in the same synchronous block: exitFallbackMode, now also from recoverTransport; the terminal transport-failed branch; unmount.
  - The paths that drop the claim and stop the player later can only send the retry where the server refuses it with { error: 'Not an OBS room' } and subscribes nobody:
    - Leave Room: the retry follows leave-room on the same connection, and the leave-room handler is synchronous.
    - A reconnect: the new socket.id is in no room until the rejoin's join-room, and the rejoin stops the player before it joins.
    - A room that ended: the room is gone.
  - Emitted while disconnected, the retry is buffered by socket.io-client and sent first on the next connection: Socket.onconnect runs emitBuffered() before it emits 'connect', so it goes out before the rejoin's join-room. The server keeps no connection state across reconnects, so the new socket.id is in no room and the server refuses it.
  - A Leave Room whose leave-room fails leaves the viewer subscribed anyway, because dropFallbackClaim sends no stop. The retry adds nothing to that.
- Its answer and its silence are covered by the player's own tests (VAL-092/093 in tests/fmp4RelayPlayer.test.js):
  - an answer after stop() changes nothing (requestCurrentInit returns for a stopped player);
  - a lost answer ends in one 'error' after the retries, because the timer was re-armed before the send;
  - stop() clears the timers.
- The one thing it does on the server is re-assert this viewer's own subscription, which the server treats as idempotent, and start the relay if its worker is gone, which is the retry's purpose. Left in the player, untouched.

5. A late relay viewer's hole after the bootstrap
- Code: startRelayPlayback's media-chunk listener drops every chunk whose generation is not selectedGeneration, and that was null until the get-media-init answer. From the relay-consume-start answer on, the server sends the viewer every live chunk. Those chunks continue the bootstrap the answer carries, so the ones in between were lost: a hole after the bootstrap.
- Proof:
  - Browser test, unchanged code: the late viewer's get-media-init answer is held while about two slices of chunks arrive, then released. The host's slices are cut into 25 chunks at arbitrary byte offsets (lane/server's splitHostRelayChunks), so a hole cannot land on a WebM block boundary. Its video stayed at 0 s (2 of 2 runs).
  - A first version of the test without the split passed on the unchanged code: Chrome's WebM parser steps over a hole of whole blocks. That is why lane/server saw the failure in only 1 of 20 runs, the one with 25 chunks between the two answers.
- Fix:
  - lib/socket.js: the relay-consume-start answer carries `generation: room.mediaGeneration ?? null`. That is the generation of its bootstrap and of every live chunk after it; null for the first relay viewer, who waits for the new generation's media-init.
  - src/lib/timedAck.mjs: the request's promise takes `onAnswer(listener)`. The listener gets the answer in the answer's own dispatch, before any event that follows it on the connection.
    - Why the hook is needed: socket.io-client dispatches each decoded packet in its own microtask, in order, and the packets of one transport frame are queued together (HTTP long-polling carries several). Code that awaits the answer therefore resumes only after the chunks that came with it.
    - Selecting at the await would still lose those chunks over polling. Keeping every chunk until a generation is selected would double the ones that came before the answer, which are already in the bootstrap or belong to an earlier start of the same socket.
    - emitClaimedStart passes it through unchanged, and its call text is untouched, which TASK-091's source guard pins.
  - startRelayPlayback registers onAnswer right after the emit and selects the answer's generation there. The get-media-init answer and a live media-init select as before.
  - The bootstrap is prepended only while its generation is still the selected one. After a media-init of a newer generation the old bytes would sit in front of the new init.
- Not changed: lane/server's browser test that holds the host's chunks while its late viewer starts. It still passes; the hold is no longer needed, but it does no harm.

Tests added
- tests/browser/media-flow.spec.mjs: helper installAnswerControl, which holds or replaces the answer to the next request of one event (binary answers whole), hands the page a server event, and counts media chunks. Constant RECOVERABLE_TRANSPORT_FAILURE. Five tests:
  - 'a late relay viewer keeps the live chunks that arrive before its get-media-init answer' (5)
  - 'a Watch Stream start that fails while Leave Room waits for the server starts no relay, and Watch Stream then starts nothing' (2)
  - 'a transport failure while Leave Room waits for the server starts no recovery' (2)
  - 'a transport failure while the relay start is unanswered gives that start up and asks again, and the late answer starts nothing' (1; its second half also covers a running player)
  - 'Try WebRTC pressed while Leave Room waits for the server starts nothing' (2)
- tests/timedAck.test.js:
  - 'onAnswer gets the answer in its own dispatch, before the events after it and before anything awaiting the promise'
  - 'onAnswer listeners run once each, in order, and never for an answer after the timeout'
- tests/subscriptionLedger.test.js:
  - 'a claimed start hands its answer to onAnswer listeners before anything awaiting the acknowledgement'
  - a source guard for 5
- tests/socketRelayBootstrap.test.js: 'a relay start acknowledgement names the generation of its bootstrap and of the live chunks after it' (real server)
- tests/viewerSession.test.js: a source guard for 1 and 2
- No existing test was edited.

Before and after (shared scratchpad, watch-extra-gaps-*)
- Unchanged code, browser:
  - watch-extra-gaps-before-e2e.txt: the gap 2 tests failed with relay-consume-start + get-media-init (Watch), create-recv-transport ... consumer-resume (recovery) and the same for Try WebRTC. The gap 1 test failed with "asked for again" 1 of 2. The first gap 5 test, without the split, passed: why the split was added.
  - watch-extra-gaps-before-e2e-2.txt (revised gap 1 and gap 5 tests, --repeat-each=2): 4 of 4 failed. Gap 1 got 0 stops within 3 s. Before, the only stop came from the start's own 10 s answer timeout, which the first version of the test waited for. Gap 5: video at 0 s.
  - watch-extra-gaps-before-e2e-gap5.txt: the final gap 5 test on the unchanged source files, written over the lane's and restored afterwards (cmp-checked). 3 of 3 failed. The late viewer's console shows "Relay playback failed: The browser could not read the relay stream, so relay playback must be restarted."
- Unchanged code, unit:
  - watch-extra-gaps-before-unit.txt: 5 of 33 failed (the onAnswer tests, the generation socket test, the gap 5 source guard).
  - watch-extra-gaps-before-unit-session.txt: the gap 1/2 source guard failed ('before it waits for the server').
- After the fix:
  - watch-extra-gaps-after-new-e2e.txt: 5/5.
  - watch-extra-gaps-after-repeat.txt: the five new tests and lane/server's 240-chunk test, --repeat-each=4, 24/24.
    - An earlier repeat failed once. The test helper had handed the held answer over between a media-chunk's text frame and its attachment, which socket.io-client takes as a parse error and reconnects on.
    - The helper now waits for the end of a binary packet in passage. The unchanged-code gap 5 run above used the fixed helper.
  - watch-extra-gaps-after-full-e2e.txt (final tree, dev 50e67b7 + fix): run-e2e.cjs on the lane's ports, --workers=1, media-flow.spec.mjs 32/32 and ui-semantics.spec.mjs 93 passed (13 skipped, the mobile-chrome viewport skips), 125 passed.
  - npm run lint clean; npm run typecheck clean; npm test 1535/1535 (watch-extra-gaps-npmtest.txt).

For the owner
- Gap 3's dead fallback (and codeInput in the reconnect effect's dependencies) could be removed.
- The player-running case of gap 1 needs a transport-failed for a viewer the server already counts as a fallback viewer, which the server does not send today. It is covered all the same (the test's second half).
