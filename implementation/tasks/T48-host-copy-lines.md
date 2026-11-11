# T48 — Correct two lines of host page copy

<model>
Model: `claude-haiku-5-5`
Card: T48 in `../KANBAN.md`
Depends on: none
</model>

<role>
You are a front-end engineer correcting two sentences that describe a screen
that does not exist. You change the words and nothing else.
</role>

<context>
Two sentences on the host page tell the host about things that are not there
(both verified in the running app and in the source):

1. Before sharing, the empty preview says
   "Pick your quality in Settings, then press Start Sharing. You'll get a room
   code and link to send to viewers." (`src/HostView.jsx` lines 2118-2121).
   The quality choices (Resolution and Frame rate) are under the preview, not
   in the Settings card, and the page shows links, not a room code.
2. While sharing without a public link, the room card says
   "Public link unavailable on this machine. Share the local link or room code
   instead." (`src/HostView.jsx` line 2097). No room code is shown anywhere on
   that page.

Later cards redesign both places (T53 the empty preview, T56 the room card),
so keep this change to the wording. The new test only checks that the two
false claims are gone, so it stays valid after those cards.
</context>

<files>
Read: `src/HostView.jsx` lines 2086-2103 (`publicLinkHint`) and 2113-2123 (the
idle overlay).
Read: `tests/howToSecurityCopy.test.js` lines 1-30 — the style of a test that
reads a `.jsx` source file as text.

Edit: `src/HostView.jsx` — the two sentences only.
Create: `tests/hostCopy.test.js` — a Node test that reads `src/HostView.jsx`.

Do not touch: anything else in `src/HostView.jsx`.
</files>

<task>
The two sentences describe the page as it is: quality is chosen below the
preview, and the host is told to share the link.
</task>

<steps>
- In the idle overlay, replace the sub-line with:
  `Pick a resolution and frame rate below, then press Start Sharing. You'll get a link to send to viewers.`
  Keep the `&apos;` escaping the file already uses for apostrophes in JSX text.
- In `publicLinkHint`, replace the last branch's text with:
  `Public link unavailable on this machine. Share the local link instead.`
  Leave the "starting" and "error" branches as they are.
- Create `tests/hostCopy.test.js` (CommonJS, `node:test`,
  `node:assert/strict`). It reads `src/HostView.jsx` and asserts that the
  source does not match `/quality in Settings/i` and does not match
  `/local link or room code/i`.
</steps>

<constraints>
- Scope: two string literals and one new test file.
- Do not move, restyle or restructure the overlay or the hint.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test.
- Match the surrounding code's style.
</constraints>

<acceptance_criteria>
- `src/HostView.jsx` no longer contains "quality in Settings" or "local link
  or room code".
- `tests/hostCopy.test.js` passes.
- `git diff --name-only` lists exactly `src/HostView.jsx` and
  `tests/hostCopy.test.js`.
</acceptance_criteria>

<verification>
Run in this order.

1. `node --test tests/hostCopy.test.js` — expected: pass.
2. `npm run lint` — expected: exit 0.
3. `npx playwright test tests/browser/ui-semantics.spec.mjs -g "fits a 1366x768"`
   — expected: pass (the new sentence must not make the overlay taller than
   the preview).
4. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- Either sentence is not at the quoted place in `src/HostView.jsx`.
- A browser test asserts on either old sentence (none was found when this card
  was written).
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
