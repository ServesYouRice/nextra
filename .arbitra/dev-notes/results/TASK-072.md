TASK-072 (lane client): done, fixed. Commit 3c1c81e on lane/client, then merge ee7fe9a of dev (437b8f2) into the lane.

- Restart: HostView's recorder.onerror and onstop restart the current relay recorder whatever its format. The restart
  goes through stopRelayRecorder (safety-flush interval, silent audio track and context) and a new
  relayRecorderRestartToken state that the membership effect depends on. Events are ignored unless the recorder is
  still mediaRecorderRef.current and its generation is relayGenerationRef.current.
- stopRelayRecorder now clears mediaRecorderRef before it calls recorder.stop() (the prompt says this already
  happened; it happened after). Intentional stops are therefore never read as unexpected.
- Budget: allowRelayRecorderRestart(history, now, { max: 3, windowMs: 60000 }) and a small holder,
  createRelayRecorderRestartBudget(), in src/lib/relayRecorderFormat.mjs; one warning when it runs out; it resets when
  sharing ends. Once exhausted the relay stays down until relay viewers change (the membership effect starts a
  recorder again) or sharing restarts, as before this change.
- No restart when the capture's video track has ended (the recorder stops because of that, and the track's own
  'ended' handler tears the session down; Chromium also ends the tracks on pagehide during reload recovery).
- MP4 path: onerror still calls setRelayMp4Failed(true). A superseded MP4 recorder's late error no longer latches it.
- Prompt notes: no change to lib/socket.js, lib/relayMp4.js, fmp4RelayPlayer.js, server framing or bitrate policy.
  The prompt's `npm run build` would write dist (a link to the main checkout); I built with vite into the
  scratchpad instead (same command, `--outDir`).
- Seen, not changed (pre-existing): when relayMp4Failed flips, startRelayRecorder changes identity, so after the
  membership effect starts the VP8 recorder the parameter effect (which runs later in the same commit and sees a
  recorder) stops and starts it once more; by the spec the stop event follows the error in the same task and clears the ref first, so this (not run on a real fatal error)
  double start probably already happened. Reordering the two effects would remove it; left alone to keep the diff small.
- Merge note: dev's media-flow.spec.mjs now passes testInfo to joinAndWatchRelay; the new test follows that
  (done in the merge commit).
