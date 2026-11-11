# T49 — Let the host preview and the viewer's picture use more of the window

<model>
Model: `claude-sonnet-5-5`
Effort: `medium`
Card: T49 in `../KANBAN.md`
Depends on: none
</model>

<role>
You are a front-end engineer changing two width limits and the tests that pin
them. You measure before and after and change nothing else.
</role>

<context>
The owner approved a larger picture on both pages (review page
`implementation/ui-review/nextra-ui-review.html`, section "Design system
strip", box "Margins and picture size"):

- Host preview: up to 800px wide (720px today), still inside the page margins.
- Viewer picture: as large as the window allows (today it is capped at 60% of
  the page width above 900px).

Both pages keep their side margins; nothing runs edge to edge in this card.
T62 later puts the viewer's controls on the picture and T53 to T55 rebuild the
host layout; this card only lifts the two limits so the gain ships early.

How the stage is sized today (verified in `src/index.css`):

- `.video-container` (lines 1294-1307) is 16:9 and its width is
  `min(100%, var(--media-stage-max-width), max(var(--stage-min-width), (100svh - var(--stage-chrome)) * 16 / 9))`.
  `--stage-chrome` is the height kept free for everything else on the page:
  24rem on the host page (26rem when the viewport is 820px tall or less, line
  2091-2103) and 19rem on the watch page (line 1324).
- `.host-video-section` (lines 1481-1485) has `max-width: 720px`.
- `.watch-video` (lines 1322-1325) has `max-width: 60%`; the media query at
  lines 2179-2182 sets it to 100% at 900px and below.

Numbers to expect after the change (computed from those rules, not yet run):

- Host at 1440x900: the height budget allows 917px, so the preview becomes
  800px wide. At 1366x768 the height budget (625px) already binds, so nothing
  changes there.
- Watch at 1440x900: the page is 1368px wide inside its margins and the height
  budget allows 1059.6px, so the picture becomes about 1060px wide (821px
  today). At 1366x768 it becomes about 825px (779px today).

The test that pins the old numbers (verified):
`tests/browser/ui-semantics.spec.mjs` lines 594-636, the loop
`the host and watch video stages are unchanged at ${width}x${height}`. Its
watch assertion at line 628-629 passes `maxWidthShare: 0.6` to
`stageWidthWithoutFloor`, and the comment at line 627 describes the 60% cap.
That assertion pins the old design and must change. The host assertion at
lines 619-620 computes from the measured container width, so it follows the
new limit without an edit.

T44 adds tests near line 230 of the same spec file at the same time; stay
inside lines 594-636.
</context>

<files>
Read: `src/index.css` lines 51-80 (layout tokens), 1286-1325 (stage rules),
1472-1485 (host layout), 2091-2103 and 2179-2182 (media queries).
Read: `tests/browser/ui-semantics.spec.mjs` lines 478-636 — the stage helpers
and every stage test.

Edit: `src/index.css` — `max-width` in `.host-video-section` (line 1483) and
`max-width` in `.watch-video` (line 1323); the comment above `.watch-video`
(lines 1316-1321) if it mentions the cap.
Edit: `tests/browser/ui-semantics.spec.mjs` — lines 594-636 only: the watch
expectation and its comment, plus two added assertions.

Do not touch: `.video-container`, `--stage-chrome`, `--stage-min-width`, the
`max-height` media queries, or any other test in the spec.
</files>

<task>
The host preview may grow to 800px and the viewer's picture is no longer
capped at 60% of the page width; both still shrink to fit the viewport height
exactly as before. The stage tests describe and prove the new limits.
</task>

<steps>
- Before editing, run the stage tests named in `<verification>` step 1 and
  note the measured widths from a temporary `console.log` if you need them;
  remove any such log before finishing.
- `src/index.css`: set `.host-video-section { max-width: 800px; }` and
  `.watch-video { max-width: 100%; }`.
- `tests/browser/ui-semantics.spec.mjs`, in the loop at lines 602-636:
  - change the watch expectation to
    `stageWidthWithoutFloor(watch, { chromeRem: 19 })` and rewrite the comment
    at line 627 to say that `.watch-video` brings its own 19rem of chrome and
    no width cap;
  - add, for the 1440x900 case only, an assertion that the host stage is
    within 1px of 800;
  - add, for both sizes, an assertion that the watch stage is wider than 60%
    of its container width.
</steps>

<constraints>
- Scope: two `max-width` values and the one test loop.
- The stage stays 16:9 and stays bounded by the height budget; the tests
  `keeps its minimum width on a ... landscape phone` and
  `fits a ... viewport without page scroll` must pass unchanged.
- Do not rename the test loop.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test. The one assertion named above is
  changed because it pins the old 60% cap; say so in your report.
- Match the surrounding formatting.
</constraints>

<acceptance_criteria>
- At 1440x900 the host stage is 800px wide (within 1px).
- At 1440x900 and 1366x768 the watch stage width equals
  `min(container width, 1680, (viewport height - 19rem) * 16 / 9)` to the
  nearest pixel and is wider than 60% of its container.
- Every other test in `tests/browser/ui-semantics.spec.mjs` passes unchanged.
- `git diff --name-only` lists exactly `src/index.css` and
  `tests/browser/ui-semantics.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npx playwright test tests/browser/ui-semantics.spec.mjs -g "video stage"`
   before editing — expected: all pass (baseline).
2. The same command after both edits — expected: all pass.
3. `npx playwright test tests/browser/ui-semantics.spec.mjs -g "fits a|reflows without horizontal scrolling"`
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
- The watch page scrolls vertically at 1440x900 or 1366x768 after the change
  (the 19rem budget would then be too small); report the scroll height.
- A stage test other than the one named in `<context>` fails.
- The baseline run in step 1 is not green.
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
