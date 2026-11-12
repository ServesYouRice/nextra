# T62 — Viewer: give the picture the window and put the controls on it

<model>
Model: `claude-opus-5-5`
Effort: `high`
Card: T62 in `../KANBAN.md`
Depends on: T61 and T49 done
</model>

<role>
You are a React engineer replacing the browser's video bar and a row of
mismatched buttons with one control bar drawn on the picture. Playback tests
find these controls by name and read status text, so the names and that text
stay exactly as they are while their place and look change.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Screen 6 ·
Viewer, watching", mockup "Proposed opens like this", and section "Screen 8 ·
Phone and small windows", mockup "Proposed", second phone. The owner chose
"Opens with: Full window". The spec below restates both; if the page cannot
be opened, this card stands alone.

Today (verified in the running app):

- The `<video>` has the `controls` attribute, so the browser's own bar (play,
  0:00, a scrubber) shows on a live stream.
- Under the picture: `Mute Audio` (grey), `Fullscreen` (styled as the main
  action) and `Leave Room` (outline); then a grey line
  "WebRTC mode active (lowest latency)."; then, stuck to the left edge of the
  page, a fold-out "Connection quality: good".
- The page header ("Watch", "Join a room to watch a stream") stays above the
  picture after joining.
- After T49 the picture is as wide as the height budget allows:
  `.watch-video` sets `--stage-chrome: 19rem`.

Approved:

- The picture fills the window under the top bar.
- A LIVE badge and the room code sit on the picture, so people know they are
  in the right place.
- Sound, full screen and leave sit on the picture and fade when the pointer
  rests.
- The browser's own bar is off.
- One plain status chip; pressing it shows the numbers.
- A `Fit to page` button brings the picture back inside the page margins, at
  most 1040px wide.
- On a phone the picture keeps its margin and rounded corners, with three
  large controls side by side under it.

What is there (verified, `src/WatchView.jsx`, line numbers as of commit
67a095a; earlier cards have edited this file, so find blocks by name):

- The joined view (lines 1779-1917): `.video-container.watch-video` with the
  `<video>` and the overlays; two notices; `<div className="controls">` with
  the buttons; `.media-status` (`role="status"`) with `playbackStatus`;
  `<details className="connection-quality">`; a second `.media-status` for
  `mediaControlStatus`.
- `isFullscreen` is true when `document.fullscreenElement` is the `<video>`
  (line 202), and the button asks the `<video>` for full screen (lines
  1862-1882), with fallbacks `webkitRequestFullscreen` and
  `msRequestFullscreen`.
- `connectionQuality.quality` is `excellent`, `good`, `fair`, `poor` or
  `unknown` (`src/lib/connectionQuality.mjs`).
- A browser that blocks sound makes `playVideoElement` mute the video
  (lines 256-266); `isMuted` then shows `Unmute Audio`.

Names and hooks the tests depend on (verified; keep all of them):

- Button names: `Mute Audio` / `Unmute Audio`, `Fullscreen` (matched exactly)
  / `Exit Fullscreen` with `aria-pressed`, `Leave Room` (33 uses),
  `Try WebRTC`, `Switch to Relay Mode`, `Play/Pause Host Media`,
  `Watch Stream`. `Try WebRTC` must be visible without opening anything
  (`tests/browser/media-flow.spec.mjs` lines 1806, 1852, 1869, 1894).
- Status text found with `getByText`: `/WebRTC mode active/`,
  `/relay mode active/i`, `/Relay Mode \(.*\) - (connecting|buffering)/`,
  about 30 uses, some expecting it visible and some expecting count 0. Keep
  one element with `role="status"` that holds `playbackStatus` and is
  rendered only when the text is non-empty. It may carry the class
  `visually-hidden`: Playwright treats that one-pixel element as visible
  (verified).
- `viewerPage.locator('video')` must match one element, and tests read its
  `muted`, `srcObject`, `videoWidth` and `currentTime`.
- `page.getByRole('alert')` must match one element while an error shows.
- `.watch-video` is visible once joined, and `.video-container` is the
  16:9 stage that the stage tests measure
  (`tests/browser/ui-semantics.spec.mjs` lines 484-510, 571-592, 603-636).
- The full-screen test (`media-flow.spec.mjs` lines 747-771) replaces
  `HTMLElement.prototype.requestFullscreen` and `document.exitFullscreen`
  with stubs that set `document.fullscreenElement` and fire
  `fullscreenchange`; it works for any element.
- The six unit tests that read `src/WatchView.jsx` as text (listed in T61's
  card): do not rename, move or re-order the existing `useCallback`
  functions; add nothing between `const handleWatch = useCallback(async () => {`
  and `const handleToggleMedia`; keep the pinned counts.

Test lines that pin the old design and must change (verified):
`tests/browser/ui-semantics.spec.mjs`, in the loop
`the host and watch video stages are unchanged at ${width}x${height}`, the
watch expectation `stageWidthWithoutFloor(watch, { chromeRem: 19 })` (set by
T49) becomes `{ chromeRem: 7 }`, and its comment says that the watch page
keeps 7rem free for the top bar and its padding. Nothing else there changes.

Numbers to expect (computed from the stage rule, not yet run): at 1440x900
the picture is 1368px wide (the page's inner width); at 1366x768 about
1166px; at 1280x720 about 1081px. The page does not scroll at those sizes.
</context>

<files>
Read: `src/WatchView.jsx` lines 103-135, 194-270, `playbackStatus`, and the
joined branch of the render.
Read: `src/lib/connectionQuality.mjs`, `src/components/StatusPill.jsx`.
Read: `src/index.css` lines 1286-1365 (stage, overlay, `.controls`),
1449-1470 (`.media-status`, `.pulse`), 871-879 (`.connection-quality`), and
the `.watch-video`, `.controls` and `.video-container` rules inside the
media queries.
Read: `tests/browser/ui-semantics.spec.mjs` lines 478-636;
`tests/browser/media-flow.spec.mjs` lines 59-88 and 747-771.

Edit: `src/WatchView.jsx` — the joined branch of the render, the full-screen
state and button handler, and small new state for the control bar, the chip
and "fit to page".
Create: `src/lib/viewerStatus.mjs` and `tests/viewerStatus.test.js`.
Edit: `src/index.css` — `.watch-video` (line 1322); new rules in a block
headed `/* ========== WATCH STAGE ========== */` placed directly before the
`/* ========== HOST LAYOUT ========== */` comment. Put this card's
responsive rules in their own `@media` blocks inside that new section; do
not add to the shared `@media` blocks at the end of the file, which the host
cards are editing at the same time.
Edit: `tests/browser/ui-semantics.spec.mjs` — the one expectation and
comment named above.
Edit: `tests/browser/media-flow.spec.mjs` — add two tests directly after the
test `fullscreen control exposes pressed state and exits fullscreen`. They
go in this file, not a new one, because it gives every test its own source
address; the server allows only 10 new rooms a minute per address
(`config.js` line 322) and the other specs already use most of that.

Do not touch: `.video-container`, `.video-overlay`, `.controls`,
`.media-status` and `.connection-quality` rules (the Host page shares them;
add new classes instead), `handleWatch`, `handleLeave`, `handleToggleMedia`,
`enterFallbackMode`, `handleTryMediasoup`, the socket handlers, the join
card (T60), the overlay texts (T63 restyles them).
</files>

<task>
Once joined, the picture is as large as the window allows and carries its own
control bar with the room code, a LIVE badge, one status chip, sound, fit,
full screen and leave. The browser's video bar and the loose status lines are
gone from view. Phones get three large buttons under the picture. All
existing tests pass with the one listed edit.
</task>

<steps>
- `src/lib/viewerStatus.mjs`: export
  `describeViewerStatus({ watching, playbackMode, fallbackMode, fallbackState, quality, pictureInterrupted })`
  returning `{ label, tone }`:
  - not watching and not in fallback mode: `null`;
  - `pictureInterrupted`: `Reconnecting`, tone `warn`;
  - fallback mode with a state other than `playing`: `Connecting`, tone
    `info`;
  - relay or fallback playback: `Backup connection`, tone `info`;
  - WebRTC with quality `excellent` or `good`: `Good connection`, tone `ok`;
    `fair`: `Fair connection`, tone `warn`; `poor`: `Poor connection`, tone
    `err`; `unknown` or missing: `Connected`, tone `ok`.
  `tests/viewerStatus.test.js` (CommonJS, `node:test`, dynamic `import()`)
  covers each line. Read the real `fallbackState` values in
  `src/WatchView.jsx` before you write the fallback rule, and name them in
  the test.
- While joined, do not render `.view-header`, and give `.view-container` the
  extra class `watch-live` (block padding 12px). Remove the `controls`
  attribute from the `<video>`.
- Stage size: `.watch-video { --stage-chrome: 7rem; max-width: 100%; }`.
  With "fit to page" on, the stage also has the class `is-fit` and
  `max-width: 65rem`.
- Control bar: `<div className="watch-controls">` inside `.video-container`,
  along the bottom edge, over a bottom-to-top dark gradient
  (`rgba(10, 10, 12, 0.85)` to transparent, 96px tall), padding 12px 16px.
  Left group: a `LIVE` badge (shown while a picture is playing; white text
  on `var(--surface-button-stop)`, the dark red from T43 that keeps white
  text readable; `var(--fs-label)`, weight 700, pill), the room code in
  the mono font with its hyphen, and the status chip. Right group, in this
  order: `Play/Pause Host Media` (when allowed), `Switch to Relay Mode` or
  `Try WebRTC` (when today's conditions hold), the sound button, the fit
  button, the full-screen button, `Leave Room`.
  - Buttons are 44px tall. Sound, fit and full screen are icon buttons
    (inline SVG, `aria-hidden` icon) whose accessible names are today's:
    `Mute Audio` / `Unmute Audio`; `Fit to page` / `Fill window` with
    `aria-pressed`; `Fullscreen` / `Exit Fullscreen` with `aria-pressed`.
    `Leave Room` shows its text. All use the quiet button gradient
    (`.btn-secondary`); none is styled as the page's main button.
  - The bar is always shown while nothing is playing, while the pointer is
    over the stage, while focus is inside the stage, and for 3 seconds after
    the last pointer move, key press or touch on the stage. Otherwise it
    fades to `opacity: 0` over 200ms (no transition under
    `prefers-reduced-motion: reduce`). Hide it with opacity only: never
    `display: none`, `visibility: hidden` or `pointer-events: none`, so the
    keyboard, touch and the tests always reach the buttons.
- Status chip: a button showing a coloured dot and the label from
  `describeViewerStatus`, with `aria-expanded` and `aria-controls`. It opens
  a small panel above it (card gradient, 12px corners) that lists
  `RTT`, `Jitter` and `Packets lost` with today's formatting and the current
  `playbackStatus` sentence. Escape and a press outside close it. Remove the
  `<details className="connection-quality">` block from this page.
- Keep `playbackStatus` in
  `<div className="media-status visually-hidden" role="status">`, rendered
  only when non-empty. Keep the `mediaControlStatus` line visible, as a
  small line at the top of the stage.
- Sound blocked by the browser: when `playVideoElement` had to mute the
  video itself, show a chip on the picture, top centre, named
  `Tap for sound`, that unmutes. It disappears once the viewer unmutes or
  mutes by hand. The sound button keeps the name `Unmute Audio` in that
  state.
- Notices: render `UserErrorAlert` (`id="watchError"`), the "OBS
  disconnected" notice and the AV1 notice in one stack at the top of the
  stage (inside `.video-container`, centred, at most `min(90%, 40rem)`
  wide), with their current classes, roles and text.
- Full screen: ask the stage (`.video-container`) for full screen so the
  control bar stays with the picture, and treat `document.fullscreenElement`
  being the stage as "full screen". Keep today's fallbacks: when the stage
  cannot enter full screen, use the `<video>` element's own methods.
- 640px wide and below: the control bar is not laid over the picture. The
  picture keeps the page margin and 18px corners; under it sit one line with
  the LIVE badge, the status chip and the room code, then one row of three
  equal buttons with icon and text, each at least 48px tall: sound
  (`Mute Audio` / `Unmute Audio`), `Fullscreen`, `Leave Room`; the other
  buttons wrap below; then the hint
  `Turn your phone sideways, or press Fullscreen, for a bigger picture.`
  (`var(--fs-small)`, `var(--text-3)`), shown only in portrait. The fit
  button is not shown at this width.
- Apply the test edit listed in `<context>`.
- Two new tests in `tests/browser/media-flow.spec.mjs`, written with plain
  `test('name', async (...) => { ... })` (the file is also imported by
  `tests/mediaFlowLockHooks.test.js` with a stub `test`; nothing from
  `test.describe`, `test.use`, `test.skip` or `test.step` at module level).
  Each starts its own host with `startHost` and ends like its neighbours
  (Leave Room, Stop Sharing, `confirmStopIfPrompted`, poll `/api/metrics`
  until `rooms.active` is 0, close the contexts).
  - `the viewer's controls sit on the picture and the picture fills the window`,
    viewer context with a 1440x900 viewport, after `joinAndWatch`:
    - the `<video>` has no `controls` attribute; `.watch-controls` is inside
      `.video-container`; the stage's width equals the page's inner width
      within 1px and
      `document.documentElement.scrollHeight <= window.innerHeight`;
    - the text `LIVE` and the code written as `XXX-XXX` are visible on the
      stage; the chip reads one of `Good connection`, `Fair connection`,
      `Poor connection`, `Connected`; pressing it shows `RTT` and the
      sentence `WebRTC mode active (lowest latency).`; Escape closes it;
    - `Fit to page` narrows the stage to at most 1040px and its name becomes
      `Fill window`; pressing again restores the width;
    - the buttons `Mute Audio`, `Fullscreen` and `Leave Room` are each at
      least 44px tall and lie inside the stage's box;
    - with the mouse moved outside the stage and 4 seconds without input,
      `.watch-controls` has computed opacity `0`; moving the mouse over the
      stage brings it back to `1`; focusing `Leave Room` with the keyboard
      keeps it at `1`;
    - `.connection-quality` has count 0, and the `role="status"` element
      holding `WebRTC mode active` has the class `visually-hidden`.
  - `a phone viewer gets three large controls under the picture`, viewer
    context `{ ...devices['Pixel 5'] }` (already imported in this file),
    after `joinAndWatch`: the sound button, `Fullscreen` and `Leave Room`
    share one row below the stage's bottom edge, each at least 48px tall;
    the stage has a 16px margin on both sides; the hint
    `Turn your phone sideways, or press Fullscreen, for a bigger picture.`
    is visible; the document does not scroll sideways.
</steps>

<constraints>
- Scope: the joined view of the Watch page. Playback, recovery, leaving and
  the overlay texts do not change.
- Keep every name and hook listed in `<context>`.
- One `<video>` element; one `role="alert"` at a time.
- Use tokens and classes from T43. No new colour literal except the two
  `rgba(10, 10, 12, ...)` stops of the bar's gradient, which match the
  existing overlay colour. No new dependency; icons are inline SVG.
- Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test. The one changed expectation pins the
  old height budget; say so in your report.
- Match the surrounding code's naming, comments and indentation.
</constraints>

<acceptance_criteria>
- Joined, at 1440x900, 1366x768 and 1280x720, the picture uses the full
  inner width or the full height budget and the page does not scroll.
- The browser's video bar is gone; the control bar on the picture holds the
  room code, LIVE, the status chip, sound, fit, full screen and leave.
- The control bar fades after 3 seconds of rest and returns on pointer,
  touch or keyboard focus.
- Every button keeps its accessible name; `playbackStatus` is still exposed
  through one `role="status"` element.
- On a phone the three main controls sit in one row under the picture.
- Every existing test in `tests/browser/media-flow.spec.mjs` passes
  unchanged; `tests/browser/ui-semantics.spec.mjs` passes with the one
  listed edit.
- `git diff --name-only` lists exactly `src/WatchView.jsx`,
  `src/lib/viewerStatus.mjs`, `tests/viewerStatus.test.js`, `src/index.css`,
  `tests/browser/ui-semantics.spec.mjs` and
  `tests/browser/media-flow.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npm run lint` and `npm run typecheck` — expected: exit 0.
2. `node --test tests/viewerStatus.test.js tests/viewerSession.test.js tests/mediaDebug.test.js tests/playbackAttempt.test.js tests/relayAppendQueue.test.js tests/subscriptionLedger.test.js tests/timedAck.test.js tests/mediaFlowLockHooks.test.js`
   — expected: all pass.
3. `npx playwright test tests/browser/media-flow.spec.mjs -g "controls sit on the picture|three large controls|fullscreen control"`
   — expected: three tests pass.
4. `npx playwright test tests/browser/ui-semantics.spec.mjs` — expected: all
   pass in both projects.
5. `npx playwright test tests/browser/media-flow.spec.mjs` — expected: the
   whole file passes. It takes several minutes; do not shorten it.
6. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- A test cannot press a control because the faded bar does not count as
  visible or does not receive the click.
- A `getByText` status assertion fails with the status element visually
  hidden.
- The full-screen test fails when the stage, not the `<video>`, enters full
  screen.
- The picture cannot fill the window without the page scrolling at one of
  the three sizes; report the measured numbers.
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
