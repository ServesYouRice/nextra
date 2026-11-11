# T59 — Host: say up front when this device cannot share

<model>
Model: `claude-sonnet-5-5`
Effort: `medium`
Card: T59 in `../KANBAN.md`
Depends on: T58 done
</model>

<role>
You are a React engineer adding one clear dead-end message to the host page
for devices that cannot capture a screen. You keep the normal host page
exactly as it is everywhere else and prove both sides with tests.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Screen 8 ·
Phone and small windows", mockup "Proposed", third phone ("Sharing needs a
computer"). The spec below restates it; if the page cannot be opened, this
card stands alone.

Today (verified in the running app at 390x844): a phone shows the whole host
page, with settings, a preview and Start Sharing. Pressing Start Sharing then
fails with "Screen capture is unavailable in this browser. Use desktop Chrome
or Edge." The page is about 1230px tall, so the host scrolls through controls
that cannot work.

Approved: on a device that cannot share, say so first and offer the thing it
can do, which is watching.

Decision already made for you: the message shows only when both of these are
true:

- the browser has no screen-capture function
  (`typeof navigator.mediaDevices?.getDisplayMedia !== 'function'`), and
- the main pointer is a finger (`window.matchMedia('(pointer: coarse)').matches`).

Why both: an existing test removes the capture function in a desktop browser
and expects the normal page, a press on Start Sharing and the inline error
(`tests/browser/media-flow.spec.mjs`, test
`Host preflight blocks an unavailable Browser capture path before room allocation`,
lines 643-656). And the `mobile-chrome` project runs
`tests/browser/ui-semantics.spec.mjs` on an emulated Pixel 5, where the
pointer is coarse but the capture function exists (verified), and those tests
expect the normal host page (`.host-side-panel`, `.controls`, the capture
rows). With the two-part rule both keep passing unchanged.

Facts (verified):

- `src/lib/hostPreflight.mjs` exports `evaluateHostPreflight(...)`; its tests
  are in `tests/hostPreflight.test.js` (CommonJS, `node:test`, dynamic
  `import()` of the module).
- `src/HostView.jsx` renders `<div className="view-container">` with
  `<div className="view-header"><h1>Host</h1>...` and then `.host-layout`.
- `.center-page` (used by the "page not found" view in `src/App.jsx`) is a
  centred column and can be reused for the layout.
- The top bar's link to the guide is named `How to Use`; the mockup's
  "How it works" is not adopted.
- A spec makes its own phone context like this
  (`tests/browser/ui-semantics.spec.mjs` lines 554-560):
  `browser.newContext({ baseURL: testInfo.project.use.baseURL, ignoreHTTPSErrors: true, viewport: { width, height }, isMobile: true, hasTouch: true })`.
  Assumption: such a context reports `(pointer: coarse)`; it was verified for
  the Pixel 5 device profile, which sets the same two flags.
</context>

<files>
Read: `src/lib/hostPreflight.mjs`, `tests/hostPreflight.test.js`.
Read: `src/HostView.jsx` — the component's hooks section only as far as
needed to place one `useState`, and the start of the render (the
`view-container` / `view-header` / `host-layout` lines).
Read: `src/index.css` lines 1158-1183 (`.view-container`, `.view-header`,
`.subtitle`) and 1965-2005 (`.center-page`).
Read: `tests/browser/media-flow.spec.mjs` lines 643-656;
`tests/browser/ui-semantics.spec.mjs` lines 548-570.

Edit: `src/lib/hostPreflight.mjs` — add one exported function.
Edit: `tests/hostPreflight.test.js` — add one test.
Edit: `src/HostView.jsx` — one state value and one early branch in the render.
Edit: `src/index.css` — new `.cannot-share` rules directly after the
`.center-page` rules.
Create: `tests/browser/host-needs-computer.spec.mjs`.

Do not touch: `evaluateHostPreflight`, `handleStartSharing`, the normal host
layout, `src/App.jsx`, any existing spec file.
</files>

<task>
On a touch device whose browser cannot capture a screen, the Host page shows
"Sharing needs a computer", one sentence of explanation, a main link to watch
a stream and a link to the guide, and none of the host controls. Every other
device sees the host page unchanged.
</task>

<steps>
- `src/lib/hostPreflight.mjs`: export
  `deviceCannotShare({ captureApiAvailable, coarsePointer })`, returning
  `true` only when `captureApiAvailable` is false and `coarsePointer` is true.
- `tests/hostPreflight.test.js`: add
  `a touch device without screen capture cannot share; every other combination can`,
  covering the four combinations.
- `src/HostView.jsx`: read the two facts once, in a `useState` initialiser
  (guard `window.matchMedia` being absent), and keep the result in
  `cannotShare`. In the render, after all hooks, when `cannotShare` is true
  return:
  - the usual `.view-container` and `.view-header` (`<h1>Host</h1>`, same
    subtitle), then
  - `<div className="cannot-share">` with an inline laptop icon
    (`aria-hidden="true"`, 48px), `<h2>Sharing needs a computer</h2>`, the
    paragraph
    `Phone and tablet browsers can't capture the screen. Open Nextra on a laptop or desktop to share.`,
    the link `Watch a stream instead` (`href="#watch"`, classes
    `btn btn-primary btn-main`) and the link `How to Use`
    (`href="#how-to"`, class `btn btn-outline`).
  Nothing else of the host page is rendered in that state.
- CSS: `.cannot-share` is a centred column, at most 26rem wide, text centred,
  gaps of 16px, 16px side padding, top margin 8vh; heading at
  `var(--fs-heading)`, paragraph at `var(--fs-body)` in `var(--text-2)`; both
  links full width at 640px wide and below, each at least 44px tall.
- `tests/browser/host-needs-computer.spec.mjs` (no room is created):
  - `a touch device without screen capture is told sharing needs a computer`:
    in a phone context (390x844, `isMobile: true`, `hasTouch: true`) with an
    init script that sets `navigator.mediaDevices.getDisplayMedia` to
    `undefined` (as the media-flow test above does), `/#host` shows the
    heading `Sharing needs a computer`; the button `Start Sharing` and
    `.host-side-panel` have count 0; the link `Watch a stream instead` has
    the class `btn-main`, is at least 44px tall and leads to a page where
    `.join-form` is visible; back on `/#host`, the link `How to Use` leads to
    the title `How to Use · Nextra`; the document does not scroll sideways.
  - `a desktop browser without screen capture keeps the host page and its inline error`:
    in the default page with the same init script, `Start Sharing` is
    visible and the heading `Sharing needs a computer` has count 0.
  - `a touch device that can capture keeps the host page`: in a phone
    context without the init script, `.host-side-panel` is visible and the
    heading has count 0.
</steps>

<constraints>
- Scope: the new function, its test, one state value, one early branch, the
  new CSS block and the new spec.
- The early branch comes after every hook call; do not make any hook
  conditional.
- Use tokens and classes from T43 (`.btn-main`, `--fs-heading`, `--fs-body`).
  No new colour literal, no new dependency, inline SVG for the icon.
- Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test; no existing test needs a change.
- Match the surrounding code's naming, comments and indentation.
</constraints>

<acceptance_criteria>
- `deviceCannotShare` exists and is covered for all four combinations.
- On a touch device without screen capture, `/#host` shows the message and
  the two links and no host controls.
- On a desktop browser without screen capture, and on a touch device with
  it, `/#host` is unchanged.
- `git diff --name-only` lists exactly `src/lib/hostPreflight.mjs`,
  `tests/hostPreflight.test.js`, `src/HostView.jsx`, `src/index.css` and
  `tests/browser/host-needs-computer.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npm run lint` and `npm run typecheck` — expected: exit 0.
2. `node --test tests/hostPreflight.test.js` — expected: all pass, including
   the new test.
3. `npx playwright test tests/browser/host-needs-computer.spec.mjs` —
   expected: three tests pass.
4. `npx playwright test tests/browser/media-flow.spec.mjs -g "Host preflight"`
   — expected: pass, unchanged.
5. `npx playwright test tests/browser/ui-semantics.spec.mjs` — expected: all
   pass in both projects (`chromium` and `mobile-chrome`).
6. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- The phone context in the new spec does not report `(pointer: coarse)`.
- Any `mobile-chrome` test in `ui-semantics.spec.mjs` lands on the new
  message.
- The early branch cannot be placed after all hooks without restructuring the
  component.
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
