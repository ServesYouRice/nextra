# T50 — Ship the Inter and JetBrains Mono fonts with the app

<model>
Model: `claude-sonnet-5-5`
Effort: `medium`
Card: T50 in `../KANBAN.md`
Depends on: T43 done
</model>

<role>
You are a front-end engineer adding two self-hosted font families and the
licence records that must travel with them. You verify that every font file is
served from the app's own origin.
</role>

<context>
`src/index.css` names two typefaces, `'Inter'` and `'JetBrains Mono'` (lines
95-96), but the app ships neither. There is no `@font-face` rule, no font link
in `index.html` and no font file in the build, so most people see a system
font. The owner approved bundling both (review page, section "Design system
strip", box "Type").

Facts (verified unless marked):

- Self-hosting is the only option. The server's content security policy
  (`server.js` lines 214-219) sets `fontSrc: ["'self'"]` and
  `styleSrc: ["'self'"]`. A font from another host, or a font inlined as a
  `data:` URI, is refused by the browser. Do not change the policy.
- Vite inlines assets smaller than 4 KB into the CSS as `data:` URIs by
  default. A small font subset inlined that way would be refused, so this
  card turns inlining off (`build.assetsInlineLimit: 0`). Nothing else in the
  client imports a small asset; images are referenced from `public/` by URL.
- The npm packages `@fontsource-variable/inter` and
  `@fontsource-variable/jetbrains-mono` (both 5.3.0 on the registry when this
  card was written, both declaring the licence `OFL-1.1`) contain the WOFF2
  files and a CSS file with the `@font-face` rules. Assumption to confirm by
  opening the installed package's `index.css`: the family names are
  `Inter Variable` and `JetBrains Mono Variable`.
- They belong in `devDependencies`, like `react` and the other client
  libraries Vite bundles: the packaged app is built with `npm ci --omit=dev`
  and serves the already-built `dist/` (`scripts/package-app.js`).
- The licence gate `scripts/opensource-preflight.js` checks production
  dependencies only (line 149 skips entries with `dev === true`), so the
  reviewed-licence list there does not need `OFL-1.1`. The SIL Open Font
  License still requires the licence text to accompany the font files, and
  the font files do ship inside `dist/`. `scripts/package-app.js` copies
  `THIRD_PARTY_NOTICES.md` and the `licenses/` folder into every package, so
  that is where the texts and the notice go.
- T43 owns the token block of `src/index.css`; this card changes only the two
  font tokens in it.
</context>

<files>
Read: `server.js` lines 205-235 — the content security policy.
Read: `vite.config.mjs` — the whole file; `build` is at line 78.
Read: `src/main.jsx` lines 1-6 — the client entry and its imports.
Read: `src/index.css` lines 93-99 — the font tokens.
Read: `scripts/opensource-preflight.js` lines 1-30 and 140-160 — the licence
gate. `THIRD_PARTY_NOTICES.md` — the whole file. `scripts/package-app.js`
lines 25-40 — what a package contains.
Read: `tests/viteConfig.test.js` lines 1-45 — how the config is loaded in tests.

Edit: `package.json`, `package-lock.json` — two new `devDependencies`, through
`npm install --save-dev`, never by hand.
Edit: `src/main.jsx` — two imports before `./index.css`.
Edit: `src/index.css` — `--font-sans` and `--font-mono` only.
Edit: `vite.config.mjs` — `build.assetsInlineLimit`.
Edit: `tests/viteConfig.test.js` — one added test for that setting.
Edit: `THIRD_PARTY_NOTICES.md` — one added paragraph.
Create: `licenses/Inter-OFL-1.1.txt`, `licenses/JetBrainsMono-OFL-1.1.txt`.
Create: `tests/fontAssets.test.js`, `tests/browser/fonts.spec.mjs`.

Do not touch: `server.js` — the policy is correct as it is.
Do not touch: `scripts/opensource-preflight.js` — no production licence is
added.
Do not touch: `index.html` — no font link or preload is needed.
</files>

<task>
A fresh build serves Inter and JetBrains Mono from the app's own origin, the
pages render in them, and the two licence texts and a notice ship with the
source and with every package.
</task>

<steps>
- Run `npm install --save-dev @fontsource-variable/inter @fontsource-variable/jetbrains-mono`.
- Open `node_modules/@fontsource-variable/inter/index.css` and the JetBrains
  Mono equivalent; confirm the `font-family` names and that `src` points at
  `.woff2` files in the package.
- `src/main.jsx`: add `import '@fontsource-variable/inter'` and
  `import '@fontsource-variable/jetbrains-mono'` above `import './index.css'`.
- `src/index.css`: put the bundled family first in each token and keep the
  existing fallbacks, for example
  `--font-sans: 'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;`.
- `vite.config.mjs`: `build: { outDir: 'dist', sourcemap: false, assetsInlineLimit: 0 }`
  with a comment giving the reason from `<context>`.
- `tests/viteConfig.test.js`: add a test that the returned config has
  `build.assetsInlineLimit === 0`.
- Copy each package's licence file (look for `LICENSE` in the package folder)
  into `licenses/Inter-OFL-1.1.txt` and `licenses/JetBrainsMono-OFL-1.1.txt`,
  unchanged.
- `THIRD_PARTY_NOTICES.md`: add a paragraph after the FFmpeg section saying
  that the client bundle includes the Inter and JetBrains Mono typefaces as
  WOFF2 files, licensed under the SIL Open Font License 1.1, with the licence
  texts in the two files above, obtained from the two npm packages, and the
  upstream projects `https://github.com/rsms/inter` and
  `https://github.com/JetBrains/JetBrainsMono`.
- `tests/fontAssets.test.js` (CommonJS, `node:test`): both licence files exist
  and contain `SIL OPEN FONT LICENSE`; `THIRD_PARTY_NOTICES.md` mentions
  `Inter`, `JetBrains Mono` and `Open Font License`; `package.json` lists both
  packages under `devDependencies` and neither under `dependencies`;
  `src/index.css` names both bundled families in the font tokens.
- `tests/browser/fonts.spec.mjs` (no room is created):
  - record every request with `resourceType() === 'font'` while loading `/`
    and then `/#status`; after `await page.evaluate(() => document.fonts.ready)`
    expect at least one font request, and every one to have the page's origin
    and a path that ends in `.woff2`;
  - `document.fonts.check('16px "Inter Variable"')` is true on `/`, and
    `document.fonts.check('16px "JetBrains Mono Variable"')` is true on
    `/#status`;
  - no console message matches `/Refused to load the font/`;
  - after `npm run build` has produced `dist/` (the Playwright web server
    builds it), no file in `dist/assets` ending in `.css` contains
    `url(data:`; locate the build with `clientBuildDir` from
    `tests/browser/clientBuild.mjs` (as `host-reload-recovery.spec.mjs` does)
    and read it with `node:fs`.
</steps>

<constraints>
- Scope: the files in `<files>`. No other dependency, no CDN, no change to the
  security policy.
- Fonts are served from the app's own origin only.
- Do not hand-edit `package-lock.json`.
- Keep the fallback stacks: a blocked or missing font must degrade to the
  system font, not to a serif.
- Dark theme only; this card changes no colour.
- No GitHub Actions: the owner does not use hosted CI. Do not add or edit
  workflow files; the checks are the commands in `<verification>`.
- Never speculate about code you have not opened.
- Do not weaken, skip or delete a test.
- Match the surrounding code's style.
</constraints>

<acceptance_criteria>
- `package.json` has both packages in `devDependencies` only.
- Every font request made by `/` and `/#status` is same-origin and `.woff2`.
- `document.fonts.check` is true for both families.
- No built CSS file contains a `data:` URL.
- `licenses/Inter-OFL-1.1.txt` and `licenses/JetBrainsMono-OFL-1.1.txt` exist
  and `THIRD_PARTY_NOTICES.md` names both typefaces and their licence.
- `npm run oss:check` passes.
- Every test in `tests/browser/ui-semantics.spec.mjs` still passes with the
  new fonts.
</acceptance_criteria>

<verification>
Run in this order.

1. `node --test tests/fontAssets.test.js tests/viteConfig.test.js tests/opensourcePreflight.test.js`
   — expected: all pass.
2. `npm run oss:check` — expected: `[oss:check] OK`.
3. `npm run lint` and `npm run typecheck` — expected: exit 0.
4. `npx playwright test tests/browser/fonts.spec.mjs` — expected: all pass.
5. `npx playwright test tests/browser/ui-semantics.spec.mjs` — expected: all
   pass in both projects; the new font metrics must not break a layout test.
6. `npm run evaluate:packaging` — expected: exit 0.
7. `.claude/hooks/check.sh` — the final gate before any push: lint,
   typecheck, every unit test, the coverage gate, the build, the packaging
   and licence checks, the dependency audit, then every browser spec.
   Expected: it ends with `ALL CHECKS PASSED`. Run it once, last; it takes
   several minutes. If one of its checks cannot run on this machine, say
   which one and why instead of skipping it silently.
</verification>

<escalate_if>
- The registry cannot be reached or either package does not declare `OFL-1.1`.
- A package has no licence file to copy.
- The family names in the installed CSS differ from the two assumed above;
  use the real names and say so in the report (this is not a blocker).
- A layout test in `ui-semantics` fails with the bundled fonts; report the
  test and the measured numbers instead of changing a size.
- Loading the fonts needs a change to the security policy.
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
