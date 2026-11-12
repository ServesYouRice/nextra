# T56 — Host: an invite card with the room code and one row per link

<model>
Model: `claude-opus-5-5`
Effort: `high`
Card: T56 in `../KANBAN.md`
Depends on: T55 done
</model>

<role>
You are a React engineer building the card a host uses to invite viewers. It
spans three components and the host view, and several test files read room
codes out of it, so you keep its hooks stable and prove every state.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Screen 4 ·
Host, while sharing", the two mockups labelled "Proposed" ("three links:
public, local and player" and "one link: local only") and the box "How the
invite card handles links". The owner approved this layout (called B) and
added: "keep in mind there can be multiple links". The spec below restates
it; if the page cannot be opened, this card stands alone.

What is wrong today (verified in the running app): once sharing starts, the
link viewers need is small monospace text that wraps in the middle of the
code, nothing shows it can be copied, the page shows no room code although
viewers can join by code, and the card carries engineer text such as
"WebRTC consumers: 2 | Relay out: 0 B".

What exists (verified):

- `src/HostView.jsx` lines 2087-2101 compute `localWatchLink`,
  `publicWatchLink`, `showPublicLink`, `publicLinkHint` (three variants:
  starting, error, unavailable) and `whepPlaybackUrl`. Lines 2413-2449 render
  `.room-info` with `<RoomSharePanel>`, `.viewer-count` (a `StatusPill` with
  "N viewer(s)") and one or two `.room-meta` lines. In OBS mode a second card,
  `.obs-whip-setup-panel` (lines 2450-2541), sits beside it inside
  `.streaming-info-row`.
- `src/components/RoomSharePanel.jsx` renders up to three `<CopyField>`s:
  `Local Link`, `Public Link`, `External Player (WHEP)`.
- `src/components/CopyField.jsx` renders `.copy-field` with a
  `.copy-field-label`, a `<button className="copy-field-value">` that copies on
  click, and a polite "Copied!" status; it also raises a toast through
  `useNotifications`. It is used as well for `WHIP URL` and `Bearer Token` in
  the OBS manual setup; those two uses must look and behave as today.
- A viewer can type a code with or without the hyphen
  (`normalizeRoomCode` removes hyphens).
- After T54 the idle page aligns a 260px panel with the preview using a grid
  row whose height the preview sets. Use the same technique here.
- After T54 the error and notice boxes and the diagnostics row sit under the
  preview and side column, in both the idle and the sharing state.

Hooks other tests depend on (verified; keep all of them):

- Room codes are read with
  `page.locator('.copy-field', { hasText: 'Local Link' }).locator('.copy-field-value').innerText()`
  and then split at `#watch/`: `tests/browser/media-flow.spec.mjs` lines
  41-43, `tests/browser/ui-semantics.spec.mjs` lines 443-445 and 544-546,
  `tests/browser/host-reload-recovery.spec.mjs` lines 358-359,
  `tests/browser/packaged-media.packaged.mjs` lines 41-43. `hasText` ignores
  case, so the label "Local link · same network" still matches. The
  `innerText` of that element must stay the complete link with no line break
  inside it, however the link is shortened on screen.
- `hostPage.getByText('Local Link')` must be visible
  (`media-flow.spec.mjs` line 735).
- `page.locator('.viewer-count')` contains `1 viewer`
  (`host-reload-recovery.spec.mjs` line 638). Keep the class and the wording
  "N viewer" / "N viewers"; T57 moves the element, not this card.
- `.copy-field` with the text `WHIP URL` and its `.copy-field-value`
  (`tests/browser/host-obs-control-channel.spec.mjs` line 250, read with
  `textContent()`).

Test environment facts (verified):

- The shared Playwright server runs with `SHARE_BASE_URL` set and WHEP off, so
  a host there sees a public and a local link.
- A spec can start its own server with other settings:
  `tests/browser/host-reload-recovery.spec.mjs` lines 20-87 show how
  (`claimServerPorts`, `clientBuildDir`, `/readyz`, `/api/test/shutdown`).
  Assumption: `WHEP_ENABLED: 'true'` needs no other setting for the host page
  to show the player link.
- The server allows 10 room creations a minute per address
  (`config.js` line 322), and `media-flow.spec.mjs` asserts on the server's
  only room. Create one room per server in the new spec, stop sharing at the
  end, and wait until `/api/metrics` reports `rooms.active` 0.
</context>

<files>
Read: `src/HostView.jsx` lines 2086-2103, 2104-2260 (how T53 and T54 left the
stage and layout), 2413-2553.
Read: `src/components/RoomSharePanel.jsx`, `src/components/CopyField.jsx`,
`src/components/HostDiagnostics.jsx`, `src/components/StatusPill.jsx`,
`src/context/NotificationContext.jsx`.
Read: `src/index.css` lines 969-1041 (copy field), 1503-1590 (room info), the
panel alignment rules T54 added, and the `.room-*` and `.copy-field-*` rules
inside the media queries.
Read: `tests/browser/host-reload-recovery.spec.mjs` lines 1-87;
`tests/browser/ui-semantics.spec.mjs` lines 511-549.

Edit: `src/components/RoomSharePanel.jsx` — rewritten as the invite card's
content.
Edit: `src/components/CopyField.jsx` — optional props for a shortened value
and a separate copy button; default behaviour unchanged.
Edit: `src/components/HostDiagnostics.jsx` — three added rows for the numbers
that leave the card.
Edit: `src/HostView.jsx` — `publicLinkHint` (lines 2089-2097) and the
`.room-info` block (lines 2413-2449), plus the wrapper that places it beside
the preview.
Edit: `src/index.css` — the COPY FIELD section, the `.room-info`,
`.room-code-display`, `.room-links-row`, `.viewer-count`, `.room-meta` and
`.streaming-info-row` rules, and their counterparts in the media queries; new
rules for the invite card go directly after `.room-meta`.
Create: `tests/browser/host-live.spec.mjs`.

Do not touch: the Stop button, the live toggles and `.status-bar` (lines
2203-2256; T57 owns them), `.obs-whip-setup-panel` contents (T58), the idle
panel, any handler or socket code, any existing spec file.
</files>

<task>
While sharing, an "Invite viewers" card sits beside the preview with the same
top and bottom edges. It shows the room code first, then one tidy row per
available link with its own copy button, marks the best link to share and
gives it the page's one bright button. It handles one, two and three links.
The engineer numbers live under "Troubleshooting diagnostics".
</task>

<steps>
- Layout from 900px up: preview (at most 800px) and the card side by side,
  gap 18px; the card is about 350px wide (`21.875rem`) and exactly as tall as
  the preview (grid row sized by the preview; card `height: 0;
  min-height: 100%`; its link list scrolls inside if it ever overflows).
  Below 900px: one column, card full width, natural height.
- Card: card gradient (`var(--surface-glass-accent), var(--surface-glass)`),
  18px corners, 16px padding. Top to bottom:
  1. Title `Invite viewers` (`var(--fs-body)`, weight 600).
  2. Label `Room code` (12px, uppercase, `var(--text-3)`), then the code in
     the mono font, 30px, weight 700, letter-spacing 0.08em, written with a
     hyphen after the third character (`VW6-349`), and a square copy button
     (34px; 44px at 640px wide and below) named `Copy room code` that copies
     the hyphenated code.
  3. One row per link, separated by hairlines
     (`1px solid rgba(255, 255, 255, 0.07)`), in this order when present:
     `Public link`, `Local link · same network`, `Player link · WHEP`.
     Each row has its label (13px, `var(--text-2)`), the link in the mono
     font at 12px on one line, and a square copy button named
     `Copy public link`, `Copy local link` or `Copy player link`.
  4. The recommended link is the public link when there is one, otherwise the
     local link. Its row carries a small tag `Share this` (11px, uppercase,
     green outline) after the label, and under its link a full-width button
     `Copy link` (`btn btn-primary btn-main`, 44px tall in this card) that
     copies that link. This is the only `.btn-main` on the page while sharing.
  5. With no public link, a note at the bottom of the card (13px,
     `var(--text-3)`, hairline above): `Works for people on your network. There is no public link on this machine.`
     For the other two `publicLinkHint` variants keep the existing sentences
     ("Public link is starting automatically. ...", "Public link unavailable
     on this machine. <error>").
  6. For now, `.viewer-count` stays as the last line of the card.
- Shortening: a link that does not fit is cut in the middle, keeping its
  start and its end from `#watch/` (or `/whep/watch/`) on, with an ellipsis
  between. The element's `innerText` stays the full link without a line
  break. Every copy action copies the full link.
- The Player link row keeps its explanation ("plays in GStreamer and other
  WHEP-compatible players") as the label's `title` and a visually hidden
  description.
- Copying: keep the existing feedback (toast and the polite "Copied!" status).
- Move the two `.room-meta` lines out of the card into
  `HostDiagnostics` as rows `WebRTC viewers connected`, `Relay sent` and, in
  OBS mode, `OBS codec and fallback`, using the same values.
- OBS mode: `.obs-whip-setup-panel` renders under the invite card in the side
  column, unchanged, until T58.
- `tests/browser/host-live.spec.mjs`:
  - On the shared server (one room, started with a canvas capture stub like
    `useFakeScreenShare` in `ui-semantics.spec.mjs`, in a context with
    clipboard permissions): the heading `Invite viewers` is visible; the room
    code text matches `/^[A-Z0-9]{3}-[A-Z0-9]{3}$/` and equals the code in
    the local link; the row labels in order are `Public link` and
    `Local link · same network`; exactly one `Share this` tag exists and it is
    in the public row; the button `Copy link` is the only `.btn-main` and
    puts the public link on the clipboard; `Copy local link` and
    `Copy room code` put the local link and the hyphenated code there; the
    local row's `.copy-field-value` `innerText` contains `#watch/` followed
    by the code and no line break; each link occupies one line (its height is
    less than twice its line height); at 1440x900 and 1280x720 the card's top
    and bottom equal `.video-container`'s within 1px; `WebRTC consumers` is
    not visible; at 390x844 the card is as wide as the preview and the
    document does not scroll sideways. End by stopping the share and polling
    `/api/metrics` until `rooms.active` is 0.
  - On a server of its own with `WHEP_ENABLED: 'true'` and
    `SHARE_BASE_URL: 'https://share.nextra.test'`: three rows in the order
    public, local, player; `Share this` only on the public row; card and
    preview edges equal at 1440x900.
  - On a server of its own with `SHARE_BASE_URL: ''` and WHEP off: one row,
    `Local link · same network`, carrying `Share this` and the `Copy link`
    button, and the note about the network is visible.
</steps>

<constraints>
- Scope: the invite card, the two components it uses, three diagnostic rows
  and the layout that places the card. No server change.
- Keep every hook listed in `<context>`: the classes `.copy-field`,
  `.copy-field-label`, `.copy-field-value`, `.viewer-count`; a label containing
  "Local Link" in any letter case; the full link as `innerText`.
- `CopyField` without the new props must render exactly as before.
- Use tokens and classes from T43; card and buttons keep their gradients; no
  QR code (the owner removed it).
- No new dependency.
- Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test; this card should need no edit to an
  existing spec. If one is needed, escalate.
- Match the surrounding code's naming, comments and indentation.
</constraints>

<acceptance_criteria>
- With two links (shared test server) the card shows the code, a public row
  marked `Share this` with the `Copy link` button, and a local row.
- With three links the rows are public, local, player, in that order.
- With one link the local row is marked and the network note shows.
- At 1440x900 and 1280x720 the card's top and bottom equal the preview's
  within 1px.
- Each copy button puts the complete value on the clipboard.
- The card shows no "WebRTC consumers" or "Relay out" text; the diagnostics
  section does.
- Every existing browser spec passes unchanged.
- `git diff --name-only` lists exactly the five source files in `<files>` and
  `tests/browser/host-live.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `npm run lint` and `npm run typecheck` — expected: exit 0.
2. `npx playwright test tests/browser/host-live.spec.mjs` — expected: all
   pass. Quote the card and preview edges measured at 1440x900.
3. `npx playwright test tests/browser/ui-semantics.spec.mjs` — expected: all
   pass in both projects.
4. `npx playwright test tests/browser/host-reload-recovery.spec.mjs tests/browser/host-obs-control-channel.spec.mjs tests/browser/host-layout.spec.mjs`
   — expected: all pass.
5. `npx playwright test tests/browser/media-flow.spec.mjs -g "direct WebRTC and can rejoin|protected room asks|mobile Chrome viewer"`
   — expected: all pass (they read the code from the local link).
6. `node --test tests/hostCopy.test.js tests/diagnosticBundle.test.js` —
   expected: pass.
7. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- The full link cannot be kept as `innerText` without a line break while it is
  shortened in the middle.
- A server started with `WHEP_ENABLED: 'true'` does not make the host page
  show the player link.
- Three link rows do not fit a card as tall as the preview at 1280x720 even
  with the list scrolling inside the card.
- Any existing spec needs an edit.
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
