# T57 — Host: one status line, a quality menu and a quiet Stop while sharing

<model>
Model: `claude-sonnet-5-5`
Effort: `high`
Card: T57 in `../KANBAN.md`
Depends on: T56 done
</model>

<role>
You are a React engineer tidying the controls a host sees while sharing. Many
browser tests wait on this part of the page, so you keep the text and names
they use and change only what the approved layout needs.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Screen 4 ·
Host, while sharing", mockup "Proposed, three links" (the line under the
preview and the button under the card). The spec below restates it; if the
page cannot be opened, this card stands alone.

Today (verified, `src/HostView.jsx` lines 2203-2256): under the preview there
is a `.controls` row with a red `Stop Sharing` button right next to two
unlabelled toggles (Resolution, only in browser mode, and Frame rate), and
below it `.status-bar`, a small grey line reading
`Streaming (1440p @ 60fps)` plus, when relevant,
`| Relay fallback viewers: N` and
`| Relay lowered to X Mbps (connection too slow for full quality)`.

Approved:

- One quiet line under the preview: a red dot, `Live`, a running timer, and
  the viewer count on the left; one small quality button on the right.
- Resolution and Frame rate fold into a menu behind that button, because
  changing them while live is rare.
- Stop is a quiet button under the invite card, away from the quality
  control. Stopping while viewers are connected still asks first; that dialog
  already exists and does not change.

Decisions already made for you:

- Wording stays the app's own where tests pin it: the button is
  `Stop Sharing` (the mockup shows "Stop sharing") and the count reads
  "N viewer" / "N viewers" (the mockup shows "2 watching").
- The sentence `Streaming (<resolution> @ <fps>fps)` is how 17 test lines in
  five files know that sharing has started, and one test waits for
  `Streaming (... @ 30fps)` after a frame-rate change. Keep that exact
  sentence, with its optional relay parts, as a polite status for assistive
  technology in a `.visually-hidden` element with `role="status"`. Verified:
  Playwright treats such a one-pixel element as visible, so those tests keep
  passing untouched. Sighted hosts read the new line instead.

Hooks the tests depend on (verified; keep all of them):

- `getByText(/Streaming \(/)` visible while sharing:
  `tests/browser/media-flow.spec.mjs` lines 55, 788, 845, 865, 878;
  `tests/browser/ui-semantics.spec.mjs` lines 353, 442, 543;
  `tests/browser/host-reload-recovery.spec.mjs` lines 369, 404, 447, 532, 634;
  `tests/browser/packaged-media.packaged.mjs` line 40.
- The button `Stop Sharing` on the page (about 40 uses) and, inside the
  dialog, `getByRole('dialog').getByRole('button', { name: 'Stop Sharing' })`.
- `page.locator('.viewer-count')` contains `1 viewer`
  (`host-reload-recovery.spec.mjs` line 638).
- `.controls` exists while sharing (`ui-semantics.spec.mjs` line 306 measures
  `.controls >> nth=0`).
- The text `Streaming via OBS` on the preview in OBS mode.
- Groups named `Resolution` and `Frame rate` whose buttons carry
  `aria-pressed`. While sharing they must be the only elements on the page
  with the class `mode-toggle`, in that order: `hostToggleCells` in
  `tests/browser/ui-semantics.spec.mjs` (lines 278-303) lists every
  `.mode-toggle` and compares the list exactly. Do not give the quality
  button or the menu that class.

Test lines that pin the old layout and must change (verified). Each needs one
added line that opens the quality menu first, because the two groups are now
inside it and hidden until it opens:

1. `tests/browser/media-flow.spec.mjs`, test
   `the streaming frame-rate control is a labelled group with programmatic selection`
   (lines 773-804): open the menu before the first assertion on the group
   (line 782).
2. `tests/browser/media-flow.spec.mjs` lines 1179-1180: open the menu before
   the click on the unpressed frame-rate button.
3. `tests/browser/ui-semantics.spec.mjs`, test
   `every live toggle cell is fully visible at every tested width while sharing`
   (lines 333-359): open the menu once after sharing has started (after line
   353). The menu must stay open while the viewport is resized, so the loop
   can measure it at every width.

`tests/mediaFlowLockHooks.test.js` imports `media-flow.spec.mjs` with a stub
`test` object; do not add `test.describe`, `test.use`, `test.skip` or
`test.step` at module level there.
</context>

<files>
Read: `src/HostView.jsx` lines 1432-1520 (`applyQualityProfileToLiveStream`),
2051-2066 (`handleStopSharing`), 2104-2260 and the sharing layout as T56 left
it, 2686-2759 (the two confirm dialogs).
Read: `src/index.css` lines 1355-1447 (`.controls`, `.status-bar`,
`.status-dot`) and the invite card rules T56 added.
Read: `tests/browser/host-live.spec.mjs` (T56),
`tests/browser/ui-semantics.spec.mjs` lines 270-359,
`tests/browser/media-flow.spec.mjs` lines 773-804 and 1170-1185.

Edit: `src/HostView.jsx` — the sharing branch of the controls (lines
2203-2256), a live timer (new state), and where `.viewer-count` is rendered
(it leaves the invite card).
Edit: `src/components/RoomSharePanel.jsx` or the `.room-info` block — only to
remove `.viewer-count` from the card.
Edit: `src/components/HostDiagnostics.jsx` — two added rows for the relay
facts that leave the status line.
Edit: `src/index.css` — `.controls` and `.status-bar` rules (and their media
query counterparts) and new rules for the status line and quality menu,
placed directly after `.status-bar`.
Edit: `tests/browser/media-flow.spec.mjs` and
`tests/browser/ui-semantics.spec.mjs` — the three added lines named above.
Edit: `tests/browser/host-live.spec.mjs` — add assertions to the shared-server
test.

Do not touch: the idle state, the invite card's rows, the confirm dialogs,
`handleStopSharing`, `applyQualityProfileToLiveStream`, the OBS overlay text.
</files>

<task>
While sharing, the host sees one line under the preview with `Live`, a timer
and the viewer count, a single quality button that opens Resolution and Frame
rate, and a quiet `Stop Sharing` button under the invite card. The old
`Streaming (...)` sentence remains as a screen-reader status.
</task>

<steps>
- Status line: `<div className="controls live-status">` directly under the
  preview, same left and right edges as the preview. Left part: a red dot
  (`aria-hidden`), the word `Live`, then ` · ` and a timer, then ` · ` and
  `<span className="viewer-count">` with "N viewer(s)" (and the existing
  "x WebRTC · y WHEP" split when WHEP viewers exist). Text
  `var(--fs-small)`, colour `var(--text-2)`; `Live` in `var(--text-1)`,
  weight 600.
- Timer: minutes and seconds since sharing started (`m:ss`, then `h:mm:ss`
  from one hour), updated once a second, `font-variant-numeric: tabular-nums`,
  marked `aria-hidden="true"` so it is not announced every second.
- Screen-reader status: keep today's `.status-bar` content, unchanged, in
  `<div className="visually-hidden" role="status">`.
- Quality button at the right end of the line:
  `<button type="button" className="btn btn-secondary quality-button"
  aria-haspopup="true" aria-expanded aria-controls="qualityMenu"
  aria-label="Quality: 1440p · 60 fps">` showing `1440p · 60 fps` and a small
  chevron. It opens `<div id="qualityMenu" className="quality-menu">`, a
  small panel (card gradient, 12px corners) above the button that holds the
  existing `Resolution` group (browser mode only, as today) and `Frame rate`
  group, each with a visible label. Closed, the menu has the `hidden`
  attribute. It closes on Escape (focus returns to the button), on a click
  outside, and when sharing stops; it stays open across a viewport resize.
  It must fit inside the viewport at 320px wide.
- Stop: `<button className="btn btn-danger-quiet">Stop Sharing</button>`,
  same handler, placed under the invite card and as wide as the card, 44px
  tall. Below 900px it is full width under the card. Remove the red
  `btn-danger` from the page; the confirm dialog keeps it.
- Move the two relay facts ("Relay fallback viewers", "Relay lowered to ...")
  into `HostDiagnostics` as rows `Relay viewers` and `Relay bitrate`.
- Apply the three test edits listed in `<context>`.
- Add to the shared-server test in `tests/browser/host-live.spec.mjs`:
  - `.live-status` shows `Live`; its timer matches `/\d+:\d{2}/` and shows a
    later time after 2 seconds; `.viewer-count` shows `0 viewers`;
  - an element with `role="status"` and the class `visually-hidden` contains
    `Streaming (`;
  - the quality button's name starts with `Quality`; while the menu is
    closed `getByRole('group', { name: 'Frame rate' })` has count 0; after a
    click the groups `Resolution` and `Frame rate` are visible; choosing
    `30 fps` changes the button text to end in `30 fps`; Escape closes the
    menu and focuses the button;
  - the page's `Stop Sharing` button has the class `btn-danger-quiet`, is at
    least 44px tall, and at 1440x900 its left and right edges equal the
    invite card's within 1px;
  - at 390x844 the status line, the quality button and Stop are inside the
    viewport and the document does not scroll sideways.
</steps>

<constraints>
- Scope: the live controls row, the status line, the quality menu and the
  Stop button's place and style. No change to what stopping or changing
  quality does.
- Keep every hook listed in `<context>`.
- Use tokens and classes from T43 (`.btn-danger-quiet`, `.btn-secondary`,
  `--fs-small`). Buttons keep gradients. No new colour literal except the
  live dot, which uses `var(--err)`.
- No new dependency.
- Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test. The three added lines are needed
  because the groups moved into a menu; list them in your report.
- Match the surrounding code's naming, comments and indentation.
</constraints>

<acceptance_criteria>
- While sharing, `.live-status` shows `Live`, a running timer and the viewer
  count; `.status-bar` is no longer visible text on the page.
- The sentence `Streaming (<resolution> @ <fps>fps)` exists in a
  `.visually-hidden` `role="status"` element and updates when quality changes.
- Resolution and Frame rate are reachable only through the quality button
  while sharing.
- `Stop Sharing` on the page is a `.btn-danger-quiet` button under the invite
  card.
- All browser specs pass with only the three listed lines added.
- `git diff --name-only` lists only files named in `<files>`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npm run lint` and `npm run typecheck` — expected: exit 0.
2. `node --test tests/mediaFlowLockHooks.test.js` — expected: pass.
3. `npx playwright test tests/browser/host-live.spec.mjs` — expected: pass.
4. `npx playwright test tests/browser/ui-semantics.spec.mjs` — expected: all
   pass in both projects.
5. `npx playwright test tests/browser/host-reload-recovery.spec.mjs tests/browser/host-obs-control-channel.spec.mjs tests/browser/host-start-teardown.spec.mjs`
   — expected: all pass.
6. `npx playwright test tests/browser/media-flow.spec.mjs` — expected: the
   whole file passes; nearly every test in it starts and stops a share.
7. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- A test cannot find `Streaming (` in the visually hidden status.
- The quality menu cannot fit a 320px viewport with both groups.
- Changing quality from the menu behaves differently from the old toggles.
- A test other than the three listed needs an edit.
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
