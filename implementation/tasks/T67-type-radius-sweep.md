# T67 — Bring every text size and corner radius onto the token scale

<model>
Model: `claude-sonnet-5-5`
Effort: `medium`
Card: T67 in `../KANBAN.md`
Depends on: T66 and T50 done
</model>

<role>
You are a front-end engineer finishing a design system. You replace the
stylesheet's leftover one-off sizes with six text sizes and four corner
sizes, guarded by a test that reads the stylesheet, and you keep every
layout test green while doing it.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Design
system strip" (type scale and corner sizes) and checklist item "Cut type
sizes to six and corner sizes to four of your own (8, 12, 18, pill)". The
spec below restates them; if the page cannot be opened, this card stands
alone.

T43 defined the scale in `:root` of `src/index.css`:

- Text: `--fs-display` (28 to 44px), `--fs-title` (28px), `--fs-heading`
  (20px), `--fs-body` (16px), `--fs-small` (14px), `--fs-label` (12px).
- Corners: `--radius` (8px), `--radius-lg` (12px), `--panel-shell-radius`
  (18px), `--radius-pill` (999px). `--radius-xl` (14px) was left for this
  card to remove.

Counted on the stylesheet before the redesign (verified, commit 67a095a):
77 `font-size` declarations with 29 different values, most between 0.65rem
and 0.9rem, so most text rendered at 10 to 14px; 31 `border-radius`
declarations with 10 different values, among them `4px`, `10px`, `24px`,
`22px 22px 18px 18px`, `999px` and three uses of `var(--radius-xl)`. The
cards since then added rules that should already use the tokens; this card
makes it true for the whole file and keeps it true.

Why this is delicate (verified): text size sets the height of rows, buttons
and bars, and several browser tests measure those: the top bar's height
(`tests/browser/shell-nav.spec.mjs`), the Host page fitting 1366x768 and
1280x720 without scrolling and the stage widths
(`tests/browser/ui-semantics.spec.mjs`), and the panel and card edges that
must match the preview within 1px (`tests/browser/host-layout.spec.mjs`,
`tests/browser/host-live.spec.mjs`). A size that grows by 1 or 2px can break
one of them.

`tests/designTokens.test.js` (from T43) already reads `src/index.css` as
text and checks the tokens and the contrast of `--text-3`.

Classes that earlier cards stopped using and left for this card to delete:
`.host-ended` (T63) and `.input-group` (T60). Confirm with a search of
`src/` before deleting each.
</context>

<files>
Read: `src/index.css` in full.
Read: `tests/designTokens.test.js`.
Read: `src/**/*.jsx` only by searching for a class name before you delete
its rule, and for inline `style` props that set `fontSize` or
`borderRadius`.

Edit: `tests/designTokens.test.js` — add the tests described below.
Edit: `src/index.css` — `font-size` and `border-radius` values throughout,
the `--radius-xl` token, and the two unused rules named above.

Do not touch: any `.jsx` file (if a size is set inline there, report it),
any browser spec, any property other than `font-size` and `border-radius`
(no padding, height or line-height changes to compensate; see
`<escalate_if>`).
</files>

<task>
Every `font-size` in the stylesheet is one of the six text tokens and every
`border-radius` is one of the four corner tokens (or 50% for a circle);
`--radius-xl` is gone; a unit test enforces both from now on; all layout
tests still pass.
</task>

<steps>
Order matters: the test first. Its failure output is the work list.

1. Extend `tests/designTokens.test.js`:
   - `every font-size uses a text token`: each `font-size` declaration in
     `src/index.css` has the value `var(--fs-display)`, `var(--fs-title)`,
     `var(--fs-heading)`, `var(--fs-body)`, `var(--fs-small)` or
     `var(--fs-label)`. Allowed besides: `inherit`, a value in `em`
     (text that scales with its parent, such as inline code), and the brand
     mark's `var(--brand-mark-height, ...)`. On failure, list each offending
     selector and value.
   - `every border-radius uses a corner token`: each `border-radius` value
     is `var(--radius)`, `var(--radius-lg)`, `var(--panel-shell-radius)`,
     `var(--radius-pill)`, `50%`, `inherit` or `0`.
   - `--radius-xl is not declared or used`.
2. Run the test and keep the list.
3. Replace the values with the nearest token:
   - up to 0.78rem → `var(--fs-label)`;
   - 0.8rem to 0.9rem → `var(--fs-small)`;
   - 0.9375rem to 1.0625rem → `var(--fs-body)`;
   - 1.1rem to 1.25rem, and the article `h2` clamp → `var(--fs-heading)`;
   - 1.5rem to 2rem, and the two page-title clamps → `var(--fs-title)`;
   - `var(--radius-xl)` and `10px` → `var(--radius-lg)`; `4px` →
     `var(--radius)`; `24px` and `22px 22px 18px 18px` →
     `var(--panel-shell-radius)`; `999px` → `var(--radius-pill)`.
   Work one section of the file at a time (the `/* ===== ... ===== */`
   headings) and run the browser spec for that screen before moving on.
4. Where a mapped size breaks a measuring test, use the next smaller token
   for that rule and note it in your report. Uppercase labels stay at
   `var(--fs-label)`; nothing that a person reads as a sentence may end up
   below `var(--fs-small)`.
5. Delete the `--radius-xl` declaration, and the `.host-ended` and
   `.input-group` rules (including their copies inside `@media` blocks) once
   a search of `src/` shows no use.
6. Run the rest of `<verification>`.
</steps>

<constraints>
- Scope: `font-size` and `border-radius` values, one token, two unused
  rules, and the unit test. No selector is renamed and no other property
  changes.
- Do not add a seventh text size or a fifth corner size, and do not add
  exemptions to the new tests beyond those named in step 1.
- Buttons, cards and selected options keep their gradients; this card does
  not touch colour.
- Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test. No browser spec is edited by this
  card; a measuring test that fails is handled as step 4 says or escalated.
- Match the surrounding formatting.
</constraints>

<acceptance_criteria>
- `node --test tests/designTokens.test.js` passes with the three new tests.
- `--radius-xl` appears nowhere in `src/`.
- Every browser spec passes unchanged.
- At 390px wide, no visible sentence on any page renders below 14px
  (uppercase labels may be 12px).
- `git diff --name-only` lists exactly `src/index.css` and
  `tests/designTokens.test.js`.
</acceptance_criteria>

<verification>
Run in this order.

1. `node --test tests/designTokens.test.js` before editing the stylesheet —
   expected: the three new tests fail and list the offending rules. Quote
   the counts.
2. The same command after the change — expected: all pass.
3. `npm run lint` — expected: exit 0.
4. `npx playwright test tests/browser/ui-semantics.spec.mjs tests/browser/shell-nav.spec.mjs tests/browser/ui-foundation.spec.mjs`
   — expected: all pass in both projects.
5. `npx playwright test tests/browser/home.spec.mjs tests/browser/host-layout.spec.mjs tests/browser/host-live.spec.mjs tests/browser/host-needs-computer.spec.mjs tests/browser/viewer-join.spec.mjs tests/browser/status-page.spec.mjs tests/browser/howto.spec.mjs tests/browser/tap-targets.spec.mjs tests/browser/fonts.spec.mjs`
   — expected: all pass.
6. `npx playwright test tests/browser/media-flow.spec.mjs -g "controls sit on the picture|three large controls|told what is happening"`
   — expected: all pass.
7. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- A measuring test can only pass if a padding, height or line-height
  changes as well.
- A rule needs a text size that is not on the scale to stay readable.
- A `.jsx` file sets a font size or corner radius inline.
- Mapping a `4px` corner to 8px makes a small element (for example inline
  code) fully round; report it instead of adding a size.
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
