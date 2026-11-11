check 18 (C-4723a43516b4, lane depack, at dev 4daa571): the claim does not hold; no_change_needed, no file changed, no commit.

Verdict: the mechanism is as described (configureObsStream stops through the transaction, the StopStream gets a StartStream inverse, a failed setup replays it), but that is the rollback restoring the stream OBS had before the setup, which the code and the owner's own text intend. The StopStream is the first step journaled, so its StartStream is replayed last, after the previous service, video and profile values are back: OBS resumes its own earlier stream at its own target, not a broadcast to the Nextra room. Same on ac1c688.

How it was checked:
- Probe `check-18-probe.mjs.txt` (output `check-18-probe-output.txt`), run with `node check-18-probe.mjs.txt <obsWebSocket.js> <label>` against the lane's module and against ac1c688's `src/lib/obsWebSocket.js` + `obsOutputModel.mjs` copied into a scratch folder (`git show`, no worktree). A fake OBS keeps real stream and service state. OBS live at rtmp://live.example/app, setup fails for want of an AV1 encoder: rollback sends `SetStreamServiceSettings -> rtmp://live.example/app` then `StartStream at rtmp://live.example/app`; OBS ends where it began. OBS idle: nothing is restarted. Refused resolution: only a warning, setup commits, no rollback.
- Existing tests that pin the restart pass: `node --test tests/obsWebSocket.test.js tests/obsWebSocketWire.test.js` 52/52.

Where the claim is wrong besides the verdict:
- "Invalid credentials" cannot trigger it: a wrong OBS password fails at Identify, before the setup callback runs, so nothing has been stopped.
- "Bad resolution" cannot trigger it: a refused SetVideoSettings is a warning and the setup commits.
- Its implied fix (stop with rawSendRequest) would make a failed setup end the user's live broadcast for good. Only releaseStaleEncoder's own start/stop pair is housekeeping that a rollback should leave alone, and the code says so.

For the owner, not this defect:
- The rollback cannot tell a live broadcast from a stream that was only retrying a target that is gone (outputReconnecting). It restarts both, so in the second case OBS goes back to retrying the old target (probe case S3). In the start flow HostView stops that stream with the page (the control channel, or stopObsIngest after an AV1 failure).
- revision-1.7/TASK-079/Q-001 (kept at its default): when the service restore is refused, the final StartStream is still sent, and then it would start at the Nextra WHIP target.
