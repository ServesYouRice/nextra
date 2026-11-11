# T53 — Host: choose the capture source with tabs and start from the stage

<model>
Model: `claude-sonnet-5-5`
Effort: `high`
Card: T53 in `../KANBAN.md`
Depends on: T43, T48 and T49 done
</model>

<role>
You are a React engineer reshaping the top of the host page. You move two
controls, keep every control name the tests use, and prove the result with a
browser test.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Screen 2 ·
Host, before you share", mockup "Proposed" (the tabs above the preview and
the button inside it). The spec below restates it; if the page cannot be
opened, this card stands alone.

Approved:

- "This browser" or "OBS" is the first choice on the page, shown as two tabs
  above the preview. Today it is the last tick box in the Settings card,
  labelled "Use OBS (WHIP ingest)".
- The Start button sits in the middle of the empty preview and is the one
  standout button on the page (`.btn-main` from T43). Today it is a small
  button under the preview that looks like a selected option.

This is the first of three host cards. T54 turns the settings into one calm
panel and T55 finishes the OBS options. This card must leave the page
consistent and every test green on its own.

What is there today (verified, `src/HostView.jsx`):

- Lines 2113-2134: `.video-container` with the `<video>` and an idle overlay
  (`status === 'idle'`).
- Lines 2136-2202: while not sharing, a `.controls` row with the Start button
  (`btn btn-primary btn-large`; its label is `Connecting...`,
  `Resume Sharing`, `Create new room` or `Start Sharing`) and, in OBS mode
  with "Apply recommended output settings" ticked, an unlabelled toggle
  `aria-label="OBS tuning profile"` (Balanced, Crisp, Max); then
  `.capture-settings` with the Resolution and Frame rate rows.
- Lines 2309-2326: the `#obsMode` checkbox row in the Settings card. It is
  disabled while `resumePending`, and then shows `resumeModeLockHint`
  ("Locked while the recovered room waits for Resume Sharing: it keeps the
  ingest mode it was created with.").
- `handleIngestModeChange('obs' | 'browser')` (lines 2078-2086) is the only
  way to change the mode. Keep using it.

Names and hooks the tests depend on (verified; keep all of them):

- Buttons `Start Sharing`, `Connecting...`, `Resume Sharing`,
  `Create new room`. The mockup says "Share my screen"; keep the current
  names, about 30 test lines use them.
- `page.locator('#obsMode').check()` in `tests/browser/ui-semantics.spec.mjs`
  (lines 244, 318, 374, 403) and `tests/browser/host-obs-control-channel.spec.mjs`
  (lines 174, 257, 270). Playwright's `check()` works on a radio button, so
  the OBS tab's input keeps the id `obsMode`. It must be the click target of
  its tab: give the input `position: absolute; inset: 0; opacity: 0; margin: 0`
  inside a `position: relative` tab. Do not clip it to one pixel; `check()`
  would then find it covered.
- `.settings-wrapper` gets the class `settings-expanded` in OBS mode and
  `.obs-config-panel` is then visible (`ui-semantics.spec.mjs` lines 245-246,
  319-320, 375, 404-405). Unchanged by this card.
- `.controls` must exist while not sharing:
  `settledBox(page, '.controls >> nth=0')` (`ui-semantics.spec.mjs` line 306).
- The text `keeps the ingest mode it was created with` must be visible while a
  recovered room waits (`tests/browser/host-reload-recovery.spec.mjs` line 437).

Test lines that pin the old design and must change (verified):

1. `tests/browser/host-reload-recovery.spec.mjs` line 435:
   `page.getByLabel('Use OBS (WHIP ingest)')` becomes
   `page.getByRole('radio', { name: 'OBS', exact: true })`. The four lines
   after it (disabled, forced click, not checked) stay as they are.
2. `tests/browser/ui-semantics.spec.mjs` line 259:
   `right('.controls .mode-toggle')` becomes
   `right('.capture-settings .mode-toggle[aria-label="Picture preset"]')`.
3. `tests/browser/ui-semantics.spec.mjs` lines 322-326: the expected groups
   `['OBS tuning profile', 'Resolution', 'Frame rate']` become
   `['Resolution', 'Frame rate', 'Picture preset']`.

Layout budget (verified by measurement): the host page fits 1366x768 and
1280x720 without scrolling, and the preview width is pinned by
`the host and watch video stages are unchanged at ...`. The row this card
removes from under the preview (about 56px) and the tabs row it adds above
(44px plus a 12px gap) cancel out. Do not change `--stage-chrome`.
</context>

<files>
Read: `src/HostView.jsx` lines 439-520 (state), 2051-2103, 2104-2330 (render
up to the OBS card).
Read: `src/index.css` lines 383-478 (buttons), 757-811 (`.mode-toggle`),
1286-1410 (stage, overlay, `.controls`, `.capture-settings`), 1472-1501.
Read: `tests/browser/ui-semantics.spec.mjs` lines 11-50, 232-328, 361-415.
Read: `tests/browser/host-reload-recovery.spec.mjs` lines 428-452.

Edit: `src/HostView.jsx` — the render between lines 2111 and 2202 (stage,
overlay, Start row, capture rows) and the `#obsMode` row at lines 2309-2326
(removed).
Edit: `src/index.css` — new rules `.source-tabs`, `.source-tab`,
`.source-tabs-hint` and `.host-stage-empty`, placed directly after the
`.host-video-section` rule (line 1485); the `.controls` rules (line 1355 and
inside `@media (max-width: 640px)`) only as far as the Start row needs.
Edit: `tests/browser/ui-semantics.spec.mjs` — lines 259 and 322-326 only.
Edit: `tests/browser/host-reload-recovery.spec.mjs` — line 435 only.
Create: `tests/browser/host-layout.spec.mjs`.

Do not touch: `.video-overlay` (the Watch page shares it; add the modifier
class instead), the sharing branch of the render (lines 2203-2256), the
Settings card rows other than `#obsMode`, the OBS card (lines 2329-2398),
`--stage-chrome`, `handleStartSharing`.
</files>

<task>
Above the preview there is a two-option control, "This browser" and "OBS",
that sets the capture source. The empty preview shows what will happen and
holds the Start button, which is the page's one standout button. The picture
preset is a labelled third row under the preview in OBS mode. All existing
host tests pass with the three listed edits.
</task>

<steps>
- Tabs, rendered while not sharing, as the first child of
  `.host-video-section`:
  `<div className="source-tabs" role="radiogroup" aria-label="Capture source">`
  with two `<label className="source-tab">`, each holding
  `<input type="radio" name="captureSource">`, a small inline icon
  (`aria-hidden="true"`) and its text: `This browser` (id `browserMode`) and
  `OBS` (id `obsMode`). `checked` follows `ingestMode`; `onChange` calls
  `handleIngestModeChange`; both are `disabled` while `resumePending`.
  Each tab is at least 44px tall; the selected tab uses
  `background: var(--surface-button)`; the group looks like `.mode-toggle`
  (line 758) but must not carry that class: `hostToggleCells` in
  `tests/browser/ui-semantics.spec.mjs` (lines 278-303) lists every
  `.mode-toggle` on the host page and compares the list exactly.
- To the right of the tabs, on the same row, one line of hint text in
  `var(--text-3)`: `Viewers just open a link` in browser mode,
  `Needs OBS Studio 28 or newer on this computer` in OBS mode. While
  `resumePending`, show `resumeModeLockHint` there instead. Below 640px the
  hint wraps under the tabs.
- Empty preview: replace the idle overlay with one shown while not sharing
  (`!isSharing`, so it also covers `status === 'connecting'`):
  `<div className="video-overlay host-stage-empty">` with an inline screen
  icon (`aria-hidden`), the title `Nothing is being shared yet`, the sub-line
  `You'll choose a screen, window or tab next.` (browser) or
  `Nextra sets OBS up and starts the stream.` (OBS), and
  `<div className="controls">` holding the Start button.
- Start button: same handler, `disabled` rule and four labels as today; class
  `btn btn-primary btn-main`.
- Move the tuning toggle out of `.controls` into `.capture-settings` as a
  third row after Frame rate: label `Picture preset`, group
  `aria-label="Picture preset"`, same buttons, same condition
  (`ingestMode === 'obs' && obsApplySettings`).
- Remove the `#obsMode` checkbox row from the Settings card.
- Below 640px hide the empty preview's icon and sub-line so the title and the
  button fit a 200px-tall preview.
- Apply the three test edits listed in `<context>`.
- `tests/browser/host-layout.spec.mjs` (no room is created). At 1440x900 on
  `/#host`:
  - a radiogroup named `Capture source` holds the radios `This browser`
    (checked) and `OBS`; `#obsMode` is an `input[type="radio"]`; each tab is
    at least 44px tall;
  - the button `Start Sharing` is inside `.video-container`, has the class
    `btn-main` and is at least 54px tall; it is the only `.btn-main` on the
    page;
  - the text `Nothing is being shared yet` is visible and the text
    `Use OBS (WHIP ingest)` has count 0;
  - choosing `OBS` (with `check()`) makes `.obs-config-panel` visible and
    shows a group named `Picture preset` after the `Frame rate` group in
    document order; choosing `This browser` hides both again;
  - with focus on the checked radio, pressing ArrowRight selects the other.

  At 390x844: the document does not scroll sideways and the Start button is
  fully inside `.video-container`.
</steps>

<constraints>
- Scope: the regions listed in `<files>`. The Settings and OBS cards keep
  their current look until T54 and T55.
- Keep every button name and hook listed in `<context>`.
- Use tokens and classes from T43; buttons keep their gradients; no new colour
  literal.
- No new dependency or icon library; icons are inline SVG.
- Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test. The three edits listed in `<context>`
  change assertions that pin the old layout; list them in your report.
- Match the surrounding code's naming, comments and indentation.
</constraints>

<acceptance_criteria>
- `#obsMode` is a radio button inside a radiogroup named `Capture source`,
  and `page.locator('#obsMode').check()` selects OBS.
- The Start button is inside `.video-container`, carries `.btn-main` and is at
  least 54px tall.
- The Settings card no longer has a "Use OBS" row.
- In OBS mode the groups on the page, in order, are Resolution, Frame rate,
  Picture preset.
- `tests/browser/ui-semantics.spec.mjs`, `host-reload-recovery.spec.mjs`,
  `host-obs-control-channel.spec.mjs` and `host-start-teardown.spec.mjs` pass
  with only the three listed edits.
- `git diff --name-only` lists exactly `src/HostView.jsx`, `src/index.css`,
  `tests/browser/ui-semantics.spec.mjs`,
  `tests/browser/host-reload-recovery.spec.mjs` and
  `tests/browser/host-layout.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npm run lint` and `npm run typecheck` — expected: exit 0.
2. `node --test tests/hostCopy.test.js` — expected: pass.
3. `npx playwright test tests/browser/host-layout.spec.mjs` — expected: pass.
4. `npx playwright test tests/browser/ui-semantics.spec.mjs` — expected: all
   pass in both projects.
5. `npx playwright test tests/browser/host-reload-recovery.spec.mjs tests/browser/host-obs-control-channel.spec.mjs tests/browser/host-start-teardown.spec.mjs`
   — expected: all pass.
6. `npx playwright test tests/browser/media-flow.spec.mjs -g "Host preflight|direct WebRTC and can rejoin|frame-rate control"`
   — expected: all pass.
7. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- `page.locator('#obsMode').check()` cannot be made to work on the radio
  without changing a test.
- A "fits a ... viewport without page scroll" or "video stages are unchanged"
  test fails; report the measured numbers instead of changing
  `--stage-chrome`.
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
