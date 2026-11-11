# Implementation task queue

Updated: 2026-11-11.

This file contains only work that is ready to delegate. Historical cards,
completed work, deferred ideas, and audit transcripts are intentionally absent.
Each card has one self-contained executor prompt under `tasks/`; that prompt is
the implementation contract.

## Executor rules

- Work only on the task explicitly assigned to you. Do not select another card.
- Read the assigned task file, then only the repository files it names.
- Stay within its file scope and escalation conditions.
- Do not edit this queue or another task prompt.
- Run the task's checks in the stated order and return its exact report format.
- A behavior-fix card's named regressions must fail before production source is
  edited. Every other card is assertion-only; an unexpected failure is a finding
  to report, not an expectation to weaken.

## Ready

| Card | Goal | Change type | Owned implementation files | Prompt |
| --- | --- | --- | --- | --- |
| T43 | Add the design tokens and shared button, field and card styles | Design change | `src/index.css` (`:root`, button, field and card rules), `tests/designTokens.test.js`, `tests/browser/ui-foundation.spec.mjs` | `tasks/T43-foundation-tokens.md` |
| T44 | Stop the How to Use page from scrolling sideways on phones | Behavior fix | `src/index.css` (one rule), `tests/browser/ui-semantics.spec.mjs` (one new loop) | `tasks/T44-howto-sideways-scroll.md` |
| T45 | Show the real reason when sharing cannot start | Behavior fix | `src/lib/userError.mjs`, `tests/userError.test.js` | `tasks/T45-start-error-reason.md` |
| T46 | Tell the viewer when the room passphrase was wrong | Behavior fix | `src/WatchView.jsx` (join form, `handleJoin`), `src/index.css` (one rule), `tests/browser/media-flow.spec.mjs` (one new test) | `tasks/T46-wrong-passphrase-feedback.md` |
| T47 | Tell viewers when the host's picture stops | Behavior fix | `src/WatchView.jsx` (room and producer handlers, one overlay), `tests/browser/media-flow.spec.mjs` (one new test) | `tasks/T47-host-picture-stopped.md` |
| T48 | Correct two lines of host page copy | Copy fix | `src/HostView.jsx` (two sentences), `tests/hostCopy.test.js` | `tasks/T48-host-copy-lines.md` |
| T49 | Let the host preview and the viewer's picture use more of the window | Design change | `src/index.css` (two `max-width` values), `tests/browser/ui-semantics.spec.mjs` (stage loop) | `tasks/T49-stage-sizes.md` |
| T50 | Ship the Inter and JetBrains Mono fonts with the app | Design change | `package.json`, `package-lock.json`, `src/main.jsx`, `src/index.css` (two font tokens), `vite.config.mjs`, `licenses/`, `THIRD_PARTY_NOTICES.md`, `tests/fontAssets.test.js`, `tests/viteConfig.test.js`, `tests/browser/fonts.spec.mjs` | `tasks/T50-ship-fonts.md` |
| T51 | Rework the top navigation: four links, a clear current page, a phone menu | Design change | `src/App.jsx` (nav items, header), `src/index.css` (top bar rules), `tests/browser/ui-semantics.spec.mjs` (nav helper, three call sites), `tests/browser/shell-nav.spec.mjs` | `tasks/T51-shell-navigation.md` |
| T52 | Rebuild the home page around one main button and a room-code box | Design change | `src/App.jsx` (`Landing`), `src/index.css` (LANDING section), `src/lib/roomCode.mjs`, `src/lib/joinIntent.mjs`, `tests/roomCode.test.js`, `tests/joinIntent.test.js`, `tests/browser/home.spec.mjs` | `tasks/T52-home-page.md` |
| T53 | Host: choose the capture source with tabs and start from the stage | Design change | `src/HostView.jsx` (stage, Start row, capture rows), `src/index.css` (new tab and stage rules), `tests/browser/ui-semantics.spec.mjs` (lines named in the prompt), `tests/browser/host-reload-recovery.spec.mjs` (one line), `tests/browser/host-layout.spec.mjs` | `tasks/T53-host-source-tabs-start.md` |
| T54 | Host: one calm settings panel, aligned with the preview | Design change | `src/HostView.jsx` (idle side column), `src/index.css` (panel and layout rules), `tests/browser/ui-semantics.spec.mjs` (two lines), `tests/browser/host-layout.spec.mjs` | `tasks/T54-host-settings-panel.md` |
| T55 | Host: OBS options as plain rows in the settings panel | Design change | `src/HostView.jsx` (OBS rows, More options), `src/index.css`, `tests/browser/host-obs-control-channel.spec.mjs` (one helper, three call sites), `tests/browser/host-layout.spec.mjs` | `tasks/T55-host-obs-panel.md` |
| T56 | Host: an invite card with the room code and one row per link | Design change | `src/components/RoomSharePanel.jsx`, `src/components/CopyField.jsx`, `src/components/HostDiagnostics.jsx`, `src/HostView.jsx` (room info block), `src/index.css` (copy field and room rules), `tests/browser/host-live.spec.mjs` | `tasks/T56-host-invite-card.md` |
| T57 | Host: one status line, a quality menu and a quiet Stop while sharing | Design change | `src/HostView.jsx` (live controls), `src/components/RoomSharePanel.jsx`, `src/components/HostDiagnostics.jsx`, `src/index.css` (`.controls`, `.status-bar`, new rules), `tests/browser/media-flow.spec.mjs` (two added lines), `tests/browser/ui-semantics.spec.mjs` (one added line), `tests/browser/host-live.spec.mjs` | `tasks/T57-host-live-status-line.md` |
| T58 | Host: show OBS setup as three live steps in the preview | Design change | `src/lib/obsWebSocket.js` (`configureObsStream`, one option), `src/lib/obsSetupSteps.mjs`, `src/HostView.jsx` (OBS overlay and setup block), `src/index.css`, `tests/obsSetupSteps.test.js`, `tests/obsWebSocket.test.js`, `tests/browser/host-obs-control-channel.spec.mjs` | `tasks/T58-host-obs-guided-steps.md` |
| T59 | Host: say up front when this device cannot share | Design change | `src/lib/hostPreflight.mjs`, `src/HostView.jsx` (one early branch), `src/index.css`, `tests/hostPreflight.test.js`, `tests/browser/host-needs-computer.spec.mjs` | `tasks/T59-host-needs-computer.md` |
| T60 | Viewer: one centred join card with six code boxes | Design change | `src/WatchView.jsx` (not-joined view), `src/components/UserErrorAlert.jsx`, `src/index.css` (JOIN FORM section), `tests/browser/media-flow.spec.mjs` (two lines), `tests/browser/viewer-join.spec.mjs` | `tasks/T60-viewer-join-card.md` |
| T61 | Viewer: join and start the picture in one press | Design change | `src/WatchView.jsx` (automatic start), `src/lib/mediaDebug.mjs`, `tests/mediaDebug.test.js`, `tests/browser/media-flow.spec.mjs` (lines named in the prompt, three new tests), `tests/browser/ui-semantics.spec.mjs` (one line), `tests/browser/packaged-media.packaged.mjs` (one line), `tests/browser/home.spec.mjs` | `tasks/T61-viewer-one-step-join.md` |
| T62 | Viewer: give the picture the window and put the controls on it | Design change | `src/WatchView.jsx` (joined view), `src/lib/viewerStatus.mjs`, `src/index.css` (new WATCH STAGE section), `tests/viewerStatus.test.js`, `tests/browser/ui-semantics.spec.mjs` (one expectation), `tests/browser/media-flow.spec.mjs` (two new tests) | `tasks/T62-viewer-picture-controls.md` |
| T63 | Viewer: say what is happening while waiting, when the host drops out and when the stream ends | Design change | `src/WatchView.jsx` (state overlays), `src/index.css` (WATCH STAGE section), `tests/browser/media-flow.spec.mjs` (one new test) | `tasks/T63-viewer-states.md` |
| T64 | Status: one health line, three plain numbers, one line per room | Design change | `src/StatusView.jsx`, `src/lib/statusCopy.mjs`, `src/index.css` (STATUS PAGE section), `tests/statusCopy.test.js`, `tests/browser/status-page.spec.mjs` | `tasks/T64-status-page.md` |
| T65 | How to Use: tabs, three illustrated steps, Copy buttons and fold-out answers | Design change | `src/HowToView.jsx`, `src/index.css` (new HOW TO USE section), `tests/browser/howto.spec.mjs` | `tasks/T65-howto-page.md` |
| T66 | Phone: 44px tap targets on every page, with one test that checks them all | Behavior fix | `src/index.css` (new TOUCH TARGETS section, footer), `tests/browser/tap-targets.spec.mjs` | `tasks/T66-phone-tap-targets.md` |
| T67 | Bring every text size and corner radius onto the token scale | Design change | `src/index.css` (`font-size` and `border-radius` values), `tests/designTokens.test.js` | `tasks/T67-type-radius-sweep.md` |

Change types. A **Behavior fix** repairs something that is broken today; its
named test must fail before production source is edited. A **Copy fix** or
**Design change** builds what the owner approved in
`ui-review/nextra-ui-review.html`: it edits production source, adds the test
its prompt names, and changes an existing assertion only where its prompt lists
that assertion as pinning the old design. For every card, any other failing
test is a finding to report.

## Order and dependencies

- The table is in a valid serial order: every card's dependencies are above it.
- No dependencies, may run side by side: T43, T44, T45, T46, T47, T48, T49.
  T46 and T47 both edit `src/WatchView.jsx` and
  `tests/browser/media-flow.spec.mjs`, in separate regions named in each prompt.
- After T43: T50, T51 and T52. T51 and T52 both edit `src/App.jsx`, the top bar
  and the `Landing` function respectively.
- Host chain, strictly in order: T53 (needs T43, T48, T49) → T54 → T55 → T56 →
  T57 → T58 → T59. Each one edits `src/HostView.jsx`.
- Viewer chain, strictly in order: T60 (needs T43, T46, T47, T52) → T61 → T62
  (also needs T49) → T63. Each one edits `src/WatchView.jsx`. It may run beside
  the host chain: the two chains share only `src/index.css` and two spec files,
  in separate regions.
- T64 needs T43 and T52. T65 needs T44, T58 and T61, because the guide names
  the controls those cards rename.
- T66 needs T51, T52, T59, T63, T64 and T65: it measures every finished page.
- T67 is last and needs T66 and T50: it resizes text across the whole
  stylesheet with the shipped fonts in place.
- Cards that run side by side share `src/index.css`,
  `tests/browser/ui-semantics.spec.mjs` and `tests/browser/media-flow.spec.mjs`
  in different regions. Land them one at a time and re-run
  `.claude/hooks/check.sh` on the combined tree before each push.
