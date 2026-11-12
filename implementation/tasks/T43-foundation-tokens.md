# T43 — Add the design tokens and shared button, field and card styles

<model>
Model: `claude-sonnet-5-5`
Effort: `high`
Card: T43 in `../KANBAN.md`
Depends on: none
</model>

<role>
You are a front-end engineer laying the CSS foundation the rest of this queue
builds on. You change tokens and shared classes only, keep every existing box
size, and prove the result with tests.
</role>

<context>
The owner approved a UI review of Nextra (dark theme only; there is no light
theme and none is wanted). Every later card in this queue uses the tokens and
classes this card defines, so their names below are a contract.

Open `implementation/ui-review/nextra-ui-review.html`, section "Design system
strip", boxes "Colour", "Type", "Margins and picture size" and "Buttons,
options, fields and badges" (mockup "Proposed, shown at real size"). The spec
below restates it; if the page cannot be opened, this card stands alone.

Decisions the owner made (verified, from the approved page):

- The existing button and card gradients stay exactly as they are. The values
  below are copied from `src/index.css` at commit 67a095a and are the source of
  truth. Nothing in this queue flattens a button or a card.
- The dim grey text token `--text-3` changes from `#6c6c7e` to `#9494a8`. Today
  it measures 3.7:1 on the page background; `#9494a8` measures 6.43:1 on
  `--bg-0`, 6.13:1 on `--bg-1`, 5.71:1 on `--bg-2` and 5.19:1 on `--bg-3`
  (computed with the WCAG 2 formula).
- The quiet button (`.btn-secondary`), the Stop button (`.btn-danger`), the
  status boxes (`.stat-card`) and the how-to cards (`.article-step`) are flat
  today and get gradient versions.
- One main button per screen stands out by size, weight and a soft blue glow,
  not by a different fill.
- Text inside fields and dropdowns is left-aligned.

Why no box size changes here: `tests/browser/ui-semantics.spec.mjs` pins the
host page's height budget ("the host page fits a 1366x768 viewport without page
scroll") and the stage widths. A taller button or row in this card would break
them before the host cards (T53 to T55) re-budget the layout. So the standout
button is a new modifier class that this card defines and does not apply.

Current values to keep (verified in `src/index.css`):

- Card gradient: `background: var(--surface-glass-accent), var(--surface-glass)`
  with `--surface-glass: linear-gradient(180deg, rgba(35, 36, 46, 0.98), rgba(24, 24, 31, 0.98))`
  and `--surface-glass-accent: radial-gradient(circle at top right, rgba(91, 141, 239, 0.12), transparent 38%)`.
- Button gradient (`.btn-primary`, lines 406-415):
  `radial-gradient(circle at top right, rgba(130, 167, 255, 0.2), transparent 48%), linear-gradient(135deg, rgba(57, 61, 83, 0.98), rgba(73, 82, 122, 0.98))`,
  border `1px solid rgba(151, 175, 255, 0.22)`,
  shadow `0 14px 28px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.06)`.
- Button hover (lines 417-425):
  `radial-gradient(circle at top right, rgba(147, 181, 255, 0.24), transparent 52%), linear-gradient(135deg, rgba(64, 69, 94, 0.98), rgba(82, 94, 138, 0.98))`.
- `.mode-toggle button.active` (lines 784-793) repeats the button gradient
  literally.
- Focus ring: `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`
  (line 140). Reduced motion: the block at lines 174-183. Both stay.
</context>

<files>
Read: `src/index.css` lines 1-183 (tokens, base, accessibility), 383-510
(buttons, `.select-input`), 757-793 (`.mode-toggle`), 1241-1247
(`.article-step`), 1771-1776 (`.stat-card`).
Read: `tests/browser/ui-semantics.spec.mjs` lines 1-50 — helper and style
conventions for browser tests.

Edit: `src/index.css` — only these regions:
- `:root` token block (lines 9-99);
- `.btn-primary`, `.btn-primary:hover`, `.btn-danger`, `.btn-danger:hover`,
  `.btn-secondary`, `.btn-secondary:hover` (lines 406-445), plus two new rules
  placed directly after `.btn-small` (line 475): `.btn-main` and
  `.btn-danger-quiet`;
- `.select-input` (lines 481-496): alignment only;
- `.mode-toggle button.active` (lines 784-793): background value only;
- `.article-step` (lines 1241-1247) and `.stat-card` (lines 1771-1776):
  `background` and `border` only.
Create: `tests/designTokens.test.js` — Node test that reads `src/index.css`.
Create: `tests/browser/ui-foundation.spec.mjs` — browser test.

Do not touch: any other rule in `src/index.css`, in particular `.btn`,
`.btn-large`, `.btn-small` sizes, `.setting-row`, `summary` rules and the
media queries from line 2007 on — later cards own them.
Do not touch: any `.jsx` file — this card applies no new class.
</files>

<task>
`src/index.css` defines the approved tokens and shared control styles, with the
existing button and card gradients held in tokens and reused. No element on any
page changes its width or height. Two new tests pin the tokens, the gradients,
the contrast of `--text-3`, the focus ring and the reduced-motion rule.
</task>

<steps>
- In `:root`, set `--text-3: #9494a8;`.
- In `:root`, add these tokens (names are a contract for later cards):
  - `--surface-button`: the `.btn-primary` background above, verbatim.
  - `--surface-button-hover`: the `.btn-primary:hover` background, verbatim.
  - `--surface-button-quiet: linear-gradient(180deg, rgba(35, 36, 46, 0.98), rgba(24, 24, 31, 0.98));`
  - `--surface-button-stop: radial-gradient(circle at top right, rgba(255, 150, 150, 0.18), transparent 48%), linear-gradient(135deg, rgba(104, 40, 46, 0.98), rgba(150, 52, 58, 0.98));`
  - `--surface-button-stop-hover: radial-gradient(circle at top right, rgba(255, 160, 160, 0.22), transparent 52%), linear-gradient(135deg, rgba(116, 44, 51, 0.98), rgba(164, 58, 64, 0.98));`
  - Type scale: `--fs-display: clamp(1.75rem, 3vw, 2.75rem);` (28 to 44px),
    `--fs-title: 1.75rem;` (28px), `--fs-heading: 1.25rem;` (20px),
    `--fs-body: 1rem;` (16px), `--fs-small: 0.875rem;` (14px),
    `--fs-label: 0.75rem;` (12px).
  - Spacing: `--space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem;
    --space-4: 1rem; --space-6: 1.5rem; --space-8: 2rem; --space-12: 3rem;`.
  - `--radius-pill: 999px;` — keep `--radius` (8px), `--radius-lg` (12px) and
    `--panel-shell-radius` (18px) as they are. Leave `--radius-xl` alone; T67
    removes it.
  - `--tap-min: 2.75rem;` (44px).
- `.btn-primary` and `.btn-primary:hover`: replace the literal backgrounds with
  `var(--surface-button)` and `var(--surface-button-hover)`. Border, shadow and
  colour lines stay as they are.
- `.mode-toggle button.active`: `background: var(--surface-button);`. Nothing
  else in that rule changes.
- `.btn-secondary`: `background: var(--surface-button-quiet); color: var(--text-1);
  border: 1px solid rgba(255, 255, 255, 0.11); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);`.
  Hover: `border-color: var(--border-strong);` and keep `color: var(--text-1)`.
- `.btn-danger`: `background: var(--surface-button-stop); color: #fff;
  box-shadow: 0 14px 28px rgba(0, 0, 0, 0.24), inset 0 0 0 1px rgba(255, 160, 160, 0.28),
  inset 0 1px 0 rgba(255, 255, 255, 0.06);`. Draw its edge with that inset
  shadow, not a `border`: `.btn-danger` has no border today, and adding one
  would make the button 2px larger. Hover:
  `background: var(--surface-button-stop-hover);`. White on the lightest part
  of this gradient measures 5.7:1; the flat `#e55b5b` it replaces gave 3.5:1.
- New `.btn-danger-quiet` (quiet Stop on the page): `background: var(--surface-button-quiet);
  color: #ff9a9a; border: 1px solid rgba(229, 91, 91, 0.45);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);` and a hover that sets
  `border-color: rgba(229, 91, 91, 0.7)`.
- New `.btn-main` (the one main button per screen; later cards apply it):
  `min-height: 3.375rem; padding: 0 1.625rem; font-size: var(--fs-body);
  font-weight: 600; border-color: rgba(173, 194, 255, 0.55);
  box-shadow: 0 0 0 4px rgba(91, 141, 239, 0.16), 0 10px 34px -4px rgba(91, 141, 239, 0.62),
  0 14px 28px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.1);`.
  It is used together with `.btn .btn-primary`.
- `.select-input`: remove `text-align: center;` and `text-align-last: center;`.
- `.article-step` and `.stat-card`: `background: var(--surface-glass-accent), var(--surface-glass);`
  and `border: 1px solid rgba(255, 255, 255, 0.08);`. Padding, radius and margin
  stay.
- Write `tests/designTokens.test.js` (CommonJS, `node:test`,
  `node:assert/strict`, reads `src/index.css` as text):
  - `--text-3` is `#9494a8`; its WCAG contrast against the hex values of
    `--bg-0`, `--bg-1`, `--bg-2` and `--bg-3` read from the same file is at
    least 4.5 each;
  - every token named in the steps above is declared once in `:root`;
  - `--surface-button` contains both `rgba(130, 167, 255, 0.2)` and
    `linear-gradient(135deg, rgba(57, 61, 83, 0.98), rgba(73, 82, 122, 0.98))`,
    and `--surface-glass` and `--surface-glass-accent` still hold the values
    quoted in `<context>`;
  - the `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.btn-danger-quiet`,
    `.btn-main`, `.mode-toggle button.active`, `.stat-card` and `.article-step`
    rules each reference the token named for them above;
  - the `.select-input` rule does not contain `center`.
- Write `tests/browser/ui-foundation.spec.mjs` (no room is created):
  - on `/#watch`, the computed colour of `#joinHint` is `rgb(148, 148, 168)`;
  - on `/#does-not-exist`, the computed `background-image` of the "Go Home"
    link (`.btn-primary`) contains `radial-gradient` and `linear-gradient`;
  - on `/#does-not-exist`, after focusing "Go Home" with the keyboard (press
    Tab until it is focused), its computed `outline-style` is `solid` and
    `outline-width` is `2px`;
  - with `page.emulateMedia({ reducedMotion: 'reduce' })` on
    `/#does-not-exist`, the computed `transition-duration` of that link is at
    most 0.001s;
  - on `/#host`, the computed `text-align` of `#roomPassphrase` is `left` or
    `start`.
</steps>

<constraints>
- Scope: only the regions listed in `<files>`. No new class is applied in JSX.
- No element may change size: do not edit `padding`, `min-height`, `font-size`
  or `gap` in any existing rule.
- Dark theme only. Do not add a light theme, a theme switch or a
  `prefers-color-scheme` block.
- Keep the gradient values character for character; the Node test compares
  them.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened. Read every file named above.
- Do not weaken, skip or delete a test. A test that must change is an
  escalation, not an edit.
- Match the surrounding CSS formatting (two-space indent, one declaration per
  line) and the test style of `tests/userError.test.js` and
  `tests/browser/ui-semantics.spec.mjs`.
</constraints>

<acceptance_criteria>
- `--text-3` is `#9494a8` and contrasts at least 4.5:1 with `--bg-0` to `--bg-3`.
- All tokens listed in `<steps>` exist in `:root` with the stated values.
- `.btn-primary` and `.mode-toggle button.active` render the same gradient as
  before, now through `--surface-button`.
- `.btn-secondary`, `.btn-danger`, `.stat-card` and `.article-step` use the
  gradients named above; `.btn-main` and `.btn-danger-quiet` exist.
- `.select-input` text is left-aligned.
- `git diff --name-only` lists exactly `src/index.css`,
  `tests/designTokens.test.js` and `tests/browser/ui-foundation.spec.mjs`.
- Every existing test in `tests/browser/ui-semantics.spec.mjs` still passes.
</acceptance_criteria>

<verification>
Run in this order.

1. `node --test tests/designTokens.test.js` — expected: all tests pass.
2. `npm run lint` — expected: exit 0.
3. `npx playwright test tests/browser/ui-foundation.spec.mjs` — expected: all
   tests pass in the `chromium` project.
4. `npx playwright test tests/browser/ui-semantics.spec.mjs` — expected: all
   tests pass in both projects, proving no size changed.
5. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- Any existing `ui-semantics` test fails after your change; report the test
  name and the measured numbers instead of adjusting a size.
- A token name above already exists in `src/index.css` with a different
  meaning.
- The contrast of `#9494a8` computes below 4.5:1 on any of `--bg-0` to `--bg-3`.
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
