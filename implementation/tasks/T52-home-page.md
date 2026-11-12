# T52 — Rebuild the home page around one main button and a room-code box

<model>
Model: `claude-sonnet-5-5`
Effort: `medium`
Card: T52 in `../KANBAN.md`
Depends on: T43 done
</model>

<role>
You are a React engineer rebuilding one page to an approved layout. You keep
the route, the title and the brand assets, add two small tested helpers, and
prove the page with a browser test.
</role>

<context>
Open `implementation/ui-review/nextra-ui-review.html`, section "Screen 1 ·
Home", mockup "Proposed". The spec below restates it; if the page cannot be
opened, this card stands alone.

Today (verified, `src/App.jsx` lines 180-215): the home page shows the logo, a
headline, a paragraph, two link cards whose only call to action is a coloured
word ("Start Sharing", "Join Room"), and a line of fine print. A viewer who
was sent a code has to open the Watch page before typing it.

Approved:

- One standout button for the main job.
- A room-code box on the home page.
- Three plain facts instead of the fine print. The detailed privacy wording
  already lives on the How to Use page ("Security and privacy").
- A small picture of what a live room looks like.

Decisions already made for you:

- The mockup's top bar shows the word "Nextra" beside the mark. The app keeps
  the name on the home page instead: keep `<BrandLogo className="brand-logo-hero" />`
  above the headline, smaller than today.
- The third fact reads "Nextra records nothing" (the mockup says "Nothing is
  recorded"; the app's existing claim is "Media is not stored by Nextra").
- The room-code box formats input exactly like the Watch page. Those three
  helpers are private functions in `src/WatchView.jsx` (lines 67-84) and
  `src/WatchView.jsx` belongs to other cards. This card creates
  `src/lib/roomCode.mjs` with copies of them; T60 later makes the Watch page
  import that module.
- Pressing Join on the home page should take the viewer into the room, not to
  a second Join button. T61 implements that on the Watch page. This card only
  leaves a one-shot note saying "the viewer already asked to join this code"
  (`src/lib/joinIntent.mjs`), and navigates to `#watch/CODE`. Until T61 lands
  the Watch page simply opens with the code filled in.
- T51 edits the top bar in the same file at the same time. Stay inside the
  `Landing` function and the LANDING section of the stylesheet.

Facts (verified):

- The route title for `/` is `Nextra — Self-hosted screen sharing`
  (`src/lib/routeTitle.mjs`) and a browser test checks it.
- `.card`, `.card-grid`, `.card-badge`, `.card-host` and `.card-watch` are
  used only by `Landing`.
- Reading `window.sessionStorage` can throw when site data is blocked. Every
  storage access must be guarded; `src/lib/mediaDebug.mjs` shows the pattern.
- The existing helpers:
  `normalizeRoomCode(value)` returns `String(value || '').trim().toUpperCase().replace(/-/g, '')`;
  `extractRoomCode(value)` takes the code out of a pasted `#watch/CODE` link
  when present, then keeps the first six characters of `A-Z0-9`;
  `formatRoomCode(code)` inserts a hyphen after the third character.
</context>

<files>
Read: `src/App.jsx` — the whole file.
Read: `src/WatchView.jsx` lines 67-84 — the three room-code helpers to copy.
Read: `src/lib/mediaDebug.mjs` and `tests/mediaDebug.test.js` — the guarded
storage pattern and its test style.
Read: `src/index.css` lines 336-381 (brand logo), 512-536 (`.input-code`),
1043-1155 (LANDING).
Read: `src/components/BrandLogo.jsx`.

Edit: `src/App.jsx` — the `Landing` function (lines 180-215) and the imports
it needs.
Edit: `src/index.css` — the LANDING section only (lines 1043-1155): replace
the rules that `Landing` no longer uses.
Create: `src/lib/roomCode.mjs`, `tests/roomCode.test.js`.
Create: `src/lib/joinIntent.mjs`, `tests/joinIntent.test.js`.
Create: `tests/browser/home.spec.mjs`.

Do not touch: `src/WatchView.jsx`, the `Router` header and footer JSX, the
`.input-code` rules (T60 owns them), `src/lib/routeTitle.mjs`.
</files>

<task>
The home page shows a headline, one standout "Share my screen" button, a
"Got a room code?" box that formats and validates a code and goes to the
Watch page, three plain facts, and a decorative preview. It works at 320px
to 2560px without sideways scrolling.
</task>

<steps>
- `src/lib/roomCode.mjs`: export `normalizeRoomCode`, `extractRoomCode` and
  `formatRoomCode` with the behaviour quoted in `<context>`.
  `tests/roomCode.test.js` covers: lower case becomes upper case; a pasted
  `https://example.test/#watch/abc123` gives `ABC123`; other characters are
  dropped; more than six characters are cut; `formatRoomCode('ABC123')` is
  `ABC-123` and `formatRoomCode('ABC')` is `ABC`.
- `src/lib/joinIntent.mjs`: export `rememberJoinIntent(code, storage, now = Date.now())`
  and `takeJoinIntent(code, storage, now = Date.now())`, plus
  `getSessionStorageSafely(windowLike)`. The note is stored under the key
  `nextra.joinIntent.v1` as JSON `{ code, at }`. `takeJoinIntent` returns
  `true` once, only when a note for the same code exists and is at most 10
  seconds old, and always removes the note. Every function swallows storage
  errors and treats a missing storage as "no note".
  `tests/joinIntent.test.js` covers: remember then take is true once and false
  the second time; another code is false; an 11-second-old note is false; a
  storage that throws gives false and does not throw; `null` storage is fine.
- `Landing`, in this order inside `<div className="landing">`:
  1. `<BrandLogo className="brand-logo-hero" />` (mark height about 2.25rem).
  2. `<h1>` "Share your screen. They just open a link." in `var(--fs-display)`,
     weight 700, line height 1.1.
  3. A paragraph: "Self-hosted and low-latency. Host from your browser or
     OBS. Viewers need no install and no account." in `var(--text-2)`.
  4. The main action: `<a href="#host" className="btn btn-primary btn-main">`
     with a small inline screen icon (`aria-hidden="true"`) and the text
     "Share my screen".
  5. A card (card gradient, 18px corners, 16px padding) holding a form:
     `<label htmlFor="homeRoomCode">Got a room code?</label>`, an
     `<input id="homeRoomCode" className="input-code" inputMode="text"
     autoComplete="off" placeholder="XXX-XXX">` and a submit button
     `<button className="btn btn-secondary">Join</button>` at least 44px tall.
     Typing formats the value with `formatRoomCode(extractRoomCode(value))`.
     On submit with six characters: call `rememberJoinIntent(code, …)` and set
     `window.location.hash = '#watch/' + code`. With fewer: do not navigate;
     set `aria-invalid="true"` on the input and show
     `<p role="alert" id="homeRoomCodeError">Enter the full 6-character room code.</p>`
     linked with `aria-describedby`. Typing again clears the error.
  6. Three facts in one wrapping row, each with a small check icon
     (`aria-hidden`): "Up to 4K at 60 fps", "Runs on your own machine",
     "Nextra records nothing". Text `var(--fs-small)`, colour `var(--text-2)`.
  7. A decorative preview marked `aria-hidden="true"`: a 16:9 box with 18px
     corners showing a stand-in shared screen, a "LIVE" badge, "2 watching"
     and the code "VW6-349". It is built from plain elements and CSS; no
     image file, no animation.
- Layout: from 900px up, two columns inside a centred block at most 1200px
  wide (items 1 to 6 on the left, the preview on the right, gap 48px); below
  900px, one column with the preview last; below 640px the preview is hidden.
  Side gutters stay `var(--stage-pad-inline)`.
- Remove the old link cards, the fine-print paragraph and the LANDING rules
  that nothing uses any more.
- `tests/browser/home.spec.mjs` (no room is created):
  - at 1440x900 the page has exactly one `h1`, exactly one element with the
    class `btn-main`, named "Share my screen", at least 54px tall, whose click
    leads to the title `Host · Nextra`;
  - the document title on `/` is `Nextra — Self-hosted screen sharing`;
  - filling "Got a room code?" with `abc123` shows `ABC-123`; pressing Enter
    changes the hash to `#watch/ABC123` and the Watch page's "Room code" field
    holds `ABC123` once hyphens are removed from its value (the Watch page
    shows a linked code without the hyphen today; T60 changes that);
  - filling `https://example.test/#watch/qwe789` shows `QWE-789`;
  - filling `AB` and pressing Join keeps the page on `/`, sets
    `aria-invalid="true"` and shows an alert with
    `Enter the full 6-character room code.`;
  - the three facts are visible;
  - at 390x844 the document does not scroll sideways, the main button is at
    least 54px tall and the code input and Join button are at least 44px tall.
</steps>

<constraints>
- Scope: the home page, its styles, two helper modules and their tests.
- Use the tokens and classes from T43 (`.btn-main`, `--fs-display`,
  `--fs-small`, `--surface-glass`, `--tap-min`). Buttons and the card keep
  their gradients; nothing is flat.
- Colour literals are allowed only inside the decorative preview's rules.
- No new dependency, no image file, no web font link.
- Dark theme only.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test.
- Match the surrounding code's style (`.mjs` modules use ES exports; tests are
  CommonJS with `node:test`).
</constraints>

<acceptance_criteria>
- `/` shows the seven parts listed in `<steps>` in that order.
- Exactly one `.btn-main` exists on the page, links to `#host` and is at
  least 54px tall.
- A six-character code navigates to `#watch/CODE`; a shorter one shows the
  alert and does not navigate.
- `src/lib/roomCode.mjs` and `src/lib/joinIntent.mjs` behave as their unit
  tests describe.
- No sideways scroll on `/` from 320px to 2560px (existing reflow loop).
- `git diff --name-only` lists exactly `src/App.jsx`, `src/index.css`,
  `src/lib/roomCode.mjs`, `src/lib/joinIntent.mjs`, `tests/roomCode.test.js`,
  `tests/joinIntent.test.js` and `tests/browser/home.spec.mjs`.
</acceptance_criteria>

<verification>
Run in this order.

1. `node --test tests/roomCode.test.js tests/joinIntent.test.js tests/routeTitle.test.js`
   — expected: all pass.
2. `npm run lint` and `npm run typecheck` — expected: exit 0.
3. `npx playwright test tests/browser/home.spec.mjs` — expected: all pass.
4. `npx playwright test tests/browser/ui-semantics.spec.mjs -g "content reflows without horizontal scrolling|sets its own title"`
   — expected: all pass in both projects.
5. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- The Watch page does not show a code given in the hash (`#watch/ABC123`).
- A rule in the LANDING section turns out to be used outside `Landing`.
- The page cannot avoid a sideways scroll at 320px with the room-code box.
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
