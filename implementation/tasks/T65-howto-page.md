# T65 — How to Use: tabs, three illustrated steps, Copy buttons and fold-out answers

<model>
Model: `claude-sonnet-5-5`
Effort: `high`
Card: T65 in `../KANBAN.md`
Depends on: T44, T58 and T61 done
</model>

<role>
You are a React engineer and careful editor reorganising a long guide. You
keep every fact, bring the wording in line with the screens as they now are,
and leave the security section's sentences exactly as a test pins them.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Screen 10 ·
How to Use", mockup "Proposed". The spec below restates it; if the page
cannot be opened, this card stands alone.

Today (verified, `src/HowToView.jsx`, 341 lines): the page opens with a dense
paragraph of terms (H.264, relay fallback, AV1, BYOK TURN), then about eight
screens of text cards in one column: "What you need", "Tested browsers" (a
table), "For Hosts" (five steps), "OBS Streaming" (four steps and a list),
"For Viewers" (four steps), "Troubleshooting" (nine questions), "Security
and privacy". There is no menu and no picture.

Approved:

1. Tabs jump straight to the part you need.
2. Three illustrated steps come first; the long text follows for those who
   want it.
3. Commands get a Copy button and stay inside their box.
4. Troubleshooting folds away until needed.

The guide must also describe the screens as they are after the earlier
cards. Names that changed (verified against those cards' specifications;
check each in the source before you write it):

| The guide says today | The screens now say |
|---|---|
| Use OBS (WHIP ingest), a checkbox in Settings | the `OBS` tab above the preview (`This browser` / `OBS`) |
| The OBS Configuration panel appears on the right | the settings panel beside the preview shows the OBS rows |
| Use BYOK TURN (AV1) | `AV1 with my own TURN server`, under `More options` |
| Apply recommended output settings | `Set OBS up for me`, under `More options` |
| Tuning | `Picture preset` |
| Auto-start streaming in OBS | `Start stream for me`, under `More options` |
| WS password | `OBS password` |
| the manual WHIP values shown on the host page | `Set it up by hand` on the host page |
| Public Link, Local Link | `Public link`, `Local link` on the `Invite viewers` card, next to the room code |
| The stream starts when you click Watch Stream | the stream starts when you press `Join Room`; `Watch Stream` appears only to retry |
| Host status bar says the relay was lowered | `Troubleshooting diagnostics` on the host page shows a lowered relay bitrate |

Facts that constrain the change (verified):

- `tests/howToSecurityCopy.test.js` reads `src/HowToView.jsx` as text. It
  takes everything between the literal `<h2>Security and privacy</h2>` and
  the literal `<div className="article-cta">` as the security section, and
  checks its sentences (DTLS-SRTP with WebRTC, WHIP and WHEP; the relay over
  the page connection; public links and the tunnel provider; the local link
  and `LOCAL_HTTPS=true`; "Media is not stored by Nextra."; and three more).
  Keep both literals, keep that section's text exactly, and keep the section
  last in the file, directly before the call to action.
- T44 added a test loop to `tests/browser/ui-semantics.spec.mjs`,
  `the How to Use page does not scroll sideways at ${width}px once it has rendered`.
  It waits for the heading `How to use Nextra` and for
  `.article-step pre` to be visible right after the page loads, and checks
  that the `pre` scrolls inside itself (`scrollWidth > clientWidth`) at 320,
  375 and 390px. So the Mac command stays in a `pre` inside an
  `.article-step`, on the tab that is open first, on one unwrapped line.
- The reflow loop in the same spec loads `/#how-to` at nine widths from
  320px to 2560px and allows no sideways scroll.
- The app uses the URL hash for routes (`#how-to`). A link to `#something`
  inside the page would be read as a route, so tabs are buttons with local
  state, not links.
- `.article-container` is shared with the Privacy and Copyright pages;
  `.table-wrap` and `.data-table` with the Status page; `.article-step` got
  the card gradient in T43.
- `src/components/CopyField.jsx` shows how copying is done elsewhere:
  `navigator.clipboard.writeText`, a toast through `useNotifications()`, and
  a polite "Copied!" status.
- The page computes `appOrigin` from `window.location.origin` and shows it in
  two places; keep both.
</context>

<files>
Read: `src/HowToView.jsx` in full.
Read: `tests/howToSecurityCopy.test.js` in full.
Read: `src/components/CopyField.jsx`, `src/context/NotificationContext.jsx`.
Read: `src/index.css` lines 1178-1251 (article rules), 1794-1818
(`.table-wrap` inside an article), and the `.article-*` rules inside the
media queries.
Read: `src/HostView.jsx` and `src/WatchView.jsx` only to confirm each name in
the table above (search for the quoted labels).
Read: `tests/browser/ui-semantics.spec.mjs` lines 213-235.

Edit: `src/HowToView.jsx`.
Edit: `src/index.css` — new rules in a block headed
`/* ========== HOW TO USE ========== */` placed directly before the
`/* ========== VIDEO STAGE ========== */` comment, with this card's
responsive rules in their own `@media` blocks inside it.
Create: `tests/browser/howto.spec.mjs`.

Do not touch: the existing `.article-container`, `.article-step`,
`.table-wrap` and `.data-table` rules (other pages share them; add classes
under `.howto` instead), `tests/howToSecurityCopy.test.js`,
`tests/browser/ui-semantics.spec.mjs`, `src/App.jsx`.
</files>

<task>
The guide opens on five tabs and three illustrated steps for sharing a
screen. Each tab shows only its own part; commands have a Copy button;
troubleshooting questions fold out. Every fact in today's guide is still
there, worded for the screens as they now are, and the security section is
unchanged.
</task>

<steps>
- Container: `<div className="article-container howto">`. Keep
  `<h1>How to use Nextra</h1>`. Replace the opening paragraph with one
  sentence:
  `Share your screen from this browser or from OBS. Viewers open a link; they install nothing.`
  Move the terms it used to introduce (H.264 with relay fallback, AV1 with
  your own TURN server, the relay for public-link viewers) into the tabs
  where they apply; drop none of them.
- Tabs: `<div role="tablist" aria-label="Guide sections">` with five
  `<button role="tab">`: `Share your screen`, `Use OBS`, `Watch a stream`,
  `Fix a problem`, `Privacy`. Selected tab: `aria-selected="true"`,
  `tabIndex 0`, the button gradient (`var(--surface-button)`); the others
  `tabIndex -1` on the quiet gradient. Left and Right arrows move between
  tabs, Home and End jump to the first and last. Each tab is at least 44px
  tall. Below 640px the row scrolls sideways inside itself
  (`overflow-x: auto`); the page must not. All five panels stay in the
  document as `<section role="tabpanel">` elements; the ones not selected
  carry the `hidden` attribute. `Share your screen` is selected first.
- Panel `Share your screen`:
  1. Three step cards in a row (one column below 900px), each an
     `.article-step` with a small illustration built from plain elements and
     CSS (`aria-hidden="true"`; no image file):
     - `1. Start Nextra` — `Open the app on the computer you want to share.`
       Illustration: a button shape reading "Share my screen".
     - `2. Press Start Sharing` — `Pick a screen, a window or a tab.`
       Illustration: three small window outlines, one highlighted.
     - `3. Send the link` — `Viewers open it. Nothing to install.`
       Illustration: a room code chip `VW6-349`.
  2. An `.article-step` titled `On a Mac, run this once` with the existing
     three-line command in a `pre` and a `Copy` button (see below), and the
     existing sentences about keeping Terminal open.
  3. The existing "For Hosts" steps 1 to 5 as the long text, reworded with
     the table above. Windows SmartScreen, the firewall and Screen Recording
     notes, the public link's limits and lifetime all stay.
  4. Two fold-outs: `What you need` and `Tested browsers` (the existing
     table, inside its `.table-wrap`).
- Panel `Use OBS`: the existing "OBS Streaming" content with the new names:
  choose the `OBS` tab, the two paths (H.264 with relay fallback; AV1 with
  your own TURN server), the options, the three setup steps the host page
  shows, and the list "OBS settings applied automatically" in a fold-out.
- Panel `Watch a stream`: the existing "For Viewers" content: join by link
  or code (one press), how playback picks WebRTC or the relay, remote media
  control, external players (WHEP) with the `appOrigin` example.
- Panel `Fix a problem`: the heading `Common questions`, then each of the
  nine existing questions as `<details className="howto-question">` with
  the question as its `<summary>` (at least 44px tall) and the existing
  answer, reworded with the table above. All closed at first.
- Panel `Privacy`: the existing block from `<h2>Security and privacy</h2>`
  to the paragraph ending "short-lived TURN credentials.", unchanged. It is
  the last panel in the file, and `<div className="article-cta">` follows
  it directly, outside the panels, so the button shows under every tab. The
  button's text becomes `Share my screen`.
- Copy button: every `pre` on the page sits in a `.howto-code` box with a
  `Copy` button at its top right (`btn btn-secondary btn-small`, at least
  44px tall at 640px wide and below). Its accessible name is
  `Copy command`. It copies the command text exactly, shows `Copied` for two
  seconds and raises the same toast `CopyField` does. The `pre` keeps
  `white-space: pre` and scrolls sideways inside the box; the button does
  not cover the first line (give the box top padding for it).
- CSS under `.howto`: step cards `repeat(3, 1fr)` with a 16px gap inside the
  `full` grid column, at most `70rem` wide, like the table; illustrations
  96px tall; fold-outs separated by hairlines; body text `var(--fs-body)`,
  line height 1.6, in `var(--text-2)`; headings in `var(--text-1)`.
- `tests/browser/howto.spec.mjs` (no room is created):
  - at 1440x900: five tabs with the names above; `Share your screen` is
    selected; exactly one tab panel is visible; the three step titles are
    visible and their cards share one row; the texts `BYOK` and
    `Use OBS (WHIP ingest)` have count 0 on the page;
  - pressing ArrowRight on the selected tab selects `Use OBS`, whose panel
    contains `Set OBS up for me`, `Picture preset` and `OBS password`;
  - `Fix a problem` shows nine closed fold-outs; opening the first shows its
    answer;
  - `Privacy` shows the heading `Security and privacy` and the text
    `Media is not stored by Nextra.`;
  - in a context with clipboard permissions, `Copy command` puts the three
    Mac lines on the clipboard, starting `chmod +x ./Nextra-macos-arm64`;
  - the link `Share my screen` is visible under every tab and leads to the
    title `Host · Nextra`;
  - at 390x844: each tab is at least 44px tall, the tab row's
    `scrollWidth` may exceed its `clientWidth` but the document does not
    scroll sideways, and the step cards are stacked in one column.
</steps>

<constraints>
- Scope: `src/HowToView.jsx`, one new CSS section and one new spec. No
  route, title or navigation change.
- Do not drop a fact. If a sentence no longer matches the product and the
  table above does not cover it, keep it and escalate.
- The security section's text does not change by a character.
- Use tokens and classes from T43; cards and selected tabs keep their
  gradients. No new colour literal, no new dependency, no image file.
- Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened: confirm each renamed label
  in the source before you write it into the guide.
- Do not weaken, skip or delete a test; no existing assertion needs a
  change.
- Match the surrounding code's naming, comments and indentation.
</constraints>

<acceptance_criteria>
- Five tabs; one panel visible at a time; keyboard arrows move between tabs.
- The first panel opens with three step cards and the Mac command with a
  working Copy button.
- Nine troubleshooting questions are closed fold-outs.
- No label in the guide names a control that no longer exists.
- `node --test tests/howToSecurityCopy.test.js` passes unchanged, and so do
  T44's tests and the reflow loop in `tests/browser/ui-semantics.spec.mjs`.
- `git diff --name-only` lists exactly `src/HowToView.jsx`, `src/index.css`
  and `tests/browser/howto.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npm run lint` and `npm run typecheck` — expected: exit 0.
2. `node --test tests/howToSecurityCopy.test.js tests/routeTitle.test.js` —
   expected: all pass, unchanged.
3. `npx playwright test tests/browser/howto.spec.mjs` — expected: all pass.
4. `npx playwright test tests/browser/ui-semantics.spec.mjs -g "How to Use page does not scroll sideways|content reflows|each route sets its own title"`
   — expected: all pass in both projects.
5. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- A label in the table above is not what the source shows.
- The security test fails for any reason.
- A sentence of today's guide has no truthful place in the new structure.
- T44's test can no longer find a visible `.article-step pre` on first load.
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
