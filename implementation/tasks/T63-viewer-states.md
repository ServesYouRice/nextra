# T63 — Viewer: say what is happening while waiting, when the host drops out and when the stream ends

<model>
Model: `claude-opus-5-5`
Effort: `high`
Card: T63 in `../KANBAN.md`
Depends on: T62 done
</model>

<role>
You are a React engineer giving each state of the viewer's picture one clear
sentence and one next step. The messages are driven by socket events and read
by playback tests, so you keep the state logic and the pinned texts and
change how each state is presented.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Screen 7 ·
Viewer, when things change", the three tiles "Waiting for the host", "The
host drops out" and "The stream ends" (each has a "Now" and a "Proposed"
picture). The fourth tile, the wrong passphrase, is done (T46, T60). The spec
below restates the three; if the page cannot be opened, this card stands
alone.

Today (verified in the running app, before T47, T61 and T62):

- Waiting: dim grey text on the picture, "Waiting for host to start
  sharing...".
- Host drops out: a bare sentence from the server on the picture
  ("Host connection lost. Attempting reconnect..."), or, after T47, "The host
  dropped out". The picture behind it turns black or grey.
- Stream ends: a red error bar "Host stopped sharing" across the page and, on
  the picture, "This room has ended" in red. The only button is `Leave Room`.

Approved:

- Waiting: a readable title and one line saying the stream starts by itself.
- Host drops out: keep the last picture, dimmed, and say what is going on.
- Stream ends: ending is normal, so no red; two ways forward.

What is there after T47, T61 and T62 (find these by name in
`src/WatchView.jsx`; the line numbers in brackets are as of commit 67a095a):

- The overlays inside `.video-container` [1793-1827]: one while not watching
  (T61: `Starting the picture…`, or the `Watch Stream` retry button, or the
  waiting text with `The stream starts here by itself.`); one for
  `hostReconnectingReason` (a recoverable host disconnect); T47's overlay
  `The host dropped out` with `role="status"` while the picture is
  interrupted; one for `hostDisconnected` with
  `<p className="host-ended">This room has ended</p>`.
- `onRoomEnded` [881-900] sets `hostDisconnected` and
  `setError(reason || 'This room ended. Leave it and join a new room to continue.')`.
  The server's reason when the host stops is `Host stopped sharing`.
- `onHostDisconnected` [902-908] sets `hostReconnectingReason` for a
  recoverable disconnect; `onProducerClosed` [943-954] closes the consumer
  and rebuilds the stream without it, which blanks the picture.
- T62 renders `UserErrorAlert` (`id="watchError"`, `role="alert"`) in a stack
  at the top of the stage, and a control bar on the picture that always
  shows while nothing is playing and holds `Leave Room`.
- `handleLeave` leaves the room and shows the join card. Leaving the route
  unmounts the view, which leaves the room as well.

Names and hooks the tests depend on (verified; keep all of them):

- After the host stops, `viewerPage.getByRole('alert')` has exactly the text
  `Host stopped sharing` (`tests/browser/media-flow.spec.mjs` line 684), so
  exactly one `role="alert"` element holds exactly that text.
- `viewerPage.getByText(/This room has ended/)` is visible (line 739).
- The button `Leave Room` is pressed after a room ended (line 740) and
  must still return the viewer to the join card.
- T47's test expects `The host dropped out` visible, no `role="alert"`, and
  no `WebRTC mode active` while the picture is interrupted.
- T61's tests expect `The stream starts here by itself.` while waiting and
  the `Watch Stream` button after a failed start.
- Unit tests read `src/WatchView.jsx` as text. The body between
  `const onRoomEnded = ` and `const onHostDisconnected` must still contain
  `dropFallbackClaim()`; `viewerSession.invalidate()` must appear exactly
  five times in the file; do not rename, move or re-order the existing
  `useCallback` functions.

No test refers to `Waiting for host to start sharing`, to the server's
reconnect sentence on the viewer page, or to the class `host-ended`
(verified by search).
</context>

<files>
Read: `src/WatchView.jsx` — state, the effect with the room, host and
producer handlers, `handleLeave`, and the joined branch of the render as T62
left it.
Read: `src/lib/userError.mjs`, `src/components/UserErrorAlert.jsx`.
Read: `src/index.css` — the WATCH STAGE section T62 added, and lines
1327-1353 (`.video-overlay`, `.video-overlay-sub`, `.host-ended`).
Read: `tests/browser/media-flow.spec.mjs` lines 658-745 and T47's test
`a viewer is told when the host's picture stops and sees it return after Resume Sharing`.

Edit: `src/WatchView.jsx` — the overlays, one new state value for the reason
a room ended, one canvas element and the two places that fill it.
Edit: `src/index.css` — new rules at the end of the WATCH STAGE section.
Edit: `tests/browser/media-flow.spec.mjs` — add one test directly after
T47's test named above.

Do not touch: `.video-overlay`, `.video-overlay-sub` and `.host-ended` rules
(the Host page shares the first two, and the host cards edit the lines next
to the third; leave it unused, T67 removes it), the control bar (T62), the
join card (T60), `handleWatch`, `handleLeave`, the automatic start (T61),
the server.
</files>

<task>
Each state of the viewer's picture shows a readable title, one plain line and
the right next step: waiting for the host, the host dropped out (over the
last picture, dimmed), and the stream ended (calm, with `Join another room`
and `Home`). The pinned texts and roles stay.
</task>

<steps>
- Shared look: every state overlay keeps the class `video-overlay` and adds
  `watch-state`. Inside: `.watch-state-title` (`var(--fs-heading)`, weight
  600, `var(--text-1)`), `.watch-state-sub` (`var(--fs-small)`,
  `var(--text-2)`, at most `28rem` wide), and, where the state has actions,
  `.watch-state-actions` (a row with 12px gaps, 16px above it, wrapping at
  narrow widths). At 640px wide and below the title uses `var(--fs-body)`.
- Starting (T61's state): the title `Starting the picture…` with the
  spinner; `role="status"`.
- Waiting for the host (`hasProducer` false, not ended): title
  `Waiting for the host`; sub-line
  `You're in room XXX-XXX. The stream starts here by itself.`;
  `role="status"`. No button in the overlay: `Leave Room` is on the control
  bar.
- Start failed or stopped: the `Watch Stream` button with the classes
  `btn btn-primary btn-main`, and no pulse animation.
- The host dropped out, two cases with the same title `The host dropped out`
  and `role="status"`:
  - a recoverable host disconnect (`hostReconnectingReason` set): sub-line
    `Trying to reconnect. You don't need to do anything.` The server's
    sentence is no longer shown;
  - the picture is interrupted (T47's state): T47's sub-line, unchanged.
- The last picture: add `<canvas className="watch-last-frame" aria-hidden="true">`
  inside `.video-container`, behind the overlays and above the `<video>`,
  filling the stage with `object-fit: contain`. Draw the current video frame
  into it (canvas sized to `videoWidth` x `videoHeight`) at two moments:
  in `onProducerClosed`, before the video consumer is closed and the stream
  rebuilt; and when a recoverable `host-disconnected` arrives. Show the
  canvas only while one of the two "dropped out" states is on screen and a
  frame was drawn (`videoWidth > 0`); hide and clear it when the picture
  returns, when the room ends and on leave. Drawing must never throw into
  the handler: wrap it in `try`/`catch`.
- The stream ended (`hostDisconnected`):
  - keep `setError(...)` in `onRoomEnded` as it is, and also remember
    whether the server gave a reason;
  - do not render `UserErrorAlert` in this state. The overlay's title is
    `<p className="watch-state-title" role="alert" id="watchError">` holding
    the reason (for example `Host stopped sharing`), or `This room has ended`
    when the server gave none;
  - when a reason is shown, the sub-line reads `This room has ended.`;
  - actions: `<button className="btn btn-primary btn-main">Join another room</button>`,
    which calls `handleLeave`, and `<a href="#" className="btn btn-outline">Home</a>`;
  - nothing in this state is red: the title is `var(--text-1)`.
- New test in `tests/browser/media-flow.spec.mjs`,
  `a viewer is told what is happening while waiting, when the host drops out and when the stream ends`,
  written with plain `test(...)` and ending like its neighbours:
  1. The host ticks `Allow recovery after reload` and starts (as T47's test
     does). Viewer A runs `joinAndWatch`.
  2. The host page reloads. On A: `The host dropped out` is visible;
     `.watch-last-frame` is visible and its `width` property is greater than
     0; `getByRole('alert')` has count 0.
  3. Viewer B opens `` `/#watch/${code}` `` and presses `Join Room`. On B:
     the text `Waiting for the host` is visible with the computed colour
     `rgb(236, 236, 240)`; the sub-line contains the room code written as
     `XXX-XXX` and `The stream starts here by itself.`
  4. The host presses `Resume Sharing`. A and B both reach
     `WebRTC mode active`; on A `.watch-last-frame` is hidden.
  5. The host presses `Stop Sharing` and confirms. On A:
     `getByRole('alert')` has exactly the text `Host stopped sharing`, its
     computed colour is `rgb(236, 236, 240)`, `.alert-error` has count 0,
     `This room has ended` is visible, and `Join another room` leads to a
     visible `Join Room` button. On B: the link `Home` leads to the title
     `Nextra — Self-hosted screen sharing`.
  6. Poll `/api/metrics` until `rooms.active` is 0; close the contexts.
</steps>

<constraints>
- Scope: how the three states are presented, plus the last-frame canvas. When
  each state begins and ends does not change.
- Keep every hook listed in `<context>`: one `role="alert"` with exactly the
  server's reason when a room ends, the visible text `This room has ended`,
  `The host dropped out`, `The stream starts here by itself.`, the names
  `Leave Room` and `Watch Stream`.
- "The host dropped out" and "Waiting for the host" are statuses, not
  errors: `role="status"`, no call to `setError`.
- Use tokens and classes from T43; put new rules in the WATCH STAGE section
  only. No new colour literal, no new dependency.
- Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test; no existing assertion needs a
  change.
- Match the surrounding code's naming, comments and indentation.
</constraints>

<acceptance_criteria>
- Waiting, dropped out and ended each show a title in `var(--text-1)` and a
  sub-line in `var(--text-2)`.
- While the host is gone, the last picture stays behind the message.
- An ended room shows no red and offers `Join another room` and `Home`;
  `Leave Room` still works.
- Exactly one `role="alert"` holds exactly the server's reason after a room
  ended.
- Every existing test in `tests/browser/media-flow.spec.mjs` passes
  unchanged; the six unit tests that read `src/WatchView.jsx` pass.
- `git diff --name-only` lists exactly `src/WatchView.jsx`, `src/index.css`
  and `tests/browser/media-flow.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npm run lint` and `npm run typecheck` — expected: exit 0.
2. `node --test tests/viewerSession.test.js tests/mediaDebug.test.js tests/playbackAttempt.test.js tests/relayAppendQueue.test.js tests/subscriptionLedger.test.js tests/timedAck.test.js tests/mediaFlowLockHooks.test.js`
   — expected: all pass.
3. `npx playwright test tests/browser/media-flow.spec.mjs -g "told what is happening|host's picture stops|direct WebRTC and can rejoin|protected room"`
   — expected: all pass.
4. `npx playwright test tests/browser/media-flow.spec.mjs` — expected: the
   whole file passes. It takes several minutes; do not shorten it.
5. `npx playwright test tests/browser/ui-semantics.spec.mjs` — expected: all
   pass in both projects.
6. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- The video frame cannot be drawn to the canvas at either moment (for
  example the element already has no frame when `producer-closed` arrives).
- Keeping one `role="alert"` with exactly `Host stopped sharing` conflicts
  with another alert on the page.
- A room can end for a reason whose text is too long for a title; report the
  reasons you found in `lib/socket.js`.
</escalate_if>

<report_format>
Return exactly this, nothing else:

**Outcome:** done | blocked | escalated
**Changed:** file paths, or "none"
**Checks:** each command with its real result. Quote failing output verbatim.
Never report a check that was not run in this session.
**Blocker:** what stopped it, or "none"
**Next:** the card this unblocks, or what decision is needed
</report_format>
