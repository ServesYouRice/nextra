# T55 — Host: OBS options as plain rows in the settings panel

<model>
Model: `claude-sonnet-5-5`
Effort: `high`
Card: T55 in `../KANBAN.md`
Depends on: T54 done
</model>

<role>
You are a React engineer finishing the host settings panel for OBS mode. You
reorder and rename options without changing what they do, and prove the result
with browser tests.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Screen 3 ·
Host, using OBS", mockup "Proposed" (the panel on the right). The owner
approved it "as drawn". The spec below restates it; if the page cannot be
opened, this card stands alone.

Approved, in OBS mode the panel shows, top to bottom:

1. Resolution (1080p, 1440p, 4K)
2. Frame rate (30 fps, 60 fps)
3. Picture preset (Balanced, Crisp, Max)
4. OBS password
5. "More options" at the bottom, closed, holding "Set OBS up for me",
   "Start stream for me" and the AV1 mode.

Rows 1 to 3 are greyed out when "Set OBS up for me" is off.

Why Resolution and Frame rate belong here (verified, `src/HostView.jsx`
`buildObsAutoConfig`, lines 591-643): when `obsApplySettings` is on, Nextra
sets OBS's output width and height from the quality profile and its bitrate
from the profile and the frame rate, scaled by the tuning profile. When
`obsApplySettings` is off it sends none of that, so the three picture rows
have no effect: hence the grey-out. `obsApplySettings` is on by default.

State after T54: the panel exists and is aligned with the preview. In OBS
mode it shows Resolution, Frame rate, Picture preset, the room rows
(`Optional room passphrase`, `Allow recovery after reload`), then
`.obs-config-panel` with the old OBS controls in their old order and old
labels ("Apply recommended output settings", "Use BYOK TURN (AV1)",
"Auto-start streaming in OBS", "WS password"), then "More options".

Why the password stays visible (verified, `src/HostView.jsx` lines 350-370):
the OBS WebSocket password is kept in `sessionStorage` only, so a host whose
OBS asks for one types it in every new browser session.

Names, ids and hooks the tests depend on (verified; keep all of them):

- Ids `obsApplySettings`, `obsAutoStart`, `obsTryAv1`, `obsPassword`,
  `roomPassphrase`, `reloadRecoveryEnabled`, `allowMediaControl`.
- `#obsTryAv1` is in the document and disabled while a recovered browser room
  waits (`tests/browser/host-reload-recovery.spec.mjs` line 438). `toBeDisabled`
  does not need the control to be visible, so a closed "More options" is fine.
- `.obs-config-panel` is visible after `#obsMode` is chosen
  (`tests/browser/ui-semantics.spec.mjs` lines 246, 320, 405): keep that class
  on a visible element of the OBS rows, for example the OBS password row's
  wrapper.
- Groups named `Resolution`, `Frame rate`, `Picture preset`, in that order,
  inside an element with the class `capture-settings`.
- In browser mode the labels `Optional room passphrase` and
  `Allow recovery after reload` stay visible rows of the panel: several specs
  fill and tick them without opening anything. No test uses them in OBS mode.

Test lines that pin the old layout and must change (verified):
`tests/browser/host-obs-control-channel.spec.mjs` lines 175, 258 and 271 call
`page.locator('#obsApplySettings').uncheck()`. After this card that switch is
inside the closed "More options" disclosure, and `uncheck()` needs a visible
control. Add one helper to that spec that opens the disclosure
(`page.locator('#hostMoreOptions').evaluate((el) => { el.open = true; })`) and
then unchecks, and call it at those three lines. Nothing else in that spec
changes.

The How to Use page still names the old labels; T65 updates it.
</context>

<files>
Read: `src/HostView.jsx` lines 503-517 (OBS state), 591-643
(`buildObsAutoConfig`), 2068-2086 (`handleObsTryAv1Change`,
`handleIngestModeChange`), and the idle side column as T54 left it.
Read: `src/index.css` — the panel rules as T54 left them
(`.host-settings-panel`, `.setting-row*`, `.capture-settings`,
`.obs-config-panel`), and the `@media (max-height: 740px)` block.
Read: `tests/browser/host-layout.spec.mjs` (T53, T54).
Read: `tests/browser/host-obs-control-channel.spec.mjs` lines 166-280.

Edit: `src/HostView.jsx` — the OBS-mode rows of the panel and the contents of
"More options".
Edit: `src/index.css` — rules for the disabled picture rows and, if needed,
row spacing inside `@media (max-height: 740px)`.
Edit: `tests/browser/host-obs-control-channel.spec.mjs` — one helper and the
three call sites.
Edit: `tests/browser/host-layout.spec.mjs` — add tests.

Do not touch: `buildObsAutoConfig`, `handleObsTryAv1Change`, the TURN dialog
(lines 2555-2685 as of commit 67a095a), the browser-mode rows from T54, the
sharing branch of the render, `src/lib/hostPreflight.mjs`.
</files>

<task>
In OBS mode the panel shows Resolution, Frame rate, Picture preset and OBS
password as four even rows, with every other option behind "More options",
all under plain names. Turning "Set OBS up for me" off greys out the three
picture rows. The panel keeps the preview's top and bottom edges.
</task>

<steps>
- Give the panel's disclosure the id `hostMoreOptions` (both capture modes).
- OBS mode, visible rows, one group, rows 11px apart, no hairline between
  them:
  1. `Resolution`, 2. `Frame rate`, 3. `Picture preset` (always rendered in
  OBS mode now, not only when `obsApplySettings` is on),
  4. `OBS password` — label above, input id `obsPassword`, type `password`,
  placeholder `Leave blank if none`.
- OBS mode, inside `More options`, in this order:
  - switch `Set OBS up for me` (id `obsApplySettings`; still disabled while
    the AV1 mode is on, as today);
  - switch `Start stream for me` (id `obsAutoStart`);
  - switch `AV1 with my own TURN server` (id `obsTryAv1`; same handler and
    disabled rules as today; turning it on opens the existing dialog);
  - a hairline, then the room rows: `Optional room passphrase`,
    `Allow recovery after reload`, `Allow viewers to pause/play media`.
- Browser mode is unchanged from T54: the room rows are visible, and
  "More options" holds `Allow viewers to pause/play media`. The OBS controls
  stay in the document, hidden and inert.
- Grey-out: when `ingestMode === 'obs'` and `obsApplySettings` is off, the
  three picture groups get `aria-disabled="true"`, their buttons get
  `disabled`, the rows drop to `opacity: 0.45`, and one line appears under
  them: `OBS keeps its own picture settings.` (13px, `var(--text-3)`).
- Keep each option's long explanation (the old hint text) as the label's
  `title` and as a visually hidden description, as T54 did for the room rows.
  Keep the two existing extra notes for the AV1 switch (the recovered-room
  lock and "Disabled for public sharing: ...") the same way.
- At 1280x720 the four rows and "More options" must all be visible without
  scrolling inside the panel; tighten row gaps inside
  `@media (max-height: 740px)` if needed (8px between rows, 4px between a
  label and its control). When "More options" is open its content scrolls
  inside the panel.
- Apply the test edit described in `<context>`.
- Add to `tests/browser/host-layout.spec.mjs`, after choosing OBS at
  1440x900:
  - the visible row labels inside `.host-settings-panel`, in order, are
    `Resolution`, `Frame rate`, `Picture preset`, `OBS password`,
    `More options`;
  - the Resolution row and the Frame rate row have the same height as the
    same rows in browser mode (measure both modes, compare within 1px);
  - `#obsApplySettings`, `#obsAutoStart` and `#obsTryAv1` are not visible
    until `More options` is opened, then they are, with the labels
    `Set OBS up for me`, `Start stream for me` and
    `AV1 with my own TURN server`;
  - after unticking `Set OBS up for me`, every button in the three picture
    groups is disabled and the text `OBS keeps its own picture settings.` is
    visible; ticking it again enables them;
  - the texts `WS password`, `BYOK`, `WHIP ingest` and
    `Apply recommended output settings` have count 0 inside the panel;
  - at 1440x900 and 1280x720 the panel's top and bottom still equal the
    preview's within 1px, and at 1280x720 the rows area does not scroll
    (`scrollHeight <= clientHeight + 1`) while "More options" is closed.
</steps>

<constraints>
- Scope: labels, order and placement of the OBS options, and the grey-out.
  No option is added or removed and no handler changes.
- Keep every id, class and group name listed in `<context>`.
- Rows 1 and 2 use exactly the markup and classes of the same rows in browser
  mode; do not fork their styles.
- Use the tokens from T43; the selected option keeps its gradient; no new
  colour literal.
- Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test. The three call sites named above
  change because the switch moved behind a disclosure; say so in your report.
- Match the surrounding code's naming, comments and indentation.
</constraints>

<acceptance_criteria>
- In OBS mode the panel's visible rows are Resolution, Frame rate, Picture
  preset, OBS password, More options, in that order.
- "Set OBS up for me", "Start stream for me" and "AV1 with my own TURN
  server" are inside `#hostMoreOptions`.
- With "Set OBS up for me" off, the three picture groups are disabled and the
  explanatory line shows.
- The panel's top and bottom equal the preview's within 1px at 1440x900 and
  1280x720 in OBS mode.
- `tests/browser/host-obs-control-channel.spec.mjs` passes with only the
  helper and three call sites changed; `ui-semantics`,
  `host-reload-recovery` and `host-start-teardown` pass unchanged.
- `git diff --name-only` lists exactly `src/HostView.jsx`, `src/index.css`,
  `tests/browser/host-obs-control-channel.spec.mjs` and
  `tests/browser/host-layout.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npm run lint` and `npm run typecheck` — expected: exit 0.
2. `npx playwright test tests/browser/host-layout.spec.mjs` — expected: all
   pass. Quote the measured top and bottom values for OBS mode at 1440x900
   and 1280x720.
3. `npx playwright test tests/browser/host-obs-control-channel.spec.mjs tests/browser/host-reload-recovery.spec.mjs tests/browser/host-start-teardown.spec.mjs`
   — expected: all pass.
4. `npx playwright test tests/browser/ui-semantics.spec.mjs` — expected: all
   pass in both projects.
5. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- The four rows and "More options" cannot fit a 1280x720 panel without
  scrolling even with the tighter gaps.
- An OBS option turns out to be read by a test through its old label text.
- The grey-out would have to change what `buildObsAutoConfig` sends.
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
