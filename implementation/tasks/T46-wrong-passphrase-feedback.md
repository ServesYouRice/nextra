# T46 — Tell the viewer when the room passphrase was wrong

<model>
Model: `claude-sonnet-5-5`
Effort: `medium`
Card: T46 in `../KANBAN.md`
Depends on: none
</model>

<role>
You are a React engineer fixing missing feedback on a form. You write the
failing browser test first, then make the smallest change in the join form.
</role>

<context>
A room can have a passphrase. A viewer who joins such a room is asked for it as
a second step. If the viewer then types a wrong passphrase and submits, nothing
on the page changes: no message, no red field, and the hint under the form
still talks about the room code. Verified in the running app.

Why (verified by reading the source):

- `lib/socket.js` lines 2126-2131 answer both "no passphrase sent" and "wrong
  passphrase" with the same reply:
  `{ success: false, error: 'Room passphrase required or incorrect.', requiresPassphrase: true }`.
  The server deliberately does not tell the two apart. Leave it that way.
- `src/WatchView.jsx`, `handleJoin` (lines 1049-1105): the catch at lines
  1095-1097 runs `setPassphraseRequired(true); setError('');` in both cases.
- The page already knows the difference: on the first prompt the passphrase
  field was not on screen yet; on a wrong try `passphraseRequired` was already
  true and the viewer submitted a non-empty passphrase.

Facts that constrain the change (verified):

- Several unit tests read `src/WatchView.jsx` as text and check function order
  and fragments: `tests/viewerSession.test.js`, `tests/mediaDebug.test.js`,
  `tests/playbackAttempt.test.js`, `tests/relayAppendQueue.test.js`,
  `tests/subscriptionLedger.test.js`, `tests/timedAck.test.js`. Do not rename,
  move or re-order the existing `useCallback` functions, and add new dependency
  entries at the end of a dependency array, never at the start.
- `tests/mediaFlowLockHooks.test.js` imports `tests/browser/media-flow.spec.mjs`
  with a stub `test` object that only has `beforeEach` and `afterEach`. Add
  tests with plain `test('name', async (...) => { ... })`. Do not use
  `test.describe`, `test.use`, `test.skip` or `test.step` at module level.
- The existing test
  `a protected room asks for its passphrase as a focused second step and keeps the code`
  (`tests/browser/media-flow.spec.mjs` lines 715-745) must pass unchanged: the
  info text matching `/requires a passphrase.*code has been kept/i`, the label
  `Room passphrase`, focus on the passphrase field, and the code staying in the
  `Room code` field.
- The server allows 20 join attempts a minute per address
  (`JOIN_RATE_LIMIT_MAX`, `config.js` line 324); the new test uses three.
- T47 adds a test to the same spec file at another place and edits other
  functions of `src/WatchView.jsx`. Stay inside the regions named below.
</context>

<files>
Read: `src/WatchView.jsx` lines 103-140 (state), 1049-1105 (`handleJoin`),
1706-1777 (the join form JSX).
Read: `tests/browser/media-flow.spec.mjs` lines 38-57 (`readRoomCode`,
`startHost`), 605-611 (`confirmStopIfPrompted`), 715-745 (the existing
passphrase test).
Read: `src/index.css` lines 1664-1700 — `.join-form`, `.join-hint`,
`.input-code[aria-invalid='true']`.

Edit: `tests/browser/media-flow.spec.mjs` — add one test directly after the
existing passphrase test (after line 745).
Edit: `src/WatchView.jsx` — one new state value beside `passphraseRequired`
(line 119), `handleJoin` (lines 1049-1105), and the join form JSX from the
passphrase block to the hint (lines 1749-1776).
Edit: `src/index.css` — one new rule `.field-error` placed directly after the
`.input-code[aria-invalid='true']` rule (lines 1696-1698).

Do not touch: `lib/socket.js` — the server answer stays as it is.
Do not touch: any other function in `src/WatchView.jsx`, in particular the
socket handlers at lines 880-976 and the video overlays at lines 1793-1827
(T47 owns them).
</files>

<task>
After a wrong passphrase the viewer sees "That passphrase didn't match. Check
it and try again." directly under the passphrase field, the field is marked
invalid and keeps focus, and a correct passphrase then joins as before. The
first prompt for a passphrase looks exactly as it does today.
</task>

<steps>
Order matters: the test must be seen failing against the unchanged source.

1. Add a test named
   `'a wrong room passphrase is reported next to the field and can be corrected'`
   after the existing passphrase test. It starts a host with
   `startHost(hostPage, { passphrase: 'open sesame' })`, opens
   `` `/#watch/${code}` `` in a viewer page, presses Join Room, fills the
   `Room passphrase` field with `wrong` and presses Enter. Then it expects:
   - `viewerPage.getByRole('alert')` to have the text
     `That passphrase didn't match. Check it and try again.`;
   - the passphrase field to have `aria-invalid="true"`, to be focused, and to
     have an `aria-describedby` that contains the id of that alert;
   - the `Room code` field to still hold the code. Compare with hyphens
     removed (`(await codeInput.inputValue()).replace(/-/g, '')`), because a
     later card changes how a linked code is displayed.

   It then fills `open sesame`, presses Enter and expects the alert to be gone
   (`toHaveCount(0)`) and the button `Watch Stream` to be visible. It ends like
   the neighbouring test: Stop Sharing on the host, `confirmStopIfPrompted`,
   Leave Room on the viewer, and a poll of `/api/metrics` until
   `rooms.active` is 0, then closes both contexts.
2. Run `<verification>` step 1 and record the failure.
3. In `src/WatchView.jsx`:
   - add `const [passphraseRejected, setPassphraseRejected] = useState(false);`;
   - in `handleJoin`, before the join attempt, remember whether this submit
     carried a passphrase for a room already known to need one
     (`passphraseRequired && passphrase.length > 0`); in the
     `err.requiresPassphrase` branch set `passphraseRejected` to that value;
     clear it at the start of every `handleJoin` and when the join succeeds;
   - clear it where the code field's `onChange` already resets
     `passphraseRequired` (line 1728) and in the passphrase field's `onChange`;
   - under the passphrase input render, only when `passphraseRejected`,
     `<p className="field-error" id="passphraseError" role="alert">That passphrase didn't match. Check it and try again.</p>`,
     and give the input `aria-invalid` and `aria-describedby="passphraseError"`
     in that state;
   - after a rejected try keep focus in the passphrase field (the existing
     effect at lines 195-197 focuses it when `passphraseRequired` turns true;
     it must also run after a rejection);
   - while the passphrase step is on screen, the hint (`#joinHint`) reads
     `Enter the passphrase the host gave you.` instead of the room-code hint.
4. In `src/index.css` add `.field-error { color: #f5a3a3; font-size: 0.8rem; text-align: center; }`.
5. Run the checks.
</steps>

<constraints>
- Scope: the join form only. No server change, no new component, no helper
  module.
- Do not clear the passphrase the viewer typed; they may want to fix a typo.
- The first passphrase prompt must not show the error: nothing was wrong yet,
  and the viewer has only just learned the room needs a passphrase.
- Keep the ids `roomCode`, `roomPassphrase`, `joinHint`, `watchError` and the
  labels `Room code` and `Room passphrase`.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test.
- Match the surrounding code's naming, comments and four-space indentation.
</constraints>

<acceptance_criteria>
- The new test fails before the source change and passes after it.
- The existing passphrase test passes unchanged.
- After a wrong passphrase, `#roomPassphrase` has `aria-invalid="true"` and
  `aria-describedby="passphraseError"`, and `#passphraseError` has
  `role="alert"`.
- Typing in the passphrase field or changing the room code removes the error.
- The six unit tests that read `src/WatchView.jsx` pass.
- `git diff --name-only` lists exactly `src/WatchView.jsx`, `src/index.css`
  and `tests/browser/media-flow.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npx playwright test tests/browser/media-flow.spec.mjs -g "wrong room passphrase"`
   before editing the source — expected: fails waiting for the alert. Quote it.
2. The same command after the change — expected: pass.
3. `npx playwright test tests/browser/media-flow.spec.mjs -g "protected room asks for its passphrase"`
   — expected: pass.
4. `node --test tests/viewerSession.test.js tests/mediaDebug.test.js tests/playbackAttempt.test.js tests/relayAppendQueue.test.js tests/subscriptionLedger.test.js tests/timedAck.test.js tests/mediaFlowLockHooks.test.js`
   — expected: all pass.
5. `npx playwright test tests/browser/ui-semantics.spec.mjs -g "room code field"`
   — expected: pass.
6. `npm run lint` and `npm run typecheck` — expected: exit 0.
7. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- The new test passes before the source change.
- The server answer for a wrong passphrase is not the one quoted in
  `<context>`.
- A unit test that reads `src/WatchView.jsx` fails and the fix would need a
  function moved or renamed.
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
