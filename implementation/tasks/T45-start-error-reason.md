# T45 — Show the real reason when sharing cannot start

<model>
Model: `claude-sonnet-5-5`
Effort: `low`
Card: T45 in `../KANBAN.md`
Depends on: none
</model>

<role>
You are a front-end engineer fixing a misleading error message. You write the
failing unit test first, then make the smallest change to the message mapping.
</role>

<context>
When the host presses Start Sharing and the start is refused before a screen
picker ever opens, the page still says "Choose a screen or window, allow
sharing, and try again." The real reason is hidden under "Technical details".

Two cases, both verified in the running app:

- OBS selected while the OBS endpoint is not ready. The real reason is
  "OBS WHIP is still starting. Wait for it to become ready, then retry."
- A browser with no screen capture (for example a phone). The real reason is
  "Screen capture is unavailable in this browser. Use desktop Chrome or Edge."

Why it happens (verified by reading the source):

- `src/HostView.jsx` line 1606 throws the preflight blockers joined into one
  message; the catch at line 1837 wraps every non-cancel failure as
  `` `Failed to start sharing: ${err.message}` ``.
- `src/lib/userError.mjs` line 7 treats any message matching
  `/screen sharing was cancelled|failed to start sharing|getdisplaymedia|notallowederror/i`
  as a cancelled picker. The `failed to start sharing` alternative matches the
  wrapper, so every wrapped failure gets picker advice.
- `describeUserError` returns `{ action, detail }`. When no rule matches it
  returns the message itself as `action` and an empty `detail`, which
  `src/components/UserErrorAlert.jsx` shows as plain text with no fold-out.

What must keep working (verified in the tests):

- `tests/userError.test.js` expects `'Failed to start sharing: NotAllowedError'`
  to give advice matching `/allow sharing/i`. It still will: that message also
  contains `NotAllowedError`.
- `tests/browser/media-flow.spec.mjs` line 653 expects the alert to contain
  `Screen capture is unavailable`; lines that expect
  `Screen sharing was cancelled.` and `tests/browser/host-reload-recovery.spec.mjs`
  expectations of `Press Resume Sharing to try again.`, `test: no send transport`
  and `Room reclaim was rejected.` use `toContainText`, which also reads the
  folded detail, so they pass either way.
</context>

<files>
Read: `src/lib/userError.mjs` — the whole file (25 lines).
Read: `tests/userError.test.js` — the whole file (21 lines).
Read: `src/components/UserErrorAlert.jsx` — how `action` and `detail` render.
Read: `src/HostView.jsx` lines 1811-1838 — where the wrapper text is built.

Edit: `tests/userError.test.js` — add one new test; keep the existing one as is.
Edit: `src/lib/userError.mjs` — the second entry of `FAILURE_ADVICE` only.

Do not touch: `src/HostView.jsx`, `src/lib/hostPreflight.mjs` — the messages
they produce are correct; only the mapping is wrong.
</files>

<task>
A start failure that is not a cancelled or denied screen picker shows its own
reason as the visible message. Cancelled and denied pickers keep the current
advice.
</task>

<steps>
Order matters: the new test must fail against the unchanged mapping.

1. Add a test named
   `'a start failure that is not a cancelled picker shows its own reason'` to
   `tests/userError.test.js`. For each of these two inputs:
   - `'Failed to start sharing: OBS WHIP is still starting. Wait for it to become ready, then retry.'`
   - `'Failed to start sharing: Screen capture is unavailable in this browser. Use desktop Chrome or Edge.'`

   assert that `describeUserError(input).action` equals the input, that
   `.detail` is `''`, and that `.action` does not match `/choose a screen/i`.
   In the same test assert that `'Screen sharing was cancelled.'` and
   `'Failed to start sharing: NotAllowedError'` still give an action matching
   `/allow sharing/i`.
2. Run `node --test tests/userError.test.js` and record the failure.
3. In `src/lib/userError.mjs`, remove the `failed to start sharing` alternative
   from the second rule's pattern, leaving
   `/screen sharing was cancelled|getdisplaymedia|notallowederror/i`.
4. Run the checks.
</steps>

<constraints>
- Scope: one pattern in `src/lib/userError.mjs` and one added test.
- Do not reword any message, add a new rule, or strip the
  "Failed to start sharing: " prefix. The prefix plus the reason reads plainly.
- Keep the order of `FAILURE_ADVICE`: a wrapped timeout or transport failure
  must still reach the rules after this one.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test.
- Match the surrounding style (CommonJS test, ES module source, four spaces).
</constraints>

<acceptance_criteria>
- The new test fails before the source change and passes after it.
- The existing test in `tests/userError.test.js` passes unchanged.
- `describeUserError('Failed to start sharing: WebRTC connection timed out (ICE could not connect).').action`
  still matches `/check your network/i` (covered by reading the rule order).
- `git diff --name-only` lists exactly `src/lib/userError.mjs` and
  `tests/userError.test.js`.
</acceptance_criteria>

<verification>
Run in this order.

1. `node --test tests/userError.test.js` after adding the test and before
   editing the source — expected: the new test fails. Quote the assertion.
2. `node --test tests/userError.test.js` after the change — expected: all pass.
3. `npm run lint` — expected: exit 0.
4. `npx playwright test tests/browser/media-flow.spec.mjs -g "Host preflight blocks"`
   — expected: pass.
5. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- The new test passes before the source change.
- A browser test listed in `<context>` fails after the change; report its name
  and the alert text it saw.
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
