# T66 — Phone: 44px tap targets on every page, with one test that checks them all

<model>
Model: `claude-sonnet-5-5`
Effort: `medium`
Card: T66 in `../KANBAN.md`
Depends on: T51, T52, T59, T63, T64 and T65 done
</model>

<role>
You are a front-end engineer closing out the phone layout. You write one
browser test that measures every control on every page at phone size, then
fix what it finds with small CSS rules that leave the desktop layout alone.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Screen 8 ·
Phone and small windows", the notes under "Proposed": "Every tap target is
at least 44px tall" and the checklist item "Tap targets of 44px for nav
links, footer links and fold-out rows". The spec below restates them; if the
page cannot be opened, this card stands alone.

Measured on the code before the redesign (verified, 390x844): footer links
42.8 by 18px; the fold-out row "Troubleshooting diagnostics" 18px tall;
ordinary buttons (`.btn`) about 40px tall. A thumb needs about 44px.

What the earlier cards already did (their own tests check these): the top
bar's links and menu button (T51), the home page's controls (T52), the host
settings panel and its fold-outs at 390px (T54), the join card (T60), the
viewer's phone controls (T62), the Status fold-out (T64), the guide's tabs
and questions (T65). This card covers what is left, mainly the footer,
plain buttons, copy buttons, the toast's close button and any fold-out row
those cards did not own, and adds the test that keeps all of it true.

Decision already made for you: the 44px minimum applies at 640px wide and
below, and on any device whose main pointer is a finger
(`@media (max-width: 640px), (pointer: coarse)`). With a mouse on a larger
screen the layout stays as compact as it is, because the Host page must keep
fitting a laptop screen without scrolling: the tests
`the host page fits a 1366x768 viewport without page scroll` and
`... 1280x720 ...` in `tests/browser/ui-semantics.spec.mjs` measure that,
and the footer's height is part of it.

Facts (verified):

- `--tap-min: 2.75rem` exists since T43.
- The footer (`src/App.jsx`, `<footer className="site-footer">`) holds a
  note and a `nav` named `Legal` with the links `Privacy` and
  `Copyright / Contact`; its rules are `.site-footer` to
  `.footer-links a.active` in `src/index.css` (lines 258-307 as of commit
  67a095a).
- A `summary` given `display: flex` loses its disclosure triangle in
  Chromium; pad it instead.
- The `mobile-chrome` project runs `tests/browser/ui-semantics.spec.mjs` on
  an emulated Pixel 5, whose pointer is coarse (verified). Rules behind
  `(pointer: coarse)` therefore apply in that project at every viewport size
  its tests set.
- A spec makes its own phone context with
  `browser.newContext({ baseURL: testInfo.project.use.baseURL, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })`
  (`tests/browser/ui-semantics.spec.mjs` lines 554-560 show the pattern).
- A link inside running text is exempt from the minimum (it sits in a line
  of text and cannot grow without breaking the line).
</context>

<files>
Read: `src/App.jsx` — the footer JSX and the "page not found" view.
Read: `src/index.css` lines 258-307 (footer), 383-478 (buttons), 969-1021
(copy field), 843-879 (toasts, diagnostics), and the two `@media` blocks
`(max-width: 640px)` and `(max-width: 400px)` at the end of the file.
Read: `tests/browser/ui-semantics.spec.mjs` lines 361-395 and 548-570.

Create: `tests/browser/tap-targets.spec.mjs`.
Edit: `src/index.css` — one new block headed
`/* ========== TOUCH TARGETS ========== */` placed directly before the
`/* ========== MODAL ========== */` comment, containing a single
`@media (max-width: 640px), (pointer: coarse)` block; and the footer rules
(lines 258-307) only if the footer's phone layout needs it.

Do not touch: any `.jsx` file (if a control cannot reach 44px with CSS
alone, escalate), the top bar rules (T51), `--tap-min`, the existing
`@media` blocks other than removing a rule this card supersedes.
</files>

<task>
At phone size and on touch devices every control on every page is at least
44px tall, the footer's links included, and a new browser test visits all
pages and proves it. With a mouse on a larger screen nothing changes size.
</task>

<steps>
Order matters: write the test first and read its failure list; it tells you
which rules are needed.

1. `tests/browser/tap-targets.spec.mjs`, one test per route in a phone
   context (390x844, `isMobile`, `hasTouch`), named
   `` `every control on ${route} is at least 44px tall on a phone` `` for
   `/`, `/#watch`, `/#how-to`, `/#host`, `/#status`, `/#privacy`,
   `/#copyright` and `/#no-such-page`. Each test:
   - waits until the route's own content is visible (the lazily loaded view,
     not only the shell): for example the heading on `/#how-to`, `.join-card`
     on `/#watch`, `.host-side-panel` on `/#host`, the heading
     `Server Status` on `/#status`;
   - opens the top bar's menu (`Menu` button) so its links are measured too;
   - collects every visible `a[href]`, `button`, `summary`, `select`,
     `[role="tab"]`, text-like `input`, and every `label` that wraps a
     checkbox or radio (the label is the target), in `header`, `main` and
     `footer`;
   - leaves out links inside running text (an `a` inside a `p`, `li`, `td`
     or `dd` that also contains other text) and the skip link;
   - fails with a list of `tag, text, width x height` for every element
     under 43.5px tall, or under 43.5px wide when it has no text;
   - asserts the document does not scroll sideways.
   On `/#how-to` also open each tab in turn and repeat the measurement; on
   `/#host` repeat it after choosing `OBS` and after opening
   `More options`.
2. Run the spec and record what fails.
3. Add the TOUCH TARGETS block. Inside
   `@media (max-width: 640px), (pointer: coarse)`, give a minimum height of
   `var(--tap-min)` to what the test listed. Expect at least: `.btn` and
   `.btn-small`; `.footer-links a` (as `inline-flex`, centred, with
   `padding-inline: 0.5rem`); `summary` (padding, not flex);
   `.copy-field-value` and the square copy buttons; the toast's close
   button (44 by 44px); `.select-input`. Do not set a height on anything
   the test did not list.
4. Footer at 640px wide and below: the note above the links, both centred,
   the links in one row; link text `var(--fs-small)` in `var(--text-2)`;
   the whole footer at most 120px tall at 390px wide.
5. Re-run until the spec passes, then run the rest of `<verification>`.
</steps>

<constraints>
- Scope: one new CSS block, the footer's phone layout and one new spec. No
  markup change.
- Nothing may change size for a mouse user above 640px wide: every new rule
  sits inside the media query above.
- Do not shrink text or padding elsewhere to make room.
- Use `var(--tap-min)`; no new colour literal.
- Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test; do not add exemptions to the new
  test beyond the two named in step 1. If a control cannot reach 44px,
  escalate with its name and size.
- Match the surrounding formatting.
</constraints>

<acceptance_criteria>
- `tests/browser/tap-targets.spec.mjs` passes for all eight routes.
- At 1440x900 and 1366x768 with a mouse, the footer, buttons and fold-out
  rows have the same heights as before this card.
- `tests/browser/ui-semantics.spec.mjs` passes unchanged in both projects.
- `git diff --name-only` lists exactly `src/index.css` and
  `tests/browser/tap-targets.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npx playwright test tests/browser/tap-targets.spec.mjs` before editing
   the CSS — expected: failures that list the undersized controls. Quote the
   lists.
2. The same command after the change — expected: eight tests pass.
3. `npm run lint` — expected: exit 0.
4. `npx playwright test tests/browser/ui-semantics.spec.mjs` — expected: all
   pass in both projects, in particular the two
   `fits a ... viewport without page scroll` tests and every
   `reflows without horizontal scrolling` test.
5. `npx playwright test tests/browser/shell-nav.spec.mjs tests/browser/home.spec.mjs tests/browser/host-layout.spec.mjs tests/browser/viewer-join.spec.mjs tests/browser/status-page.spec.mjs tests/browser/howto.spec.mjs`
   — expected: all pass.
6. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- A control cannot reach 44px without a markup change.
- A `mobile-chrome` test in `ui-semantics.spec.mjs` fails because a control
  grew under `(pointer: coarse)`.
- The footer cannot stay within 120px at 390px wide with 44px links.
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
