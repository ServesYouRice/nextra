# T47 — Tell viewers when the host's picture stops

<model>
Model: `claude-opus-5-5`
Effort: `high`
Card: T47 in `../KANBAN.md`
Depends on: none
</model>

<role>
You are a React engineer fixing a silent state in the viewer page. You write
the failing browser test first, then add the smallest state and message that
make the page tell the truth.
</role>

<context>
A viewer who is watching sees nothing useful when the host's picture goes away
but the room stays open. The video turns into a grey box with the browser's
spinner, and the line under it keeps saying
"WebRTC mode active (lowest latency)."

Reproduced on a build of this code (verified): the host ticks "Allow recovery
after reload" and starts sharing; a viewer joins and watches; the host reloads
the page. The viewer's socket then receives, in this order:

1. `host-disconnected` with `{ reason: 'Host connection lost. Attempting reconnect...', recoverable: true }`;
2. `host-reconnected` (the reloaded page reclaims the room at once);
3. `producer-closed` with `{ consumerId }`.

For at least 40 seconds after that the viewer page shows no overlay and no
alert, and `.media-status` still reads "WebRTC mode active (lowest latency).".
The host page meanwhile shows a Resume Sharing button.

Why (verified by reading `src/WatchView.jsx`):

- `onHostDisconnected` (lines 902-908) shows the reason while the host is
  away; `onHostReconnected` (lines 910-916) clears it a moment later.
- `onProducerClosed` (lines 943-954) closes the consumer and rebuilds the
  `MediaStream` without it. It sets no state, so `watching` stays true and
  `playbackStatus` (lines 1697-1705) keeps reporting an active stream.
- `onNewProducer` (lines 918-941) consumes a new producer when the viewer is
  watching over WebRTC. Assumption, not verified with a viewer page: after the
  host presses Resume Sharing this brings the picture back. The new test checks
  it; if it does not hold, that is an escalation.

The approved wording for this state (review page, section "Screen 7 · Viewer,
when things change", tile "The host drops out") is the heading
"The host dropped out". T63 later restyles all viewer states; this card only
makes the state visible and truthful.

Facts that constrain the change (verified):

- Six unit tests read `src/WatchView.jsx` as text and check function order and
  fragments: `tests/viewerSession.test.js`, `tests/mediaDebug.test.js`,
  `tests/playbackAttempt.test.js`, `tests/relayAppendQueue.test.js`,
  `tests/subscriptionLedger.test.js`, `tests/timedAck.test.js`. Do not rename,
  move or re-order the existing `useCallback` functions; add dependency entries
  at the end of an array only; `handleWatch` must still begin with
  `const session = viewerSession.current();` followed by
  `if (!session) return;`.
- `tests/mediaFlowLockHooks.test.js` imports `tests/browser/media-flow.spec.mjs`
  with a stub `test` that only has `beforeEach` and `afterEach`. Add tests with
  plain `test('name', async (...) => { ... })`; no `test.describe`, `test.use`,
  `test.skip` or `test.step` at module level.
- Many tests wait for the text `WebRTC mode active` as the sign that playback
  started. Its wording while a picture is playing must not change.
- T46 edits `handleJoin` (lines 1049-1105) and the join form JSX (lines
  1749-1776) and adds a test to the same spec at another place. Do not edit
  those regions.
</context>

<files>
Read: `src/WatchView.jsx` lines 103-140 (state), 273-335 (`consumeProducer`),
878-978 (room, host and producer handlers), 1284-1300 (`handleWatch` start),
1697-1705 (`playbackStatus`), 1779-1830 (stage and overlays).
Read: `src/hooks/useViewerSessionController.js` — `cleanupPlayback`, which
clears the consumers.
Read: `tests/browser/media-flow.spec.mjs` lines 9-88 (capture stub,
`readRoomCode`, `startHost`, `joinAndWatch`), 601-611 (`videoTime`,
`confirmStopIfPrompted`), 858-892 (the existing reload-recovery test, which
shows the host side of this flow).

Edit: `tests/browser/media-flow.spec.mjs` — add one test directly after the
test `reload recovery keeps the room code and concurrent stop/unmount is idempotent`
(after line 892).
Edit: `src/WatchView.jsx` — one new state value near line 112; the handlers in
lines 878-957; one line in `consumeProducer` or `onNewProducer` where a video
consumer is added again; one line near the start of `handleWatch`;
`playbackStatus` (lines 1697-1705); one new overlay block next to the existing
`hostReconnectingReason` overlay (lines 1815-1819).

Do not touch: `handleJoin`, the join form JSX, `lib/socket.js`,
`src/hooks/useViewerSessionController.js`, `src/index.css`.
</files>

<task>
While a viewer is watching over WebRTC and the room has no live picture, the
stage shows "The host dropped out" with a short line saying the picture will
come back by itself, and the status line no longer claims an active stream.
When the host resumes, the message goes away and the picture plays again.
</task>

<steps>
Order matters: the test must be seen failing against the unchanged source.

1. Add a test named
   `'a viewer is told when the host\'s picture stops and sees it return after Resume Sharing'`.
   Host side, as in the test at lines 858-892: install the display-capture
   stub, open `/#host`, tick `Allow recovery after reload`, press Start
   Sharing, wait for `/Streaming \(/`, read the room code. Viewer side:
   `joinAndWatch(viewerPage, code)`. Then reload the host page and expect on
   the viewer page, within 15 s:
   - `getByText('The host dropped out')` is visible;
   - `getByText(/WebRTC mode active/)` has count 0;
   - `getByRole('alert')` has count 0 (this is a status, not an error).

   Then press `Resume Sharing` on the host, wait for `/Streaming \(/`, and
   expect on the viewer: the message has count 0, `/WebRTC mode active/` is
   visible, and `videoTime(viewerPage)` grows by more than 1 second. End with
   Leave Room on the viewer, Stop Sharing and `confirmStopIfPrompted` on the
   host, and a poll of `/api/metrics` until `rooms.active` is 0; close both
   contexts.
2. Run `<verification>` step 1 and record the failure.
3. In `src/WatchView.jsx`, track whether the picture is interrupted: true once
   `onProducerClosed` leaves no video consumer while the viewer is watching
   over WebRTC; false again when a video consumer is added, when `handleWatch`
   starts a new playback, and when the room ends. The state must never be true
   while a live video consumer exists or while nothing is playing.
4. While it is true: render an overlay in the stage with
   `role="status"`, the text `The host dropped out` and the sub-line
   `Waiting for the picture to come back. You don't need to do anything.`
   (class `video-overlay`, sub-line class `video-overlay-sub`, like the
   overlays beside it); and make `playbackStatus` return
   `Waiting for the host's picture to come back.` instead of the
   "mode active" text.
5. Run the checks.
</steps>

<constraints>
- Scope: the viewer page's own state and one overlay. No server change, no new
  component, no CSS.
- The relay ("fallback") playback path is out of scope: it was not reproduced
  there. Do not change `fallbackMode` rendering.
- Do not show this state as an error: no `role="alert"`, no call to `setError`.
- Keep the exact strings `WebRTC mode active (lowest latency).`,
  `OBS WebRTC mode active (lowest latency).` and
  `Compatibility relay mode active (higher latency).` for a playing stream.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test.
- Match the surrounding code's naming, comments and four-space indentation.
</constraints>

<acceptance_criteria>
- The new test fails before the source change and passes after it.
- After the host reloads, the viewer page shows `The host dropped out` in an
  element with `role="status"` inside `.video-container`, and no text matching
  `/WebRTC mode active/`.
- After Resume Sharing the message is gone and the video's `currentTime`
  advances.
- The six unit tests that read `src/WatchView.jsx` and
  `tests/mediaFlowLockHooks.test.js` pass.
- `git diff --name-only` lists exactly `src/WatchView.jsx` and
  `tests/browser/media-flow.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npx playwright test tests/browser/media-flow.spec.mjs -g "host's picture stops"`
   before editing the source — expected: fails waiting for
   `The host dropped out`. Quote the failure.
2. The same command after the change — expected: pass.
3. `npx playwright test tests/browser/media-flow.spec.mjs -g "reload recovery keeps the room code|direct WebRTC and can rejoin|capture-track end"`
   — expected: pass.
4. `node --test tests/viewerSession.test.js tests/mediaDebug.test.js tests/playbackAttempt.test.js tests/relayAppendQueue.test.js tests/subscriptionLedger.test.js tests/timedAck.test.js tests/mediaFlowLockHooks.test.js`
   — expected: all pass.
5. `npm run lint` and `npm run typecheck` — expected: exit 0.
6. `npx playwright test tests/browser/media-flow.spec.mjs` — expected: the
   whole file passes; this change touches shared viewer state.
7. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- The new test passes before the source change.
- The viewer's socket does not receive the three events in `<context>` in that
  order when the host reloads.
- After Resume Sharing the viewer's picture does not come back even though the
  message logic is right. Report what the viewer page shows and which events
  it received; do not rewrite the recovery path in this card.
- A unit test that reads `src/WatchView.jsx` fails and the fix would need a
  function moved or renamed.
</escalate_if>

<report_format>
Return exactly this, nothing else:

**Outcome:** done | blocked | escalated
**Changed:** file paths, or "none"
**Checks:** each command with its real result. Quote the required pre-fix failure.
Never report a check that was not run in this session.
**Blocker:** what stopped it, or "none"
**Next:** the card this unblocks, or what decision is needed
</report_format>
