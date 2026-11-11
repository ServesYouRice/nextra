TASK-085 (lane watch): WatchView line 22 now calls getLocalStorageSafely(window) from src/lib/mediaDebug.mjs (added by TASK-068) instead of reading window.localStorage at module scope. Added one source-level node:test in tests/mediaDebug.test.js; it failed on the unchanged code and passes after the change. lint, typecheck and npm test pass (1052 tests, 0 failing). Not run: the Playwright check (tests/browser/ui-semantics.spec.mjs with a throwing localStorage getter); the verify line says to ask before running it.

## Browser check (driver follow-up)

Done in lane rooms (dev c7489d0, which contains 0aa3da7; the lane was later merged with dev 437b8f2). Result: with a window.localStorage getter that throws a SecurityError, both the Watch and the Host route render on the current code, and both fail on a build of the code before TASK-068 and TASK-085. TASK-085's last success criterion ("the Playwright check shows the Join Room button with a throwing localStorage getter") is met.

Outcomes (headless Chromium, ad hoc driver and the committed spec agree):

| route | build before both fixes | current code |
| --- | --- | --- |
| /#watch | error boundary ("Something went wrong"), no Join Room button within 10 s (spec: 15 s) | Join Room button visible, no error boundary |
| /#host | error boundary, no .host-side-panel within 10 s (spec: 15 s) | .host-side-panel visible, no error boundary |

- On the old build the console shows "SecurityError: The operation is insecure." and the page navigates twice (the lazy route chunk fails while it evaluates). On the current code there is no uncaught page error. The only console error, on both builds and also with readable storage, is the existing CSP warning about 'ws://[::1]:4455'.
- Control: with readable storage the old build renders both routes, so the failure comes from the throwing getter.
- HostView's other localStorage uses (loadStoredCapturePrefs, persistCapturePrefs, loadStoredObsPassword) are inside try/catch, so the module-scope read was the only blocker; the Host run confirms it.

How it was run:
1. Builds with npx vite build --outDir into the shared scratchpad: rooms-TASK-085-dist-after (current source) and rooms-TASK-085-dist-before (src/WatchView.jsx from 0aa3da7~1, src/HostView.jsx and src/lib/mediaDebug.mjs from de64432~1 written over mine, built, then restored with git checkout -- on the three paths; the tree was clean afterwards, no extra worktree).
2. Driver rooms-TASK-085-browser.mjs.txt (scratchpad): starts server.js with NODE_ENV=test, NEXTRA_SMOKE_TEST=1 and NEXTRA_TEST_DIST_DIR=<build> on a port pair from tests/serverPorts.js (HTTP, ports 25548 before and 22262 after), drives headless Chromium with an init script that redefines window.localStorage with a getter throwing DOMException SecurityError, once with readable and once with throwing storage per route. Output: rooms-TASK-085-driver-before.txt and rooms-TASK-085-driver-after.txt. This ran under the Playwright lock (it took three 20-minute wait windows because other lanes held it), together with a first run of the spec under the standard config on 3210 with a server I started there.
3. After the coordinator retired the lock, the committed spec was run again the new way, from the lane root: NEXTRA_E2E_WORK_DIR=<scratchpad> node <scratchpad>/run-e2e.cjs --workers=1 tests/browser/ui-semantics.spec.mjs -g "still renders when reading". Before (old files written over, restored afterwards): 4 failed (chromium and mobile-chrome, both routes) with "expect(locator).toBeVisible() failed ... element(s) not found" after 15 s. After: 4 passed. The whole ui-semantics.spec.mjs on the current code: 51 passed, 13 skipped (the specs' own test.skip on mobile-chrome), 0 failed. Outputs: rooms-TASK-085-e2e-before-new.txt, rooms-TASK-085-e2e-after-new.txt, rooms-TASK-085-e2e-after-full.txt.

Spec: added "/#watch|/#host still renders when reading window.localStorage throws" to tests/browser/ui-semantics.spec.mjs (it fits there: it checks the same routes' first render, runs on both projects of the standard config, no server of its own). Committed on lane/rooms as 93e7264 "test(ui): check that Watch and Host still render when reading window.localStorage throws". My first draft probed the getter with page.evaluate before asserting the control; on the old build the page reloads, so it failed with "Execution context was destroyed" instead of the real reason. The committed version asserts the control (and no error boundary) first, then probes that the getter really throws, then that no page error was raised.

All servers and browsers were stopped, the lock was released, the lane tree is clean.
