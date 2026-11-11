# T60 — Viewer: one centred join card with six code boxes

<model>
Model: `claude-sonnet-5-5`
Effort: `high`
Card: T60 in `../KANBAN.md`
Depends on: T43, T46, T47 and T52 done
</model>

<role>
You are a React engineer rebuilding the form a viewer uses to join a room.
The field's label, ids and messages are used by many tests, so you change how
the form looks and where its messages sit while keeping those hooks exact.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Screen 5 ·
Viewer, joining", mockups "Proposed" and "Proposed wrong code", and section
"Screen 7 · Viewer, when things change", mockup "A wrong passphrase ·
Proposed". The spec below restates them; if the page cannot be opened, this
card stands alone.

Today (verified in the running app): the Watch page is a small form at the
top of an otherwise empty page. The label and hint are dim grey. An error
shows as a bar across the whole page, far from the field, and the field does
not turn red for an unknown room.

Approved: one centred card whose only job is joining. Six boxes show how long
the code is and fill as the viewer types. An error turns the boxes red and
sits right under them, saying why and what to do. Pasting a full link still
works.

Scope note: joining still leads to the view with the `Watch Stream` button.
T61 removes that second press; do not start playback here.

What is there today (verified, `src/WatchView.jsx`, line numbers as of commit
67a095a; T46 and T47 have edited this file since, so find blocks by name):

- Lines 67-82: local helpers `normalizeRoomCode`, `extractRoomCode`,
  `formatRoomCode`. T52 created `src/lib/roomCode.mjs` with the same three
  functions.
- Line 105: `useState(initialCode)`. A code that arrives in a link
  (`#watch/ABC123`) is shown as `ABC123`; a typed code is shown as `ABC-123`.
- Lines 1706-1777: the header (`<h1>Watch</h1>`, "Join a room to watch a
  stream"), `<UserErrorAlert error={error} id="watchError" />` above the
  form, then `.join-form` with the label, `#roomCode`, the `Join Room`
  button, the passphrase step and `#joinHint`.
- `handleJoin` (lines 1049-1105): a failed join ends in `setError(err)`; the
  server's message for an unknown code is `Room not found.`
  (`lib/socket.js`), and the field is not marked invalid in that case.
- `src/components/UserErrorAlert.jsx` renders
  `<div className="alert alert-error" role="alert" id={id}>`; the Host page
  uses it too.
- After T46: a rejected passphrase shows
  `<p className="field-error" id="passphraseError" role="alert">` under the
  passphrase field, and `#joinHint` reads
  `Enter the passphrase the host gave you.` during the passphrase step.

Names and hooks the tests depend on (verified; keep all of them):

- `label[for="roomCode"]` has exactly the text `Room code`, and
  `getByLabel('Room code')` is visible, fillable and focusable
  (`tests/browser/ui-semantics.spec.mjs` lines 52-88, 199-211, and about 20
  uses in `tests/browser/media-flow.spec.mjs`).
- `#roomCode` has `aria-describedby="joinHint"`, or `"joinHint watchError"`
  while an error shows; `aria-invalid="true"` after an empty or short submit;
  not invalid after typing again.
- `#joinHint` matches `/6-character room code/` when the field is empty and
  is exactly `3/6 characters` after three characters.
- `page.getByRole('alert')` has exactly the text `Please enter a room code.`
  or `Enter the full 6-character room code.`; this needs the page to hold one
  alert only. `#watchError` is visible while an error shows.
- Typing `ABC123` gives the value `ABC-123`; the next Tab lands on the
  `Join Room` button, so nothing focusable may sit between them
  (`ui-semantics.spec.mjs` lines 199-211).
- The button's name is `Join Room` (`Joining...` while busy). The mockup says
  "Join and watch"; that label is not adopted.
- `.join-form` is visible on `/#watch` (`ui-semantics.spec.mjs` lines 23,
  176-197).
- Passphrase step: label `Room passphrase`, the field focused when it
  appears, visible text matching `/requires a passphrase.*code has been kept/i`
  (`media-flow.spec.mjs` lines 726-728), and T46's alert text.
- `/#watch` must render when reading `window.localStorage` throws
  (`ui-semantics.spec.mjs` lines 141-171).
- Unit tests read `src/WatchView.jsx` as text: `tests/viewerSession.test.js`,
  `tests/mediaDebug.test.js`, `tests/playbackAttempt.test.js`,
  `tests/relayAppendQueue.test.js`, `tests/subscriptionLedger.test.js`,
  `tests/timedAck.test.js`. Do not rename, move or re-order the existing
  `useCallback` functions, and add new dependency entries at the end of a
  dependency array.

Test lines that pin the old design and must change (verified):
`tests/browser/media-flow.spec.mjs` lines 724 and 729,
`await expect(codeInput).toHaveValue(code);`. A linked code is now shown with
its hyphen, like a typed one, so both become
`` await expect(codeInput).toHaveValue(`${code.slice(0, 3)}-${code.slice(3)}`); ``.
Nothing else in that file changes.
</context>

<files>
Read: `src/WatchView.jsx` lines 60-135, 190-200, `handleJoin`, and the render
from `return (` to the end of the `!joined` branch.
Read: `src/lib/roomCode.mjs`, `src/components/UserErrorAlert.jsx`.
Read: `src/index.css` lines 512-535 (`.input-code`), 1664-1722 (join form,
`.field-error`), and the `.join-*` and `.input-*` rules inside the media
queries.
Read: `tests/browser/ui-semantics.spec.mjs` lines 52-88 and 141-211.

Edit: `src/WatchView.jsx` — the three local helpers (replaced by an import),
the initial value of `codeInput`, the failure branch of `handleJoin`, and the
`!joined` branch of the render including the header above it.
Edit: `src/components/UserErrorAlert.jsx` — one optional prop.
Edit: `src/index.css` — the JOIN FORM section (`.join-form`, `.join-hint`,
`.join-field`, `.input-label`, `.input-group`); new rules go directly after
`.field-error`. Put this card's responsive rules in their own `@media`
blocks inside that section; do not add to the shared `@media` blocks at the
end of the file, which the host cards are editing at the same time. The
`.input-group` rules there may be left as they are.
Edit: `tests/browser/media-flow.spec.mjs` — lines 724 and 729 only.
Create: `tests/browser/viewer-join.spec.mjs`.

Do not touch: `.input-code` (other screens use it), `.video-overlay` and
`.controls` (the Host page shares them), the joined branch of the render,
`joinRoomAndLoadDevice`, `handleWatch`, the socket handlers,
`src/lib/userError.mjs`.
</files>

<task>
`/#watch` shows one centred card: a heading, six boxes for the room code, one
main button and a line about pasting a link. Errors appear under the boxes,
which turn red; an unknown code says what happened and what to do. The
passphrase step uses the same card. All existing tests pass with the two
listed lines changed.
</task>

<steps>
- Import `normalizeRoomCode`, `extractRoomCode` and `formatRoomCode` from
  `src/lib/roomCode.mjs` and delete the local copies. Initialise `codeInput`
  with `formatRoomCode(extractRoomCode(initialCode))`.
- While not joined, do not render `.view-header`. Render
  `<div className="join-form join-card">`: card gradient
  (`var(--surface-glass-accent), var(--surface-glass)`), 18px corners, at
  most `26rem` wide, centred, padding 24px (16px at 640px wide and below),
  16px between its parts, top margin `clamp(1.5rem, 8vh, 4.5rem)`.
  Top to bottom:
  1. `<h1>Join a stream</h1>` at `var(--fs-title)`. During the passphrase
     step it reads `This room has a passphrase`.
  2. `<p className="join-hint" id="joinHint" role="status">`: with an empty
     field `Enter the 6-character room code from the host.`; while typing
     `N/6 characters` as today; during the passphrase step T46's sentence.
     `var(--fs-small)`, `var(--text-2)`.
  3. The label `Room code` (`var(--fs-label)`, uppercase, `var(--text-2)`)
     and the code entry.
  4. The error line (see below).
  5. The passphrase step, when required (see below).
  6. `<button className="btn btn-primary btn-main">Join Room</button>`, full
     width, same handler and busy state.
  7. `<p className="join-paste-hint">Or paste the link you were sent.</p>`,
     `var(--fs-small)`, `var(--text-3)`.
- Code entry: `<div className="code-entry">` holding
  `<div className="code-boxes" aria-hidden="true">` with six
  `<span className="code-box">` and the real `<input id="roomCode">` laid
  over them (`position: absolute; inset: 0; width: 100%; height: 100%`,
  transparent background, border, text and caret; no placeholder). The boxes
  show the characters of `normalizeRoomCode(codeInput)`, one each. Boxes:
  `flex: 1 1 0`, at most `3rem` wide, `3.5rem` tall, 8px apart, with 16px
  between the third and fourth; `var(--bg-2)` background,
  `1px solid var(--border-strong)`, 8px corners; character in the mono font
  at `var(--fs-title)`, weight 600. While the input has focus, the box at
  the typing position (the first empty one, or the last when full) has a
  `2px solid var(--accent)` border; give `.code-entry:focus-within` the
  page's focus ring as well. With `aria-invalid="true"` on the input every
  box border is `var(--err)`. Keep every current attribute and handler of
  the input (`autoFocus`, `aria-describedby`, `aria-invalid`, `aria-busy`,
  `disabled`, Enter to join, the `onChange` that formats and clears state),
  and add `inputMode="text"`, `autoCapitalize="characters"`,
  `autoComplete="off"`, `spellCheck={false}`, `maxLength={64}` so a pasted
  link fits.
- Error line: while not joined, render
  `<UserErrorAlert error={error} id="watchError" />` directly under the code
  entry instead of above the form, with a new optional prop
  `variant="inline"`. With that prop the component renders the same
  element, id and `role="alert"` but with the class `field-error` instead of
  `alert alert-error`. Without the prop it renders exactly as before. While
  joined, the alert stays above the picture and looks as it does today (many
  playback tests read it there; T62 moves it). It is rendered in one of the
  two places, never both.
- Unknown room: in the failure branch of `handleJoin`, when the message
  matches `/^room not found/i`, call `setCodeError(true)` and set the error
  to
  `No room has this code. Codes change each time the host starts sharing, so ask them for the new one.`
  In that state also render, after the `Join Room` button, a link-styled
  button `Try another code` that clears the field and the error and focuses
  the field.
- Passphrase step: keep the sentence
  `This room requires a passphrase. The room code has been kept; enter the passphrase to continue.`
  as plain text (`role="status"`, `var(--fs-small)`, `var(--text-2)`, no
  blue box), then the label `Room passphrase` and its field: full width,
  `2.75rem` tall, left-aligned, sans-serif at `var(--fs-body)`, styled like
  `.select-input`; red border when T46 marks it invalid; T46's message under
  it.
- Apply the two test edits listed in `<context>`.
- `tests/browser/viewer-join.spec.mjs` (no room is created; the two failed
  joins count against the limit of 20 a minute):
  - `the join card is centred and shows the code in six boxes`: at 1440x900
    on `/#watch`, the heading `Join a stream` is visible; `.join-card`'s
    horizontal centre equals the viewport's within 2px and its width is at
    most 416px; there are six `.code-box` elements, all empty; after typing
    `ab1` the first three show `A`, `B`, `1`, the field's value is `AB1` and
    `#joinHint` reads `3/6 characters`; after typing `2c3` the value is
    `AB1-2C3` and the six boxes read `A B 1 2 C 3`; the `Join Room` button
    has the class `btn-main` and spans the card's inner width.
  - `a pasted watch link fills the boxes`: filling the field with
    `https://example.test/#watch/QWE789` gives the value `QWE-789`.
  - `a code that arrives in the link is shown with its hyphen`: on
    `/#watch/QWE789` the value is `QWE-789`.
  - `errors sit under the boxes and turn them red`: pressing `Join Room` on
    an empty field shows the alert `Please enter a room code.` below the
    `.code-entry` and above the button (compare bounding boxes), inside the
    card, and each `.code-box` has the computed border colour of
    `var(--err)` (`rgb(229, 91, 91)`).
  - `an unknown room says what to do next`: joining `ZZZ999` shows the alert
    starting `No room has this code.`; the field has `aria-invalid="true"`;
    `Try another code` empties the field, removes the alert and focuses the
    field.
  - `the join card fits a phone`: at 390x844 and 320x640 the card is inside
    the viewport with at least 16px on each side, the six boxes are on one
    row, the button is at least 44px tall and the document does not scroll
    sideways.
</steps>

<constraints>
- Scope: the not-joined state of the Watch page. Joining itself, playback and
  the joined view do not change.
- Keep every hook listed in `<context>` with the same text, id and role.
- The page holds at most one `role="alert"` element at a time.
- Use tokens and classes from T43 (`.btn-main`, `--fs-*`, `--text-2`). No new
  colour literal, no new dependency.
- Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test. The two changed lines pin how a
  linked code used to be displayed; say so in your report.
- Match the surrounding code's naming, comments and indentation.
</constraints>

<acceptance_criteria>
- `/#watch` shows a centred card at most 416px wide with six code boxes and
  one `.btn-main` button named `Join Room`.
- Typed, pasted and linked codes all show as `XXX-XXX` in the field and one
  character per box.
- Errors render inside the card under the boxes; the boxes turn red; an
  unknown room shows the new sentence and `Try another code`.
- `tests/browser/ui-semantics.spec.mjs` passes unchanged in both projects;
  `tests/browser/media-flow.spec.mjs` passes with only lines 724 and 729
  changed; the six unit tests that read `src/WatchView.jsx` pass.
- `git diff --name-only` lists exactly `src/WatchView.jsx`,
  `src/components/UserErrorAlert.jsx`, `src/index.css`,
  `tests/browser/media-flow.spec.mjs` and
  `tests/browser/viewer-join.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npm run lint` and `npm run typecheck` — expected: exit 0.
2. `node --test tests/viewerSession.test.js tests/mediaDebug.test.js tests/playbackAttempt.test.js tests/relayAppendQueue.test.js tests/subscriptionLedger.test.js tests/timedAck.test.js tests/roomCode.test.js tests/userError.test.js tests/mediaFlowLockHooks.test.js`
   — expected: all pass.
3. `npx playwright test tests/browser/viewer-join.spec.mjs` — expected: six
   tests pass.
4. `npx playwright test tests/browser/ui-semantics.spec.mjs` — expected: all
   pass in both projects.
5. `npx playwright test tests/browser/media-flow.spec.mjs -g "passphrase|direct WebRTC and can rejoin"`
   — expected: all pass.
6. `npx playwright test tests/browser/home.spec.mjs` — expected: pass (the
   home page hands its code to this form).
7. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- `getByLabel('Room code')` stops being visible, fillable or focusable to
  Playwright with the input laid over the boxes.
- A test other than the two listed lines needs an edit.
- The Host page's error box changes appearance after the
  `UserErrorAlert` edit.
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
