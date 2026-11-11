- [x] check 19 `C-9c4be8de5969` A new relay generation mid-playback is appended to the existing SourceBuffer without abort() or changeType(): **fixed** (claim holds; lane `client`, at dev 109f819, commit 231a8f8)

  - Where it is. The claim describes `src/WatchView.jsx` `startRelayPlayback`, the relay player for a browser host's
    MediaRecorder stream (`onMediaInit`, `selectedGeneration`, WebM and EBML). It is not about
    `src/lib/fmp4RelayPlayer.js`, the OBS fMP4 player. That one does not have the defect:
    - `handleMediaInit` calls `changeType` through `switchSourceBufferType`, or rebuilds the MediaSource.
    - Its chunks are whole moof+mdat fragments (`lib/fmp4Parser.js`), so its parser is always at a box boundary.
    - So the fix does not touch the fmp4 lane's file and does not overlap TASK-066, 067 or 076.
  - What the code did. `onMediaInit` (lines 497-513 before the fix) flushes the queue and moves `selectedGeneration`
    and `mimeType`. It leaves the SourceBuffer as it was: no `abort()`, no `changeType()`.
  - When it happens. Mid-stream generations are routine. `HostView.jsx` lines 1262-1301 restart the recorder on a
    frame-rate change, a resolution change, a bitrate change, and the MP4-to-VP8 fallback. `lib/socket.js` asks for
    that fallback (`relay-mp4-failed`) and expects viewers to "pick up" the new generation.
  - Proof, from a probe and from the app.
    - The probe (`check-19-mse-probe.cjs.txt`, output in `check-19-mse-probe-output.txt`) records with a real
      MediaRecorder. It replays the recording through a copy of WatchView's logic.
    - Chromium's recorder ends every timeslice one byte into the next WebM element. libwebm writes the ID byte by
      byte, and the slice is cut on that write.
    - Flushing queued old-generation chunks therefore leaves the parser inside an element. The SourceBuffer then
      takes all 13 appends of the new generation and buffers none of them: buffered stuck at [0, 2.42], no error,
      MediaSource open. With `abort()` it buffers to 6.1 s.
    - MP4 to VP8 without `changeType()` gives the same silent freeze (2.94 s against 7.04 s with the fix).
    - Firefox's recorder cuts at element boundaries, so VP8 recorded by Firefox survives the flush.
    - In the app, two new Playwright tests failed on the unchanged build, with the video frozen after the switch
      (`check-19-e2e-before.txt`):
      - MP4 to VP8: `Expected: > 4.528974 Received: 3.148159`.
      - A viewer behind across a frame-rate restart: `Expected: > 4.488… Received: 1.488292`.
    - Both pass with the fix, 3 of 3 repeats (`check-19-e2e-after.txt`).
  - Where the claim is off. It says the result is a parse error that ends the MediaSource. Chromium raises no error
    and keeps the MediaSource open. The picture freezes silently, and the queue never overflows, so no message is
    shown either.
  - Original code. `WatchView.jsx` is byte-identical at ac1c688. The host restart and server relay code is unchanged
    too. So the defect was real there as well.
  - The fix.
    - New `prepareSourceBufferForGeneration(sourceBuffer, mediaSource, { fromMimeType, toMimeType })` in
      `src/lib/watchPlaybackMode.mjs`: `abort()`, then `changeType()` when the type changes.
    - `onMediaInit` calls it once this attempt has a SourceBuffer.
    - On `false` (MediaSource not open, no `changeType`, or the type is refused) it ends the attempt through
      `failRelayGeneration`, with the unsupported-relay message or "Relay playback could not follow the new stream
      and must be restarted."
  - Tests.
    - Three unit tests in `tests/watchPlaybackMode.test.js`. They failed before only because the helper did not
      exist.
    - The two Playwright tests in `tests/browser/media-flow.spec.mjs`. They use two helpers that are new to the file:
      - `trackHostRecorders`: keeps the host's MediaRecorders, and can turn MP4 off.
      - `installHeldWebSocket`: holds the viewer's incoming messages and delivers them in one task, like a
        connection catching up.
  - Checks.
    - `npm run lint` and `npm run typecheck` clean. `npm test` 1054/1054.
    - `npx playwright test --workers=1`: 62 passed, 13 skipped, 3 failed. Server: my own vite build in the
      scratchpad, `NEXTRA_SMOKE_TEST=1`, port 3210, lock held.
    - The 3 failures are the tests in `tests/browser/host-obs-control-channel.spec.mjs`. They fail the same way on the
      unchanged build (also in `check-19-e2e-before.txt`), so they are not from this change. They need a look from
      whoever owns the OBS control channel.
    - With the default worker count, media-flow tests and host-start-teardown also fail. Those tests assert
      `rooms.active: 0` while other files create rooms in parallel. That is a property of the suite as it is. The new
      tests check only their own room.
  - Overlap for later tasks. TASK-089 and TASK-087 rework `startRelayPlayback`:
    - TASK-089 reworks `failRelayGeneration` and adds an append-queue module. The new failure path here goes through
      `failRelayGeneration`, so it will show its error properly once TASK-089 lands.
    - TASK-092 changes the media-flow lock in the same spec file as the new tests.
