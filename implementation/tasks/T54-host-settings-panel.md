# T54 — Host: one calm settings panel, aligned with the preview

<model>
Model: `claude-sonnet-5-5`
Effort: `high`
Card: T54 in `../KANBAN.md`
Depends on: T53 done
</model>

<role>
You are a front-end engineer replacing the host page's settings cards with one
quiet panel. You measure the layout, keep every control's name and id, and
prove the alignment with a browser test.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Screen 2 ·
Host, before you share", mockup "Proposed" (the panel on the right). The spec
below restates it; if the page cannot be opened, this card stands alone.

The owner's words about the earlier version of this sidebar: "too bubbly and
takes too much screen ... can it be a bit more peaceful and have its top and
bot lines match the screen windows top/bot". The approved result:

- One panel, 260px wide, to the right of the preview. Its top edge and bottom
  edge are exactly the preview's top and bottom edges.
- Calm: flat rows separated by hairlines, small controls, soft labels, 12px
  corners, no shadow, no glow, no hover lift. The card gradient is still
  there at half strength.
- Resolution and Frame rate live in the panel, not under the preview.
- Rarely used options sit behind "More options", which opens and scrolls
  inside the panel. The panel never grows taller than the preview.
- On a phone or tablet the page is one column and the panel fills its width.
  Today the Settings card is 304px wide in a 358px column on a phone, and at
  820px the preview stops at 720px and leaves a blank strip (both measured).

State after T53 (the card before this one): tabs and the Start button are in
place; `.capture-settings` under the preview holds the rows Resolution, Frame
rate and, in OBS mode, Picture preset; the side column still holds the old
Settings card and, in OBS mode, the old "OBS Configuration" card beside or
under it.

This card rebuilds the side column for both capture sources. It does not
change what the OBS options are: T55 reorders and renames them. Here the OBS
controls keep their current labels, ids, order and behaviour and simply
become rows of the same panel.

Measured today at 1440x900, 1366x768 and 1280x720 (verified): preview 720x405,
626x352 and 540x304; Settings card 304px wide and 475, 405 and 358px tall;
"Troubleshooting diagnostics" row 18px tall; the page is exactly as tall as
the viewport at all three sizes.

Names, ids and hooks the tests depend on (verified; keep all of them):

- Labels `Optional room passphrase` (id `roomPassphrase`) and
  `Allow recovery after reload` (id `reloadRecoveryEnabled`); the mockup's
  shorter labels are not used. `getByLabel(...).check()` and `.fill()` must
  work, so each checkbox stays a real `input[type="checkbox"]` that is its own
  click target (style the input itself as the switch; do not hide it).
- Ids `allowMediaControl`, `obsApplySettings`, `obsTryAv1`, `obsAutoStart`,
  `obsPassword`. `#obsTryAv1` must be in the document, and disabled, while a
  recovered browser room waits (`host-reload-recovery.spec.mjs` line 438), so
  the OBS rows stay rendered in browser mode, hidden and inert.
- Classes: `.host-side-panel` visible on `/#host`; `.settings-wrapper` with
  `settings-expanded` in OBS mode; `.obs-config-panel` visible in OBS mode;
  `.video-container`; `.controls`; `.mode-toggle` groups with the
  `aria-label`s `Resolution`, `Frame rate`, `Picture preset`; the selector
  `.capture-settings .mode-toggle[aria-label="Picture preset"]`, so keep the
  class `capture-settings` on the element that wraps those three rows.
- The text `Troubleshooting diagnostics` (exact), the button
  `Download redacted diagnostics` and `.host-diagnostics [role="status"]`.

Test lines that pin the old layout budget and must change (verified):
`tests/browser/ui-semantics.spec.mjs` lines 617-618,
`const hostChromeRem = height <= 820 ? 26 : 24;` and its comment. They restate
`--stage-chrome`. When you set new values for that token, put the same values
there. Nothing else in that test changes.
</context>

<files>
Read: `src/HostView.jsx` lines 2104-2400 and 2544-2553.
Read: `src/components/HostDiagnostics.jsx`.
Read: `src/index.css` lines 51-99 (layout tokens), 538-811 (panels, rows,
wrapper, toggles), 871-879, 1286-1410, 1472-1501, 2007-2313 (all media
queries).
Read: `tests/browser/ui-semantics.spec.mjs` lines 11-50, 232-415, 478-636.
Read: `tests/browser/host-layout.spec.mjs` (created by T53).

Edit: `src/HostView.jsx` — the idle side column (the block that starts at
`{status === 'idle' && (` inside `.host-side-panel`), the `.capture-settings`
block (moved into the panel) and where `<HostDiagnostics>` is placed.
Edit: `src/index.css` — the tokens `--host-side-card-width`,
`--host-panel-gap` and `--stage-chrome`; the rules for `.settings-panel`,
`.setting-row*`, `.settings-wrapper*`, `.obs-config-panel`, `.mode-toggle`
(a small variant), `.capture-settings`, `.host-layout`,
`.host-video-section`, `.host-side-panel`, `.host-diagnostics summary`; and
the rules for those selectors inside every media query from line 2007 on.
Edit: `tests/browser/ui-semantics.spec.mjs` — lines 617-618 only.
Edit: `tests/browser/host-layout.spec.mjs` — add tests.

Do not touch: the sharing branch of the render (`roomCode && (...)`, the
`.room-info` and `.streaming-info-row` blocks and their CSS; T56 owns them),
the tabs and the empty preview from T53, `.video-overlay`, `.watch-video`,
any handler or state in `HostView`.
</files>

<task>
While the host is not sharing, the page shows the preview and one 260px
settings panel whose top and bottom edges match the preview's, in both capture
modes, at desktop sizes; below 900px everything is one full-width column. All
picture options are in the panel, and the page still fits a 1366x768 and a
1280x720 screen without scrolling.
</task>

<steps>
- Layout from 900px up: the tabs row spans the preview and the panel; under
  it the preview (at most 800px wide) and the panel sit side by side with a
  gap of 18px, centred in the page; under them, aligned with the preview's
  left edge, the "Troubleshooting diagnostics" row.
- Panel element: keep `.settings-wrapper` as the outer element and add the
  class `host-settings-panel` to it. Width 260px (`--host-side-card-width:
  16.25rem`). Make the preview alone set the row height: give the panel
  `height: 0; min-height: 100%` inside a grid row, with a scrolling inner
  area (`overflow-y: auto`), so content can never make the panel taller than
  the preview.
- Panel look: `border-radius: var(--radius-lg)`;
  `border: 1px solid rgba(255, 255, 255, 0.06)`;
  `background: linear-gradient(180deg, rgba(35, 36, 46, 0.5), rgba(24, 24, 31, 0.5))`;
  no `box-shadow`; padding 13px 14px 11px; no hover change. Keep a heading
  for assistive technology only:
  `<h2 className="visually-hidden">Settings</h2>`.
- Rows are flat: no row background, no row border, no row radius. Groups of
  rows are separated by `1px solid rgba(255, 255, 255, 0.06)` with 11px above
  and below; rows inside a group are 11px apart.
- Row order in browser mode:
  1. `Resolution` — label above (13px, `var(--text-3)`), then a small
     segmented control (`.mode-toggle` with a small modifier: 2px padding, 8px
     corners, no shadow; buttons 13px, 5px by 6px padding, 6px corners; the
     selected button keeps `var(--surface-button)`). Options in the order
     1080p, 1440p, 4K.
  2. `Frame rate` — same, options 30 fps, 60 fps.
  3. (hairline)
  4. `Optional room passphrase` — label above, input 32px tall, 8px corners,
     placeholder `None`.
  5. `Allow recovery after reload` — one line: label left (12.5px,
     `var(--text-2)`), switch right. The switch is the checkbox itself:
     `appearance: none`, 32 by 18px, pill, track `#33333d`, knob 12px; when
     checked, track `var(--accent)`.
  6. `More options` — the last row, pinned to the bottom of the panel with a
     hairline above it: a `<details>` whose `<summary>` reads `More options`
     with a small chevron. Inside it: the switch row
     `Allow viewers to pause/play media` (disabled, with the note
     `Disabled by the server operator`, when the server does not allow it).
- The long hints of today's rows are no longer shown as text. Keep each as
  the row label's `title` and as a visually hidden description linked with
  `aria-describedby`.
- OBS mode: after row 2 the `Picture preset` row (same style, options
  Balanced, Crisp, Max) joins the `.capture-settings` group. After the room
  group, the element `.obs-config-panel` shows the four OBS controls as rows
  of this panel in their current order, with their current labels and ids:
  the three checkboxes as switch rows and `WS password` as a label-above
  field. In browser mode `.obs-config-panel` stays in the document with the
  `hidden` attribute and `inert`.
- Remove what the two-card layout needed and nothing uses any more: the
  second-column grid and slide transitions of `.settings-wrapper` and
  `.obs-config-panel`, the `.host-side-panel:has(...)` width rules for the
  idle state, and their counterparts in the media queries.
- Error and notice boxes (`<UserErrorAlert error={error} />`, the "Preflight
  notice" box and the bandwidth warning, lines 2402-2411) move out of the
  narrow side column into a full-width row directly under the preview and
  panel, above the diagnostics row. Their markup and roles do not change.
- "Troubleshooting diagnostics": make its `<summary>` row at least 44px tall.
- Below 900px: one column in this order: tabs, preview (full column width),
  panel (full column width, natural height, no inner scrolling),
  diagnostics. At 640px and below, every control in the panel (segmented
  buttons, the input, each switch row's label) is at least 44px tall.
- Budget: measure the page at 1440x900, 1366x768 and 1280x720 in both capture
  modes and set `--stage-chrome` (line 74 and the override inside
  `@media (max-height: 820px)`) to the smallest values that keep
  `scrollHeight <= innerHeight` at all three. Put the same two numbers in
  `tests/browser/ui-semantics.spec.mjs` lines 617-618 and update the comment.
- Add to `tests/browser/host-layout.spec.mjs` (no room is created):
  - for 1440x900, 1366x768 and 1280x720, in browser mode and after choosing
    OBS: the top of `.host-settings-panel` equals the top of
    `.video-container` within 1px, and the same for the bottom edges; the
    panel is 260px wide within 1px; the page does not scroll vertically
    beyond the height of any `.alert` on screen (same allowance as the
    existing "fits" test);
  - at 1440x900 the preview is at least 780px wide;
  - the groups `Resolution` and `Frame rate` are inside
    `.host-settings-panel`, and no `.mode-toggle` is outside it;
  - opening `More options` does not change the panel's height;
  - at 390x844 and 820x1180: the panel's width and the preview's width each
    equal the width of `.host-layout` within 1px, and the document does not
    scroll sideways;
  - at 390x844 every `button`, `input` and `summary` inside
    `.host-settings-panel` that is visible is at least 44px tall, counting a
    checkbox's wrapping `label` as its target.
</steps>

<constraints>
- Scope: the idle side column, the diagnostics row and the layout rules
  listed. No handler, state or behaviour changes.
- Keep every label, id, class and group name listed in `<context>`.
- Do not change which OBS options exist, their labels or their order; T55
  does that.
- Use the tokens from T43. The selected option and the Start button keep
  their gradients. The panel is the one deliberately quiet surface; do not
  flatten anything else.
- Dark theme only. No new dependency.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test. Lines 617-618 change because they
  restate the old layout budget; say so in your report with the old and new
  numbers.
- Match the surrounding code's naming, comments and indentation.
</constraints>

<acceptance_criteria>
- At 1440x900, 1366x768 and 1280x720, in both capture modes, the panel's top
  and bottom edges equal the preview's within 1px and the panel is 260px wide.
- The page does not scroll at those three sizes (alerts excepted).
- Resolution, Frame rate and, in OBS mode, Picture preset are inside the
  panel; nothing remains under the preview except the diagnostics row.
- At 390px and 820px wide the preview and the panel fill the column.
- At 390px wide every control in the panel is at least 44px tall.
- All existing tests in `ui-semantics`, `host-reload-recovery`,
  `host-obs-control-channel` and `host-start-teardown` pass, with only lines
  617-618 of `ui-semantics.spec.mjs` edited.
- `git diff --name-only` lists exactly `src/HostView.jsx`, `src/index.css`,
  `tests/browser/ui-semantics.spec.mjs` and
  `tests/browser/host-layout.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npm run lint` and `npm run typecheck` — expected: exit 0.
2. `npx playwright test tests/browser/host-layout.spec.mjs` — expected: all
   pass. Quote the measured top and bottom values for 1440x900 and 1280x720.
3. `npx playwright test tests/browser/ui-semantics.spec.mjs` — expected: all
   pass in both projects.
4. `npx playwright test tests/browser/host-reload-recovery.spec.mjs tests/browser/host-obs-control-channel.spec.mjs tests/browser/host-start-teardown.spec.mjs`
   — expected: all pass.
5. `npx playwright test tests/browser/media-flow.spec.mjs -g "protected room asks|reload recovery keeps the room code|frame-rate control"`
   — expected: all pass (they use the passphrase field, the recovery switch
   and the Frame rate group).
6. `npx playwright test tests/browser/ui-foundation.spec.mjs` — expected: pass.
7. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- The panel cannot match the preview's height at 1280x720 without hiding a
  row that is not behind "More options".
- The preview would have to drop below 560px wide at 1024px
  (`the host video stage stays usable`).
- A test other than lines 617-618 needs an edit.
- `getByLabel('Allow recovery after reload').check()` stops working with the
  switch styling.
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
