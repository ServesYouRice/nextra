# T51 — Rework the top navigation: four links, a clear current page, a phone menu

<model>
Model: `claude-sonnet-5-5`
Effort: `medium`
Card: T51 in `../KANBAN.md`
Depends on: T43 done
</model>

<role>
You are a React engineer rebuilding the app's top bar. You keep the bar's
height, its landmark names and its keyboard behaviour, and prove the new
behaviour with a browser test.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`: section "Screen 1 ·
Home", mockup "Proposed" (the top bar), and section "Screen 8 · Phone and small
windows", mockup "Proposed" (the bar with a menu button). The spec below
restates both; if the page cannot be opened, this card stands alone.

What the owner approved:

- The "Home" link goes: the logo already links home.
- The current page is shown by brighter text and a 2px underline, not by
  gradient text.
- On a phone a menu button replaces the row of small links, and every tap
  target in the bar is at least 44px tall.

What is there today (verified):

- `src/App.jsx` lines 17-23: `NAV_ITEMS` is Home, How to Use, Host, Watch,
  Status. Lines 118-139 render `<header className="main-nav">` with the logo
  link (`.nav-logo`, `href="#"`, `title="Home"`) and
  `<nav className="nav-links" aria-label="Main">`. The active link gets the
  class `active` and `aria-current="page"`.
- `src/index.css` lines 199-256: `.main-nav`, `.nav-brand`, `.nav-logo`,
  `.nav-links`, `.nav-links a` (colour `--text-3`, padding `0.25rem 0`) and
  the gradient-text rule for the current link. Line 2104-2106 (inside
  `@media (max-height: 820px)`) sets `.main-nav { padding-block: 0.55rem; }`.
  Lines 2254-2265 (inside `@media (max-width: 640px)`) shrink `.nav-links`
  and `.brand-logo-nav`.
- Measured: links are 30px tall on a desktop and 27px on a phone; the logo
  link is 26 by 28px. The bar is 62.6px tall when the viewport is taller
  than 820px and 48.2px when it is 820px or shorter.

Decisions already made for you:

- The mockups label the third link "How it works". Keep the existing label
  `How to Use`: the route title, `tests/routeTitle.test.js` and the browser
  tests use it.
- Link order becomes Host, Watch, How to Use, Status.
- The bar must not get taller than it is today. The host page is budgeted to
  fit a 1366x768 and a 1280x720 screen without scrolling
  (`tests/browser/ui-semantics.spec.mjs`, "the host page fits a ... viewport
  without page scroll"). Give the links their 44px height and take the same
  amount out of the bar's block padding.

Tests that click the main links and run in the phone project too (verified):
`tests/browser/ui-semantics.spec.mjs` line 97 (How to Use), line 102 (Watch)
and line 118 (Status). The `mobile-chrome` project is a Pixel 5, 393px wide,
so after this card those links are behind the menu button there. These three
lines pin the old layout and must open the menu first. Lines 448 and 475 (the
`Watch` link in the leave-dialog test) run on the desktop project only and
need no change.

T52 edits the `Landing` function in the same file at the same time. Stay out
of it.
</context>

<files>
Read: `src/App.jsx` — the whole file (239 lines).
Read: `src/components/BrandLogo.jsx` — the logo markup.
Read: `src/index.css` lines 139-306 (accessibility, shell), 2091-2110 and
2226-2270 (the two media queries that touch the bar).
Read: `tests/browser/ui-semantics.spec.mjs` lines 1-50, 90-124, 173-211.

Edit: `src/App.jsx` — `NAV_ITEMS` (lines 17-23), the `Router` state and
effects (lines 31-87) for the menu state only, and the header JSX (lines
118-139).
Edit: `src/index.css` — the rules `.main-nav`, `.nav-brand`, `.nav-logo`,
`.nav-links`, `.nav-links a` and its hover and current-page rules (lines
199-256), the `.main-nav` rule inside `@media (max-height: 820px)`, and the
`.nav-links`, `.nav-links a` and `.brand-logo-nav` rules inside
`@media (max-width: 640px)`; new rules for the menu button go directly after
line 256.
Edit: `tests/browser/ui-semantics.spec.mjs` — one helper near the top and the
three call sites at lines 97, 102 and 118.
Create: `tests/browser/shell-nav.spec.mjs`.

Do not touch: the `Landing`, `NotFound` and `LoadingState` functions, the
footer JSX and the `.site-footer` and `.footer-links` rules (T66 owns the
footer's tap targets), `src/lib/routeTitle.mjs`.
</files>

<task>
The top bar has the logo and four links (Host, Watch, How to Use, Status), the
current page is underlined, every target in it is at least 44px tall, and at
640px and below the links sit behind a menu button that opens and closes
correctly with mouse, touch and keyboard. The bar is no taller than today.
</task>

<steps>
- `NAV_ITEMS`: remove Home; order Host, Watch, How to Use, Status.
- Links: colour `var(--text-2)`, hover `var(--text-1)`, `display: inline-flex`,
  `align-items: center`, `min-height: var(--tap-min)`, horizontal padding
  `0.75rem`. Current page (`[aria-current='page']`): colour `var(--text-1)`
  and `box-shadow: inset 0 -2px 0 var(--accent)`. Remove the gradient-text
  rule. Keep `aria-current`.
- Logo link: at least 44 by 44px (`min-width` and `min-height` of
  `var(--tap-min)`, content centred). Keep `href="#"` and `title="Home"`.
- Bar height: set `.main-nav` block padding so the bar is at most 63px tall
  above 820px of viewport height and at most 49px at 820px and below.
- Menu button (new): `<button type="button" className="nav-menu-button"
  aria-label="Menu" aria-expanded={menuOpen} aria-controls="mainNavLinks">`
  with a three-bar inline SVG marked `aria-hidden="true"`. It is 44 by 44px,
  hidden above 640px and shown at 640px and below. Give the `<nav>` the id
  `mainNavLinks`.
- At 640px and below the links are `display: none` until the menu is open.
  When open they form a full-width panel under the bar (background
  `var(--bg-1)`, bottom border `1px solid var(--border)`), one link per row,
  each at least 44px tall, text size `var(--fs-body)`.
- Behaviour: the button toggles the menu; choosing a link closes it; a route
  change closes it; Escape closes it and returns focus to the button. Above
  640px the menu state has no visible effect.
- `tests/browser/ui-semantics.spec.mjs`: add a helper that clicks the `Menu`
  button when it is visible and not expanded, then returns
  `page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name })`;
  use it at lines 97, 102 and 118. Change nothing else in those tests.
- `tests/browser/shell-nav.spec.mjs` (no room is created), using
  `page.setViewportSize`:
  - at 1440x900: the Main navigation has exactly four links named Host,
    Watch, How to Use, Status in that order; `.nav-logo` has `href="#"`; on
    `/#host` only the Host link has `aria-current="page"` and its computed
    `box-shadow` is not `none`; every link and the logo link are at least
    44px tall; `.main-nav` is at most 63px tall; the menu button is hidden;
  - at 1280x720: `.main-nav` is at most 49px tall;
  - at 390x844: the menu button is visible with `aria-expanded="false"` and
    no main link is visible; after a click `aria-expanded` is `true`, the four
    links are visible and each is at least 44px tall, and the document does
    not scroll sideways; Escape closes the menu and focuses the button;
    opening it again and choosing Watch sets the title `Watch · Nextra` and
    closes the menu.
</steps>

<constraints>
- Scope: the top bar only. No change to routes, titles, the footer or page
  content.
- Keep `aria-label="Main"` on the `<nav>`, the skip link, the route announcer
  and the focus handling in `Router`; the tests at lines 90-124 and 173-211 of
  `ui-semantics.spec.mjs` depend on them.
- Hidden links must be out of the tab order and out of the accessibility
  tree (`display: none`), not merely moved off screen.
- No new dependency and no icon library; the three bars are inline SVG.
- Use the tokens from T43 (`--tap-min`, `--fs-body`, `--text-2`); add no new
  colour literal.
- Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test. The three call sites named above
  change because they pin the old always-visible links; say so in your
  report.
- Match the surrounding code's style.
</constraints>

<acceptance_criteria>
- The Main navigation has four links: Host, Watch, How to Use, Status.
- The current link has `aria-current="page"` and a 2px accent underline.
- Every link, the logo link and the menu button are at least 44px tall.
- `.main-nav` is at most 63px tall at 1440x900 and at most 49px at 1280x720.
- At 390px wide the links are hidden until the menu button is pressed; Escape
  closes the menu and returns focus to the button.
- `tests/browser/ui-semantics.spec.mjs` passes in both projects with only the
  helper and the three call sites changed.
- `git diff --name-only` lists exactly `src/App.jsx`, `src/index.css`,
  `tests/browser/ui-semantics.spec.mjs` and `tests/browser/shell-nav.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npm run lint` and `npm run typecheck` — expected: exit 0.
2. `node --test tests/routeTitle.test.js` — expected: pass.
3. `npx playwright test tests/browser/shell-nav.spec.mjs` — expected: all pass.
4. `npx playwright test tests/browser/ui-semantics.spec.mjs` — expected: all
   pass in `chromium` and `mobile-chrome`.
5. `npx playwright test tests/browser/media-flow.spec.mjs -g "leaving the host route while sharing"`
   — expected: pass (it clicks the Status link in the Main navigation).
6. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- The bar cannot hold 44px targets without growing past 63px or 49px.
- A "fits a ... viewport without page scroll" test fails after the change;
  report the measured scroll height.
- A test other than the three named call sites needs an edit.
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
