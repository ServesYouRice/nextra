# T64 — Status: one health line, three plain numbers, one line per room

<model>
Model: `claude-sonnet-5-5`
Effort: `medium`
Card: T64 in `../KANBAN.md`
Depends on: T43 and T52 done
</model>

<role>
You are a React engineer reshaping a read-only status page so that anyone can
read it at a glance, with the engineer numbers one press away. You change
presentation only and prove it with a browser test that feeds the page fixed
numbers.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Screen 9 ·
Status", mockup "Proposed". The spec below restates it; if the page cannot be
opened, this card stands alone.

Today (verified, `src/StatusView.jsx`, 207 lines):

- Six boxes of equal weight (`Active rooms`, `WebRTC viewers`,
  `Relay viewers`, `WHEP viewers`, `Media consumers`, `Uptime`), then a
  nine-column table "Active rooms" (Room, Mode, Live, Viewers, Relay, WHEP,
  Consumers, Relay out, Age), then four more boxes "Runtime counters"
  (`Active producers`, `Active consumers`, `Connected viewers`,
  `Relay subscribers`).
- A room without a picture is labelled `idle`.
- The page polls `/api/metrics` every 5 seconds through
  `createMetricsFetcher()` (`src/lib/metricsFetcher.mjs`). The fields it
  reads: `rooms.active`, `rooms.totalViewers`, `rooms.totalRelayViewers`,
  `rooms.totalWhepViewers`, `rooms.totalMediasoupConsumers`,
  `rooms.list[]` (`code`, `ingestMode`, `obsAv1Mode`, `obsVideoCodec`,
  `hasProducer`, `whipConnected`, `viewerCount`, `relayViewerCount`,
  `whepViewerCount`, `mediasoupConsumerCount`, `createdAt`),
  `sockets.uptimeSec`, `sockets.counters.*`, `sockets.rooms[]` (`code`,
  `relay.bytesForwarded`).
- The Host page counts viewers as `viewerCount + whepViewerCount`
  (`src/HostView.jsx` line 2102). Use the same sum here.
- Three other states render before the main view and stay as they are:
  access restricted, unavailable with Retry, and loading.

Approved:

1. One line says whether everything is fine.
2. Three numbers anyone can read.
3. Each room is one plain line: code, state, where the picture comes from,
   who is watching, age.
4. The engineer numbers stay, one press away.

Names and hooks the tests depend on (verified,
`tests/browser/ui-semantics.spec.mjs` lines 113-124 and the reflow loop at
lines 213-230; keep them):

- `getByRole('heading', { name: 'Server Status' })` is visible.
- `getByText('Active rooms').first()` is visible. Decision already made for
  you: the heading above the room list keeps the text `Active rooms`, and
  the first number is labelled `Rooms open`.
- `/#status` does not scroll sideways at any width from 320px to 2560px.
- `tests/statusCopy.test.js` pins `STATUS_ACCESS_RESTRICTED_COPY`.

Shared styles (verified): `.table-wrap` and `.data-table` are also used by
the How to Use page; `.stat-card` got the card gradient in T43. T52 created
`src/lib/roomCode.mjs` with `formatRoomCode(code)`.

A browser test can answer `/api/metrics` itself with
`page.route('**/api/metrics', (route) => route.fulfill({ json: ... }))`, so
it needs no room and gets fixed numbers. Assumption: the route pattern also
matches the fetcher's URL when it carries a query string; check
`src/lib/metricsFetcher.mjs` and adjust the pattern if needed.
</context>

<files>
Read: `src/StatusView.jsx`, `src/lib/statusCopy.mjs`,
`src/lib/metricsFetcher.mjs`, `src/lib/roomCode.mjs`,
`src/components/StatusPill.jsx`, `tests/statusCopy.test.js`.
Read: `src/index.css` lines 1738-1876 (STATUS PAGE section) and 881-929
(`.status-pill`).
Read: `tests/browser/ui-semantics.spec.mjs` lines 113-124 and 213-230.

Edit: `src/StatusView.jsx` — the main view (from `const rooms =` to the end)
and the three local format helpers.
Edit: `src/lib/statusCopy.mjs` — add four exported functions.
Edit: `tests/statusCopy.test.js` — add tests.
Edit: `src/index.css` — the STATUS PAGE section only (`.status-container` to
`.status-error-card`); new rules go directly before `.status-error-card`.
Put this card's responsive rules in their own `@media` blocks inside that
section.
Create: `tests/browser/status-page.spec.mjs`.

Do not touch: `.table-wrap` and `.data-table` rules (the How to Use page
shares them), `.status-pill`, the denied, error and loading states,
`src/lib/metricsFetcher.mjs`, the server.
</files>

<task>
The Status page opens with a health line, three plain numbers and one line
per room, and folds every engineer number into a closed
"More numbers for troubleshooting" section. Nothing is removed from what an
engineer can read there.
</task>

<steps>
- `src/lib/statusCopy.mjs`, with tests in `tests/statusCopy.test.js`:
  - `formatPlainDuration(totalSeconds)`: `45 s`, `9 min`, `2 h 5 min`,
    `3 d 4 h`; negative or non-numeric input gives `0 s`.
  - `describeRoomState(room)`: `Live` when `hasProducer` or `whipConnected`
    is true, otherwise `Host paused`.
  - `describeRoomSource(room)`: `From this browser`; `From OBS` for
    `ingestMode === 'obs'`; `From OBS · AV1` when `obsAv1Mode` is true or
    `obsVideoCodec === 'av1'`.
  - `countRoomViewers(room)`: `viewerCount + whepViewerCount`, treating
    missing values as 0.
- Head: `<h1>Server Status</h1>` at `var(--fs-title)`. Under it one line:
  a `StatusPill` with tone `ok` reading `All good`, then
  ` · up <formatPlainDuration(uptime)>`. While a refresh has failed
  (`error` set with metrics still on screen) the pill has tone `warn` and
  reads `Not updating`; the existing "Refresh failed" alert stays. At the
  right end of the line, `Updated <time>` in `var(--fs-small)`,
  `var(--text-3)`. Remove the old subtitle and the "Auto-refreshing" pill.
- Three numbers in one row (`.stats-grid` with three equal columns; one
  column at 640px wide and below, value and label side by side): `Rooms
  open` (`rooms.active`), `People watching`
  (`totalViewers + totalWhepViewers`), `On the backup connection`
  (`totalRelayViewers`). Value at `var(--fs-title)`, mono font; label at
  `var(--fs-small)`, `var(--text-2)`, sentence case, not uppercase.
- `<h2 className="panel-heading">Active rooms</h2>`, then, when there are
  rooms, `<ul className="status-rooms">` with one `<li>` per room holding,
  in this order: the code in the mono font written with
  `formatRoomCode` (or `(hidden)` when the server sent none); a
  `StatusPill` with `describeRoomState` (tone `ok` for `Live`, `warn` for
  `Host paused`); `describeRoomSource`; `N watching` from
  `countRoomViewers`; and the age as `formatPlainDuration`. Rows are
  separated by hairlines inside one card (card gradient, 12px corners);
  items sit on one line from 640px up and wrap to two lines below. With no
  rooms, keep `No active rooms right now.`
- `<details className="status-more">` with the summary
  `More numbers for troubleshooting` (at least 44px tall, closed by
  default) holding: a `.stats-grid` with `WebRTC viewers`,
  `Relay viewers`, `WHEP viewers`, `Media consumers`, `Active producers`,
  `Active consumers`, `Connected viewers`, `Relay subscribers` (same values
  as today); then the existing nine-column table inside `.table-wrap`,
  unchanged.
- `tests/browser/status-page.spec.mjs` (no room; the test answers
  `/api/metrics` itself). With a fixed payload of two rooms (one browser
  room `ABC123`, live, 2 viewers and 1 WHEP viewer, created 5 minutes ago;
  one OBS AV1 room `XYZ789`, not live, no viewers, created 2 hours 5
  minutes ago), `rooms.active` 2, `totalViewers` 2, `totalWhepViewers` 1,
  `totalRelayViewers` 1 and `sockets.uptimeSec` 540:
  - the heading `Server Status` is visible and the health line contains
    `All good` and `up 9 min`;
  - exactly three `.stat-card` elements are visible, labelled `Rooms open`
    (value `2`), `People watching` (`3`) and `On the backup connection`
    (`1`);
  - `.status-rooms li` has count 2; the first contains `ABC-123`, `Live`,
    `From this browser`, `3 watching` and `5 min`; the second contains
    `XYZ-789`, `Host paused`, `From OBS · AV1`, `0 watching` and
    `2 h 5 min`; the text `idle` has count 0;
  - `WebRTC viewers` and `Relay subscribers` are not visible until
    `More numbers for troubleshooting` is opened; then both are, and the
    table has nine column headers;
  - with the route answering 500 after the first success, the health line
    reads `Not updating` and an alert starting `Refresh failed` shows;
  - at 390x844 each room's text is inside the viewport, the summary row is
    at least 44px tall and the document does not scroll sideways.
</steps>

<constraints>
- Scope: the main view of the Status page and its section of the
  stylesheet. No number is dropped; engineer numbers move, they are not
  removed.
- Keep the heading `Server Status`, the heading `Active rooms`, and the
  three early-return states.
- Use tokens and classes from T43; cards keep the card gradient. No new
  colour literal, no new dependency.
- Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test; no existing assertion needs a
  change.
- Match the surrounding code's naming, comments and indentation.
</constraints>

<acceptance_criteria>
- The page shows a health line, three numbers and one line per room; the
  word `idle` no longer appears.
- All eight engineer counters and the nine-column table are inside a closed
  `More numbers for troubleshooting` section.
- The four new functions exist and their tests pass.
- `tests/browser/ui-semantics.spec.mjs` passes unchanged in both projects.
- `git diff --name-only` lists exactly `src/StatusView.jsx`,
  `src/lib/statusCopy.mjs`, `tests/statusCopy.test.js`, `src/index.css` and
  `tests/browser/status-page.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npm run lint` and `npm run typecheck` — expected: exit 0.
2. `node --test tests/statusCopy.test.js tests/roomCode.test.js` —
   expected: all pass, including the new tests.
3. `npx playwright test tests/browser/status-page.spec.mjs` — expected: all
   pass.
4. `npx playwright test tests/browser/ui-semantics.spec.mjs -g "status route|content reflows"`
   — expected: all pass in both projects.
5. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- `page.route` cannot intercept the page's metrics request.
- A number shown today has no place in the new layout.
- Moving the nine-column table inside `<details>` makes `/#status` scroll
  sideways at any tested width.
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
