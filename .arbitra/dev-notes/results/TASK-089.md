TASK-089 (C-d20f555bcf10, C-bc451ddd2eaa): fixed on lane/watch (from dev 98e7a63), commit 0298db0.

What changed
- New `src/lib/relayAppendQueue.mjs` (`createRelayAppendQueue`), the append queue of the browser-host relay player in `startRelayPlayback`. One append at a time. A chunk and its bytes leave the queue only on the updateend of its own append. A QuotaExceededError evicts `remove(0, currentTime - 10)` and appends the same chunk again, once. Everything else that stops the stream is reported once through `onFailure`, after which nothing more is appended:
  - an overflow (MAX_QUEUE_CHUNKS 240 / MAX_QUEUE_BYTES 24 MB, unchanged);
  - a SourceBuffer still full after its eviction, or with nothing 10 s old to evict;
  - any other appendBuffer exception;
  - the SourceBuffer's 'error';
  - the MediaSource's 'sourceended'/'sourceclose', or a readyState other than 'open' when an append is due.
  `close()` (the attempt's cleanup, which runs before cleanupPlayback tears the MediaSource down) removes the listeners, so a cleanup-initiated sourceclose reports nothing. While the attempt is not current, every event is ignored.
- `failRelayGeneration`, in order:
  1. settles firstBuffered with the specific failure;
  2. cleans the attempt up (listeners, queue; its live-init and sourceopen waits now reject with the failure, not "cleaned up");
  3. releases its relay claim.
  Before playback is established it stops there: `startRelayPlayback` rejects with the failure, and handleWatch's fallback or the recovery decides what the viewer sees. `assertRelayRunning()` after every await covers a failure that happened while the start was waiting. Once playback is established it runs `cleanupPlayback()`, `setWatching(false)`, `setPlaybackMode('')` and `setError(failure.message)`. `setFallbackState('error')` is gone from this path.
- The SourceBuffer listeners in WatchView are replaced by `appendQueue.attach(sourceBuffer, mediaSource)`. The live-edge seek and play() on updateend are the queue's `onUpdateEnd` hook. The bootstrap snapshot goes in through `prepend`, and the safety interval calls `pump()`.
- `chunkQueueRef`/`queuedBytesRef` are removed from WatchView and `src/hooks/useViewerSessionController.js`, because each attempt owns its queue. The controller is in the prompt's read_first, but not in its list of files to change.

Proof
- Unchanged code (lane/watch 98e7a63, run-e2e.cjs on the lane's ports), scratchpad `watch-TASK-089-before-e2e.txt`. All three new media-flow tests failed:
  - Unreadable append: no alert in 10 s, and the snapshot still showed "Compatibility relay mode active".
  - Quota: the refused chunk was never appended again.
  - Overflow during the start: the alert read "Relay playback was cleaned up before media buffered."
- Unit file: ERR_MODULE_NOT_FOUND; the source-level test failed on WatchView's direct appendBuffer (`watch-TASK-089-before-unit.txt`).
- After the fix:
  - new tests pass;
  - whole media-flow spec 21/21 (`watch-TASK-089-after-media-flow.txt`);
  - new plus the two check-19 generation-switch tests 15/15 with --repeat-each=3 (`watch-TASK-089-after-repeat.txt`);
  - unit 13/13; npm run lint and typecheck clean; npm test 1431/1431 (`watch-TASK-089-npmtest.txt`).
- Probe: `watch-TASK-089-mse-probe.cjs.txt`, output in `watch-TASK-089-mse-probe-output.txt`. In Chromium, a corrupt WebM or MP4 chunk gives:
  1. the SourceBuffer's 'error', then updateend;
  2. MediaSource 'ended' and 'sourceended';
  3. video.error 3 (CHUNK_DEMUXER_ERROR_APPEND_FAILED);
  4. after that, appendBuffer throws InvalidStateError.
  A dropped WebM chunk can also pass without any error.

Where the prompt was off, and choices made
- Line numbers and quotes were stale (TASK-087/088 and check 19 had changed startRelayPlayback); the work started from the code as it stood.
- Step 1 "shift on updateend or after a successful synchronous append": the chunk is removed on its own updateend, the stricter of the two readings. The chunk being appended therefore still counts toward the 240/24 MB limits until its append ends, one chunk tighter than before.
- Step 3 MediaSource listeners live in the queue module, so the unit tests drive them. "Not initiated by cleanup" means the queue is closed by the attempt's cleanup before the MediaSource is detached; a stale attempt is ignored as well.
- Step 4: the relay-first path of handleWatch still shows the WebRTC fallback's error when both fail; it logs the relay failure (now the specific one) and takes the unsupported-format message from it, as before. Where the relay is the fallback (direct viewer) or the recovery's start, the specific message is shown.
- The verify commands say "ask before running"; per the brief they were run.
- No video element 'error' listener was added (the prompt names the SourceBuffer and MediaSource events; in the probe, every parse failure reached the SourceBuffer 'error' first).

For the owner
- A late relay viewer whose bootstrap snapshot holds more than 240 chunks overflows at its start. The server bounds the snapshot by bytes (24 MB) only, and at 300 ms timeslices that is about 72 s into a recorder generation. This is unchanged here, because the prompt keeps the limits. It is now reported as "fell behind" instead of "cleaned up".
- A new recorder generation whose init arrives during a Quota eviction's remove() makes abort() throw. prepareSourceBufferForGeneration then ends playback with "could not follow the new stream" (visible, and Watch Stream recovers). This is rare and new with the eviction.
- ui-semantics.spec.mjs was not run (the prompt names media-flow only).
