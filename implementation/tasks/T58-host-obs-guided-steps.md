# T58 — Host: show OBS setup as three live steps in the preview

<model>
Model: `claude-opus-5-5`
Effort: `high`
Card: T58 in `../KANBAN.md`
Depends on: T57 done
</model>

<role>
You are a React engineer working on the part of the host page that sets OBS up.
The code that talks to OBS is carefully ordered and heavily tested, so you add
one small, optional signal to it, derive everything else from state the page
already has, and prove the result with unit and browser tests.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Screen 3 ·
Host, using OBS", mockup "Proposed" (the list inside the preview) and
checklist item "Guided OBS setup: three live steps in the stage, with the
manual route as a link". The spec below restates it; if the page cannot be
opened, this card stands alone.

What is there today (verified, `src/HostView.jsx`, line numbers as of commit
67a095a; T53 to T57 have changed the surrounding layout, so find these blocks
by their class names):

- While sharing in OBS mode the preview shows `Streaming via OBS` and a
  sub-line `Waiting for OBS...` or `OBS connected` (lines 2125-2133).
- A separate card `.obs-whip-setup-panel` (lines 2450-2541) with the heading
  `OBS WHIP Setup` carries: `.obs-status-line` messages (`is-info` while
  configuring, `is-ok` on success, `is-warn` with `role="alert"` on error, and
  an `is-warn` note about slow keyframes), a `Retry Auto-Configure OBS`
  button on error, a closed `<details className="obs-manual-details">`
  "Manual setup (if auto-config fails)" with the `WHIP URL` and
  `Bearer Token` copy fields, and a pill `OBS Connected` / `Waiting for OBS...`.
- State: `obsAutoStatus` (`''`, `'configuring'`, `'success'`, `'error'`) and
  `obsAutoMessage` (line 503-504), `whipConnected`, `obsAutoStart`.
- `runObsConfigure(token, options)` (lines 696-708) queues
  `configureObsStream(options)` and is used by Start Sharing (line 1794) and
  by Retry (line 2502). A result is applied only while its start operation is
  still current (`startGuardRef.current.isCurrent(...)`). Keep that rule for
  anything new you set from a configure.
- `configureObsStream` (`src/lib/obsWebSocket.js`, line 970) runs its work in
  the callback passed to `withObsConnection`; that callback starts only after
  OBS has accepted the connection. It ends through `finish(...)`; the
  success message is built at line 1354, after the optional auto-start block
  (lines 1325-1352).

Approved: the host sees three steps in the preview, each with its state,
instead of a card of status text:

1. `OBS found on this computer`
2. `Nextra applies the stream settings`
3. `OBS starts streaming`

States are `Done`, `Working…`, `Waiting` and, when something fails,
`Needs attention`. The manual route is one link, `Set it up by hand`.

The page cannot tell step 1 from step 2 today: it only learns the final
result. So this card adds one optional callback to `configureObsStream`,
called twice: once when OBS has accepted the connection and once when the
settings are written. Nothing else in that file changes.

Names and hooks the tests depend on (verified,
`tests/browser/host-obs-control-channel.spec.mjs`; keep all of them):

- `getByText('Streaming via OBS')` visible once sharing in OBS mode (line 273).
- `page.getByRole('alert').filter({ hasText: /OBS WebSocket/ })` visible after
  a failed setup (line 181). This locator must match exactly one element, so
  the error message may appear in only one `role="alert"`.
- Button `Retry Auto-Configure OBS` (lines 182, 193, 225, 321).
- `.obs-status-line.is-ok` contains `OBS configured` (lines 194, 290).
- `.obs-status-line.is-info` contains
  `Waiting for the previous OBS setup to finish` (line 281, checked within
  half a second of Start Sharing, so it must render at once).
- `.copy-field` with the text `WHIP URL` and its `.copy-field-value`, read
  with `textContent()` right after Start Sharing (line 250). `textContent()`
  works on an element inside a closed `<details>`, so the copy fields may
  stay folded away, but they must be in the document from the moment sharing
  starts.

No test refers to `.obs-whip-setup-panel`, `OBS WHIP Setup`, `OBS Connected`
or the manual setup summary text (verified by search).

That spec starts its own server with WHIP on and a stub that stands in for
OBS (`installObsStub`, modes `'down'`, `'up'` and `'hold'`; `'hold'` pauses
the setup at its stream-service write until `obs.release()`). Its helpers
`startObsSharing` and `startHeldObsConfigure` are the way to reach the failed
and the in-progress state.
</context>

<files>
Read: `src/HostView.jsx` lines 76-78, 500-517, 591-643, 690-708, 1776-1810,
and the OBS blocks named above as T53-T57 left them.
Read: `src/lib/obsWebSocket.js` lines 940-1040 and 1320-1362.
Read: `tests/obsWebSocket.test.js` lines 1-76 (the fake socket and
`withStream`) and the two tests at lines 165 and 226, which show how a
successful and a refused setup are driven.
Read: `tests/browser/host-obs-control-channel.spec.mjs` in full.
Read: `src/index.css` lines 1592-1645 (`.obs-status-line` to
`.obs-connection-status`) and the `.host-stage-empty` rules T53 added.

Edit: `src/lib/obsWebSocket.js` — `configureObsStream` only: one new optional
option and two calls to it.
Create: `src/lib/obsSetupSteps.mjs` and `tests/obsSetupSteps.test.js`.
Edit: `src/HostView.jsx` — one new state value, `runObsConfigure`, the OBS
overlay in the preview, and the `.obs-whip-setup-panel` block.
Edit: `src/index.css` — new `.obs-steps` rules directly after
`.obs-connection-status`; remove rules that no longer match anything.
Edit: `tests/obsWebSocket.test.js` — add one test at the end.
Edit: `tests/browser/host-obs-control-channel.spec.mjs` — add two tests at
the end.

Do not touch: any other function in `src/lib/obsWebSocket.js`,
`src/lib/obsOperationQueue.mjs`, `buildObsAutoConfig`, `stopObsIngest`,
`establishObsControlChannel`, the Retry button's handler body (it may move,
unchanged), the invite card (T56), the status line and Stop button (T57).
</files>

<task>
In OBS mode the preview lists the three setup steps: as a plain numbered list
before sharing, and with a live state per step from Start Sharing until OBS is
streaming. A failed step is marked, with the reason, Retry and a
`Set it up by hand` link next to it. The separate status card goes away; the
manual fields stay available under that link.
</task>

<steps>
1. `src/lib/obsWebSocket.js`: add `onProgress = null` to the options of
   `configureObsStream`. Call `onProgress?.('connected')` as the first
   statement inside the `withObsConnection` callback, and
   `onProgress?.('configured')` immediately before the
   `if (autoStart && !restartRequired)` block. Wrap each call so that an
   exception thrown by the callback is ignored. Add the option to the JSDoc.
   This step comes first because the other steps read the signal.
2. `tests/obsWebSocket.test.js`: add
   `configureObsStream reports connected, then configured, and stops reporting when the setup fails`.
   Drive one successful setup and one where OBS refuses to stop a stale
   stream (as the test at line 226 does); expect `['connected', 'configured']`
   for the first and `['connected']` for the second. Add a third case where
   the callback throws and the setup still succeeds.
3. `src/lib/obsSetupSteps.mjs`: export
   `obsSetupSteps({ autoStatus, progress, whipConnected, autoStart })`
   returning three objects `{ id, label, state, hint }` with ids `found`,
   `settings`, `streaming`, the three labels above, and `state` one of
   `'done' | 'working' | 'waiting' | 'attention' | 'idle'`:

   | Situation | found | settings | streaming |
   |---|---|---|---|
   | `autoStatus` `''` (not started) | idle | idle | idle |
   | configuring, no progress yet | working | waiting | waiting |
   | configuring, progress `connected` | done | working | waiting |
   | configuring, progress `configured` | done | done | working |
   | success, not `whipConnected`, `autoStart` on | done | done | working |
   | success, not `whipConnected`, `autoStart` off | done | done | waiting, hint `Press Start Streaming in OBS.` |
   | `whipConnected` (any status) | done | done | done |
   | error, no progress | attention | waiting | waiting |
   | error, progress `connected` | done | attention | waiting |
   | error, progress `configured` | done | done | attention |

   `tests/obsSetupSteps.test.js` (CommonJS, `node:test`, dynamic `import()`
   like `tests/hostPreflight.test.js`) covers every row.
4. `src/HostView.jsx`:
   - new state `obsSetupProgress` (`''`, `'connected'`, `'configured'`),
     reset to `''` wherever `obsAutoStatus` is reset (line 1027) and whenever
     a configure starts;
   - in `runObsConfigure`, pass
     `onProgress: (stage) => { if (guard.isCurrent(token)) setObsSetupProgress(stage); }`
     to `configureObsStream`;
   - before sharing, in OBS mode, the empty preview (T53's
     `.host-stage-empty`) shows the three labels as a numbered list
     (`<ol className="obs-steps">`) in place of its sub-line; hidden below
     640px wide, as the sub-line is;
   - while sharing in OBS mode and not yet `whipConnected`, the preview
     overlay shows the title `Streaming via OBS`, then the same list with a
     state word at the right of each row (`Done`, `Working…`, `Waiting`,
     `Needs attention`), the step's hint under its label when it has one,
     then the `.obs-status-line` message for the current status (same
     classes, roles and text as today), then, on error, the
     `Retry Auto-Configure OBS` button (`btn btn-secondary`) and a
     link-styled button `Set it up by hand`;
   - once `whipConnected`, the list and the status line leave the preview and
     the existing sub-line (`OBS connected · H264 · N viewers`) shows, as
     today;
   - the side column keeps one block under the invite card:
     `<details className="obs-manual-details">` with the summary
     `Set it up by hand`, holding the two copy fields and the notes
     unchanged. It is rendered from the moment sharing starts. The stage's
     `Set it up by hand` button opens it and moves focus to its summary;
   - the slow-keyframe note keeps its text and its
     `obs-status-line is-warn` classes and moves to the row of notices under
     the preview (where T54 put the page's alerts);
   - remove the heading `OBS WHIP Setup`, the `.obs-connection-status` pill
     and the "OBS WHIP endpoint is starting..." line's card; show that last
     message as the `.obs-status-line is-warn` in the preview instead.
5. CSS: `.obs-steps` is a list without bullets, at most 22rem wide, centred
   in the preview; rows 8px apart; each row has a 22px round marker (number,
   check mark when done, spinner when working, exclamation mark when it needs
   attention), the label at `var(--fs-small)` in `var(--text-1)`, and the
   state word at `var(--fs-label)` in `var(--text-2)` (`var(--ok)` when done,
   `var(--warn)` when it needs attention). The spinner stops under
   `prefers-reduced-motion: reduce`. The list must fit a 304px-tall preview
   (1280x720) together with the title and one status line.
6. `tests/browser/host-obs-control-channel.spec.mjs`, two tests at the end:
   - `the three OBS setup steps show where a failed setup stopped and recover on retry`:
     after `startObsSharing` (OBS down) the list has three items in the
     order above, the first reads `Needs attention`, the other two
     `Waiting`; exactly one `role="alert"` contains `OBS WebSocket`; the
     `Set it up by hand` button opens the details and the `WHIP URL` field
     becomes visible. Then `obs.mode = 'up'`, press Retry: the first two
     items read `Done` and `.obs-status-line.is-ok` contains
     `OBS configured`.
   - `the OBS setup steps follow a setup that is held at its settings write`:
     with `startHeldObsConfigure`, while the stub holds the write the first
     item reads `Done` and the second `Working…`; after `obs.release()` the
     second reads `Done`.
   Each test ends like its neighbours (stop sharing, wait for the stub's
   connections to close).
</steps>

<constraints>
- Scope: how OBS setup progress is shown. The order and content of what is
  sent to OBS must not change; the only edit to `src/lib/obsWebSocket.js` is
  the optional callback.
- Keep every hook listed in `<context>`, with the same text, class and role.
- A progress value from a start operation that is no longer current must not
  reach the page.
- Use tokens and classes from T43. No new colour literal, no new dependency,
  inline SVG for the marker icons.
- Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test. No existing assertion in the OBS spec
  or in `tests/obsWebSocket.test.js` should need a change; if one does,
  escalate.
- Match the surrounding code's naming, comments and indentation.
</constraints>

<acceptance_criteria>
- `configureObsStream` accepts `onProgress` and reports `connected`, then
  `configured`; without the option it behaves exactly as before.
- In OBS mode the preview shows the three steps before sharing and their
  live states from Start Sharing until OBS is streaming.
- A failed setup marks the step it stopped at, shows the reason once, and
  offers Retry and `Set it up by hand`.
- The card headed `OBS WHIP Setup` is gone; the `WHIP URL` and
  `Bearer Token` fields are under `Set it up by hand`.
- Every existing test in `tests/browser/host-obs-control-channel.spec.mjs`
  and every `tests/obs*.test.js` file passes unchanged.
- `git diff --name-only` lists only files named in `<files>`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npm run lint` and `npm run typecheck` — expected: exit 0.
2. `node --test tests/obsWebSocket.test.js tests/obsSetupSteps.test.js tests/obsOperationQueue.test.js tests/obsStopThroughChannel.test.js tests/obsWebSocketWire.test.js`
   — expected: all pass, including the new tests.
3. `npx playwright test tests/browser/host-obs-control-channel.spec.mjs` —
   expected: all pass, including the two new tests.
4. `npx playwright test tests/browser/host-layout.spec.mjs tests/browser/host-live.spec.mjs`
   — expected: all pass.
5. `npx playwright test tests/browser/ui-semantics.spec.mjs` — expected: all
   pass in both projects.
6. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- Reporting progress needs a change to `withObsConnection`, the transaction
  or the operation queue.
- The three steps, the title and a status line cannot fit a 304px-tall
  preview.
- An existing assertion in the OBS spec or an OBS unit test fails.
- The stub in the OBS spec cannot reach the "held at the settings write"
  state without changing `installObsStub`.
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
