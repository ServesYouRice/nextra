# T44 — Stop the How to Use page from scrolling sideways on phones

<model>
Model: `claude-haiku-5-5`
Card: T44 in `../KANBAN.md`
Depends on: none
</model>

<role>
You are a front-end engineer fixing one layout defect. You write the failing
browser test first, then add the one CSS rule that makes it pass.
</role>

<context>
On a phone the How to Use page (`/#how-to`) can be dragged sideways. One command
block is wider than the screen and nothing clips or scrolls it, so the whole
page becomes wider than the viewport.

Verified on a build of this code (Chromium, viewport height 800):

- at 320px wide, `document.documentElement.scrollWidth` is 477;
- at 375px it is 480; at 390px it is 481; at 640px and above it equals the
  viewport width.

The cause (verified by reading the source): `src/HowToView.jsx` line 97 renders
`<pre><code>` with three macOS commands inside an `.article-step` card. The
longest line is 51 characters. `src/index.css` has no rule for `pre` at all, so
the block keeps `white-space: pre` and `overflow: visible`.

`tests/browser/ui-semantics.spec.mjs` already has a loop,
`content reflows without horizontal scrolling at ${width}px`, that visits
`/#how-to`. It measures straight after a same-document hash navigation. Whether
it is green today was not run; the assumption is that it reads the page before
the lazily loaded How to Use view has rendered. That is why this card adds a
test that waits for the page's own content first. Do not change the existing
loop.

T43 may be editing the `.article-step` rule (lines 1241-1247) at the same time,
and T65 rebuilds this page later. To stay clear of both, put the new rule where
`<steps>` says.
</context>

<files>
Read: `src/HowToView.jsx` lines 87-125 — the "For Hosts" steps and the `<pre>`.
Read: `src/index.css` lines 1185-1251 — the `.article-container` rules.
Read: `tests/browser/ui-semantics.spec.mjs` lines 1-50 and 213-230 — the
`horizontalOverflow` helper and the existing reflow loop.

Edit: `tests/browser/ui-semantics.spec.mjs` — add one loop of tests directly
after the existing reflow loop, which ends at line 230.
Edit: `src/index.css` — add one rule directly after the `.article-container li`
rule (lines 1229-1231).

Do not touch: `src/HowToView.jsx` — the content is correct; T65 owns the page.
Do not touch: the `.article-step` rule or any other existing rule or test.
</files>

<task>
At 320, 375 and 390px wide the rendered How to Use page is no wider than the
viewport, and the long command scrolls inside its own box instead.
</task>

<steps>
Order matters: the test must be seen failing against the unchanged CSS.

1. In `tests/browser/ui-semantics.spec.mjs`, after the reflow loop, add:
   `for (const width of [320, 375, 390])` with a test named
   `` `the How to Use page does not scroll sideways at ${width}px once it has rendered` ``.
   The test sets the viewport to `{ width, height: 800 }`, goes to `/#how-to`,
   waits for `page.getByRole('heading', { name: 'How to use Nextra' })` and for
   `page.locator('.article-step pre').first()` to be visible, then asserts with
   the existing `horizontalOverflow(page)` helper that `documentScrollWidth`
   and `bodyScrollWidth` are each at most `clientWidth + 1`. It also asserts
   that the `pre` scrolls inside itself:
   `pre.scrollWidth > pre.clientWidth` and
   `pre.getBoundingClientRect().right <= document.documentElement.clientWidth + 1`.
2. Run the command in `<verification>` step 1 and record the failures.
3. In `src/index.css`, after the `.article-container li` rule, add:
   `.article-container pre { max-width: 100%; overflow-x: auto; }`
   with a one-line comment saying that a command line scrolls inside its own
   box, never the page.
4. Run the remaining checks.
</steps>

<constraints>
- Scope: one new CSS rule and one new test loop. No other change.
- Do not wrap the commands (`white-space: pre-wrap`): a wrapped shell command
  is easy to copy wrongly. The block scrolls instead.
- Do not edit or strengthen the existing reflow loop in this card.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test.
- Match the surrounding formatting in both files.
</constraints>

<acceptance_criteria>
- The three new tests fail before the CSS change and pass after it, in both
  Playwright projects.
- At 320, 375 and 390px `documentElement.scrollWidth` is at most
  `clientWidth + 1` on the rendered How to Use page.
- The first `.article-step pre` has `overflow-x: auto` and its right edge is
  inside the viewport.
- `git diff --name-only` lists exactly `src/index.css` and
  `tests/browser/ui-semantics.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npx playwright test tests/browser/ui-semantics.spec.mjs -g "does not scroll sideways"`
   before editing `src/index.css` — expected: the new tests fail, with a scroll
   width near 477 at 320px. Quote one failure.
2. The same command after the CSS change — expected: all pass.
3. `npx playwright test tests/browser/ui-semantics.spec.mjs -g "content reflows without horizontal scrolling"`
   — expected: all pass.
4. `npm run lint` — expected: exit 0.
5. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- A new test passes before the CSS change. Report the measured widths; do not
  go on.
- After the change another element on `/#how-to` still overflows at 320px.
  Report its selector and right edge.
- The existing reflow loop fails for a route other than `/#how-to`.
</escalate_if>

<report_format>
Return exactly this, nothing else:

**Outcome:** done | blocked | escalated
**Changed:** file paths, or "none"
**Checks:** each command with its real result. Quote the required pre-fix failure.
Never report a check that was not run in this session.
**Blocker:** what stopped it, or "none"
**Next:** the card this unblocks, or what decision is needed
</report_format>
