# T61 — Viewer: join and start the picture in one press

<model>
Model: `claude-opus-5-5`
Effort: `high`
Card: T61 in `../KANBAN.md`
Depends on: T60 done
</model>

<role>
You are a React engineer changing when a viewer's playback starts. The start
and stop paths of this page are tightly ordered and covered by many timing
tests, so you reuse the existing start function, add the smallest trigger for
it, and keep a switch that lets those tests reach the old two-step flow.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Screen 5 ·
Viewer, joining" (title "Join in one press", mockup "Proposed" and the
screenshot "Now after 'Join Room'"), and section "Screen 7", mockup "Waiting
for the host · Proposed". The spec below restates them; if the page cannot be
opened, this card stands alone.

Today (verified): a viewer presses `Join Room`, lands on a second view and
must press `Watch Stream` before anything plays. If the host has not started
yet, the view says "A Watch Stream button appears here once the host's media
starts."

Approved: one press joins and starts the picture. A viewer who is waiting for
the host gets the picture by itself when the host starts. A viewer who typed
the code on the home page and pressed Join there does not press Join again.

How it works today (verified, `src/WatchView.jsx`, line numbers as of commit
67a095a; earlier cards have edited this file, so find blocks by name):

- `handleJoin` (line 1049) ends a successful join inside
  `joinRoomAndLoadDevice` (line 986), which sets `joined` and `hasProducer`.
- `handleWatch` (line 1284) is the start. It returns at once when there is no
  current viewer session, sets `watchLoading`, tries WebRTC or the relay, and
  on failure sets an error and leaves the `Watch Stream` button for a retry.
- An effect headed "Auto-enter fallback mode for OBS rooms only when media is
  actually ready." (line 1226) already starts the relay by itself for an OBS
  room when `preferRelayFirst` is true. It must stay the only automatic start
  for that case.
- The socket handler `onNewProducer` (line 918) sets `hasProducer` and
  consumes a newly announced producer only when `watching` is already true
  and `playbackMode === 'mediasoup'`; otherwise it does nothing more.
- A WebRTC start reads the list of producers once (`get-producers`) after it
  has created its transport. The host produces video first and audio a
  moment later (`src/HostView.jsx` lines 1748-1771). A start that begins the
  instant the first producer is announced can therefore read the list before
  the audio producer exists, and the handler above drops the announcement
  that follows because `watching` is still false. With a person pressing a
  button this gap never mattered; with an automatic start it does, so this
  card closes it.
- A reconnect rejoins through its own path and resumes what the viewer was
  doing. That path must not be given a second automatic start.
- T52 added `src/lib/joinIntent.mjs`: the home page calls
  `rememberJoinIntent(code, storage)` before it navigates to `#watch/CODE`;
  `takeJoinIntent(code, storage)` returns `true` once for the same code
  within 10 seconds; `getSessionStorageSafely(window)` never throws.
- `src/lib/mediaDebug.mjs` holds the page's URL switches
  (`isMediaDebugEnabled`). `tests/mediaDebug.test.js` reads
  `src/WatchView.jsx` as text: it must not contain `window.localStorage` and
  must contain
  `isMediaDebugEnabled(window.location, getLocalStorageSafely(window))`.

Source text that unit tests pin (verified; keep all of it true):

- `setJoined(true)` appears exactly once in `src/WatchView.jsx`;
  `viewerSession.invalidate()` exactly five times;
  `startMediasoupPlayback({...})` is called exactly three times;
  `withDeadline(activePlaybackAttemptRef` appears exactly three times
  (`tests/viewerSession.test.js` lines 244 and 259,
  `tests/playbackAttempt.test.js` lines 399 and 404).
- Text between these markers is read as one function body, so nothing new
  may be inserted between them: `const handleTryMediasoup = useCallback(async () => {`
  to `const handleWatch`; `const handleWatch = useCallback(async () => {` to
  `const handleToggleMedia`; `const enterFallbackMode = useCallback(` to
  `Auto-enter fallback mode`; `const handleLeave = useCallback(async () => {`
  to `}, [cleanupPlayback, recoveryGuard`; `const onRoomEnded = ` to
  `const onHostDisconnected`.

Decision already made for you: a URL switch `?manualStart` keeps the old
two-step flow. About ten browser tests install a fault after `Join Room` and
before `Watch Stream`; with the switch they keep that gap by changing only
the address they open. Every other test, and every real viewer, gets the
one-press flow. The `Watch Stream` button stays in the product as the retry
after a failed or stopped start, which several tests assert.

Test lines that pin the two-step flow and must change (verified,
`tests/browser/media-flow.spec.mjs` unless another file is named; line
numbers as of commit 67a095a):

1. `joinAndWatch` (lines 77-88): add a third parameter
   `{ manualStart = false } = {}`. Without it, delete the `Watch Stream`
   click (line 80). With it, open `` `/?manualStart#watch/${code}` `` and
   keep the click.
2. `joinAndWatchRelay` (lines 374-385): delete the `Watch Stream` click
   (line 377).
3. Line 733, and the last expectation of T46's test
   `a wrong room passphrase is reported next to the field and can be corrected`:
   `Watch Stream` is no longer shown after a successful join. Replace each
   with `await expect(viewerPage.getByText(/WebRTC mode active/)).toBeVisible();`.
4. Lines 1010 and 1333: the address becomes
   `` `https://nextra.cloudflare.test:${serverPort(testInfo)}/?manualStart#watch/${code}` ``.
5. Lines 1296, 1410 and 1601: the address becomes
   `` `/?manualStart#watch/${code}` ``.
6. Line 1544: `joinAndWatch(viewerPage, code, { manualStart: true })`. This
   test leaves, joins again and expects nothing to play until it presses
   `Watch Stream`.
7. `tests/browser/ui-semantics.spec.mjs` line 465: delete the
   `Watch Stream` click.
8. `tests/browser/packaged-media.packaged.mjs` line 47: delete the
   `Watch Stream` click. This spec runs only against the packaged Windows and
   macOS builds and cannot be run here; say so in your report.

`tests/mediaFlowLockHooks.test.js` imports `media-flow.spec.mjs` with a stub
`test` object; add tests with plain `test('name', async (...) => { ... })`
and nothing from `test.describe`, `test.use`, `test.skip` or `test.step` at
module level.
</context>

<files>
Read: `src/WatchView.jsx` — state (lines 103-135), `playVideoElement`
(243-268), the effect at 880-976, `joinRoomAndLoadDevice`, `handleJoin`,
the "Auto-enter fallback mode" effect, `handleWatch`, `handleLeave`, and the
joined branch of the render.
Read: `src/lib/mediaDebug.mjs`, `tests/mediaDebug.test.js`,
`src/lib/joinIntent.mjs`.
Read: `tests/browser/media-flow.spec.mjs` lines 1-90, 370-390, 640-760,
855-895, and each line listed in `<context>` with 15 lines around it.
Read: `tests/viewerSession.test.js` lines 228-262 and 760-835,
`tests/playbackAttempt.test.js` lines 385-405.

Edit: `src/lib/mediaDebug.mjs` — add one exported function.
Edit: `tests/mediaDebug.test.js` — add one test.
Edit: `src/WatchView.jsx` — one new state value and one new ref, the success
path of `handleJoin`, `onNewProducer`, one new effect placed directly before
`const handleLeave = useCallback(`, a one-time effect for the home page's
join note, and the overlay shown while not watching.
Edit: `tests/browser/media-flow.spec.mjs` — the lines listed in `<context>`
and three new tests directly after the test
`a mobile Chrome viewer joins and receives decoded frames`.
Edit: `tests/browser/ui-semantics.spec.mjs` line 465;
`tests/browser/packaged-media.packaged.mjs` line 47.
Edit: `tests/browser/home.spec.mjs` — add one test.

Do not touch: `handleWatch`, `startMediasoupPlayback`, `startRelayPlayback`,
`enterFallbackMode`, the "Auto-enter fallback mode" effect, `handleLeave`,
the recovery and reconnect code, `joinRoomAndLoadDevice`, `src/index.css`
beyond one rule for the new status line, anything on the Host page.
</files>

<task>
After a successful `Join Room` (including the passphrase step), playback
starts by itself through the existing `handleWatch`; a viewer waiting for the
host is started when the host's media appears, with every track the host
sends; a join begun on the home page needs no second press. `Watch Stream`
remains as the retry after a failure, and `?manualStart` restores the
two-step flow.
</task>

<steps>
Order matters: the unit-level switch first, then the page, then the tests
that depend on both.

1. `src/lib/mediaDebug.mjs`: export `isManualStartRequested(locationLike)`,
   true when the query string has the key `manualStart`; it never throws.
   `tests/mediaDebug.test.js`: add
   `manualStart is read from the query string and nothing else`.
2. `src/WatchView.jsx`:
   - read the switch once (`isManualStartRequested(window.location)`);
   - add a state value `autoStartArmed`. `handleJoin` sets it to true after
     `joinRoomAndLoadDevice` resolved, unless the switch is on. Leaving the
     room, a room that ended and a failed join set it to false. A reconnect's
     rejoin never sets it;
   - add one effect directly before `const handleLeave = useCallback(`:
     when `autoStartArmed`, `joined`, `hasProducer`, and none of `watching`,
     `watchLoading`, `fallbackMode`, `hostDisconnected`, set
     `autoStartArmed` to false and, unless
     `ingestMode === 'obs' && preferRelayFirst` (the existing effect starts
     that case), call `handleWatch()`. It runs at most once per join;
   - `onNewProducer`: a producer announced while a WebRTC start is running
     (`watchLoading` true, `watching` false) is remembered in a ref; when
     that start has succeeded in WebRTC mode, consume each remembered
     producer that has no consumer yet, with the current attempt id, and
     clear the ref. Clear it as well wherever playback is cleaned up. Do not
     add a `startMediasoupPlayback({` call;
   - home page note: once, on mount, when the switch is off and
     `takeJoinIntent(normalizeRoomCode(initialCode), getSessionStorageSafely(window))`
     is true, call `handleJoin()`;
   - overlay while joined and not watching: while `autoStartArmed` or an
     automatic start is running, show a status line `Starting the picture…`
     (`role="status"`) with a small spinner and no button. When a start
     failed or playback stopped while the room is live, show the
     `Watch Stream` button as today. While waiting for the host
     (`hasProducer` false), the sub-line reads
     `You're in room XXX-XXX. The stream starts here by itself.` With the
     switch on, the overlay is exactly today's.
3. Apply the test edits listed in `<context>`.
4. New tests in `tests/browser/media-flow.spec.mjs`:
   - `Join Room starts the picture without a second press`: after
     `startHost`, the viewer opens `` `/#watch/${code}` `` and presses
     `Join Room`; `WebRTC mode active` becomes visible and the video has
     decoded frames (the poll used in `joinAndWatch`); the button
     `Watch Stream` has count 0. Ends like its neighbours.
   - `a viewer who is waiting gets picture and sound by itself when the host resumes`:
     the host uses a capture with a video and an audio track (extend the
     canvas stub in this test with an oscillator routed to
     `AudioContext.createMediaStreamDestination()`), ticks
     `Allow recovery after reload`, starts, reloads the page; a viewer then
     joins and sees `The stream starts here by itself.`; the host presses
     `Resume Sharing`; the viewer reaches `WebRTC mode active` without a
     press, and
     `video.srcObject.getVideoTracks().length` and
     `video.srcObject.getAudioTracks().length` are both 1.
   - `with ?manualStart a joined viewer waits for Watch Stream`: on
     `` `/?manualStart#watch/${code}` ``, after `Join Room` the button
     `Watch Stream` is enabled, `WebRTC mode active` has count 0 after one
     second, and pressing the button starts playback.
5. New test in `tests/browser/home.spec.mjs`:
   `joining from the home page does not ask for a second press`: typing
   `ZZZ999` and pressing Join lands on the Watch page with the alert that
   starts `No room has this code.` and no click on `Join Room`. (No room is
   needed: the automatic join is what produces that answer.)
</steps>

<constraints>
- Scope: when playback starts. How it starts, falls back, recovers and stops
  does not change.
- Every automatic action follows a user's press in the same visit (`Join
  Room`, or Join on the home page). Opening a link alone joins nothing.
- At most one automatic start per join; a failed start is never retried by
  itself.
- Keep every pinned count and marker listed in `<context>`.
- Keep the names `Join Room`, `Watch Stream`, `Leave Room` and the status
  texts `WebRTC mode active`, `relay mode active`, `Relay Mode (...) - ...`.
- No new dependency. Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test. The listed edits remove a press that
  no longer exists or opt a timing test into the two-step flow; list every
  edited line in your report, and say that the packaged spec was edited but
  not run.
- Match the surrounding code's naming, comments and indentation.
</constraints>

<acceptance_criteria>
- `Join Room` on a live room leads to a playing picture with no further
  press, in WebRTC and in relay mode.
- A viewer who joined before the host's media existed is started by itself
  and receives both tracks.
- A join begun on the home page continues without a second Join.
- After a failed start the `Watch Stream` button is offered and nothing
  restarts by itself.
- `?manualStart` gives the previous two-step behaviour.
- The six unit tests that read `src/WatchView.jsx` pass unchanged; the whole
  of `tests/browser/media-flow.spec.mjs` and
  `tests/browser/ui-semantics.spec.mjs` pass with only the listed edits.
- `git diff --name-only` lists only files named in `<files>`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npm run lint` and `npm run typecheck` — expected: exit 0.
2. `node --test tests/mediaDebug.test.js tests/joinIntent.test.js tests/viewerSession.test.js tests/playbackAttempt.test.js tests/relayAppendQueue.test.js tests/subscriptionLedger.test.js tests/timedAck.test.js tests/mediaFlowLockHooks.test.js`
   — expected: all pass.
3. `npx playwright test tests/browser/media-flow.spec.mjs -g "without a second press|waiting gets picture and sound|manualStart"`
   — expected: three tests pass.
4. `npx playwright test tests/browser/media-flow.spec.mjs` — expected: the
   whole file passes. It takes several minutes; do not shorten it.
5. `npx playwright test tests/browser/ui-semantics.spec.mjs tests/browser/home.spec.mjs tests/browser/viewer-join.spec.mjs`
   — expected: all pass in both projects.
6. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- A browser test other than the listed ones depends on the gap between
  `Join Room` and `Watch Stream`.
- The automatic start cannot be added without changing `handleWatch`, the
  "Auto-enter fallback mode" effect or a pinned count.
- The audio track of the waiting-viewer test cannot be produced in the test
  browser, or it arrives only some of the time after your change.
- The browser refuses to play after the automatic start in a way the existing
  muted-playback fallback in `playVideoElement` does not handle.
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
