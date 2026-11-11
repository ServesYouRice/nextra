- [x] check 12 `C-bd7abbaa0e86` Cross-worker media-flow file lock leaks its ticket when beforeEach times out: **fixed** (claim holds; lane `scripts`, at dev 1be0088, commit cf2a56c)

  - The code: `tests/browser/media-flow.spec.mjs` is byte-identical at ac1c688 and dev 1be0088, so the claim was
    real on the original code too.
    - beforeEach writes its ticket (lines 525-526) and then waits in `for (;;)` (529-535).
    - The ticket path reaches `loopbackProxyState` only after the wait and the proxy listen (587-594).
    - afterEach returns at once while `loopbackProxyState` is null (602).
  - Playwright 1.63 (`node_modules/playwright/lib/worker/workerProcessEntry.js`):
    - Each hook is raced against its deadline (`Promise.race` in `TimeoutManager.withRunnable`, 403-406). A timeout
      or an interrupt abandons the hook without throwing into it, so its catch (595-598) never runs.
    - afterEach still runs: `shouldRunAfterEachHooks` is set before beforeEach (1644-1645, 1671-1672).
    - A failed test stops the worker (1695-1696).
    - The runner clears each project's `outputDir` when a run starts (`runner/index.js` "clear output", 6398-6416),
      not `<cwd>/test-results` as such.
  - Overstated in the claim:
    - Only the `chromium` project runs this file (`mobile-chrome` matches `ui-semantics` only).
    - Later tests do not hang. Each times out in beforeEach (60 s each) and leaks its own ticket, so the rest of the
      file fails one test after another.
    - A single Ctrl+C or `--max-failures` interrupts the test and still runs afterEach. A holder's ticket was therefore
      freed; only a waiter's leaked, by the same path as the timeout (now fixed). A hard kill or crash leaves the
      ticket.
    - In a normal `npm run test:e2e` (`fullyParallel: false`, the lock only in this file), the tests run one after
      another in one worker. The first unreleased ticket then has to come from a hard-killed worker or from real
      contention (`--fully-parallel`, or `--repeat-each` with several workers). From there the cascade is as claimed.
  - Fix (`tests/browser/media-flow.spec.mjs` only, kept small):
    - The test's ticket is tracked from the first line of beforeEach (`mediaFlowTicket`). afterEach marks it
      abandoned and removes it even when beforeEach never finished.
    - The wait loop and the step after the proxy listen stop on `abandoned`, so a hook Playwright gave up on can no
      longer take the lock later.
    - The lock folder is `path.join(testInfo.project.outputDir, '.media-flow-lock')`. With the repo's config, run
      from the root, this is the same folder as before; with `--output` or another cwd, it is now the folder
      Playwright clears.
  - Test: `tests/mediaFlowLockHooks.test.js` (new).
    - It loads the real spec with `@playwright/test` replaced by a stub (a `module.register` resolve hook). Two
      module instances stand for two workers, and the hooks are driven the way Playwright drives them.
    - On the unchanged spec, both tests failed (`check-12-unit-before.txt`): "afterEach left the timed-out test
      queued for the lock" (the folder held the holder's ticket plus `1792864080580-0000-…ticket`), and "the held
      lock is not under the project outputDir".
    - After the fix, both pass (`check-12-unit-after.txt`).
    - Mutation check: without the loop's `abandoned` check, the first test fails with "the abandoned beforeEach is
      still waiting for the lock after its afterEach ran".
  - Browser check, with the Playwright lock held 20:34:46-20:37:59 (the first two 20-minute waits lost the lock to
    other lanes).
    - The server was `server.js` on 3210 with a scratch vite build, `NEXTRA_SMOKE_TEST=1`, and `HTTPS_CERT_DIR` and
      `NEXTRA_LOG_DIR` in the scratchpad. dist was not built.
    - The harness files are in `dev-notes/results`: `check-12-playwright.config.mjs.txt`, `check-12-setup.mjs.txt`,
      `check-12-reporter.mjs.txt` and `check-12-pw-runs.sh`. The working copies are in the shared scratchpad as
      `scripts-check12-*`.
    - Original spec, with a planted holder ticket released as test 1 ended and a 4 s timeout: all 12 tests had
      "Test timeout of 4000ms exceeded while running "beforeEach" hook". One orphan ticket was added per test and 12
      were left, although the holder released at 4.7 s (`check-12-pw-before.log`).
    - Fixed spec, same scenario, with the server and a 60 s timeout: test 1 timed out with only the holder ticket
      left. Tests 2-12 passed, and the folder was empty at the end (`check-12-pw-after.log`).
    - outputDir moved, with stale tickets planted in `<cwd>/test-results` and in the new outputDir:
      - Original spec: blocked by the uncleared `<cwd>/test-results` ticket, and timed out
        (`check-12-pw-outdir-before.log`).
      - Fixed spec: the stale ticket in its outputDir was cleared at the run start, and the test passed
        (`check-12-pw-outdir-after.log`).
    - Real `playwright.config.mjs`, reusing that server: 12 passed (33.0 s) (`check-12-pw-real-config.txt`).
  - Checks: lint and typecheck pass. `npm test` passes, 1014/1014, including the 2 new tests.
  - Left open:
    - Within one run, a hard-killed worker's ticket still blocks the later media-flow tests. Each one now cleans up
      after itself. The next run starts clean because the folder is in outputDir.
    - Dead-owner reclamation is TASK-092's (VAL-159); this fix adds none.
  - For TASK-092 (watch lane):
    - Its step 8 keeps the shape that leaked here: the lock goes into `loopbackProxyState` only after `acquire()`,
      and afterEach releases only what is there. If the timeout fires during `acquire()`, the abandoned acquire can
      still take the lock after the test has ended, and reclamation frees it only once that worker process is dead.
      Keep this fix's pattern: register the pending acquisition at the start of beforeEach, and have afterEach abort
      it (for example an AbortSignal passed to `acquire`) and release whatever it got.
    - Keep the folder at `testInfo.project.outputDir` rather than step 8's `process.cwd()/test-results`.
    - `tests/mediaFlowLockHooks.test.js` plants no ticket of its own (the holder is a second instance of the spec),
      so it does not depend on the ticket format and should pass unchanged after TASK-092. It requires:
      - afterEach of a still-waiting beforeEach leaves the folder as the holder had it, and that beforeEach then
        rejects;
      - the next beforeEach gets the lock within 3 s of the holder's afterEach;
      - nothing is left in the folder after release;
      - the folder is under the project outputDir.
    - Side note: two Playwright runs started in the same folder are not serialised by either lock, because each run
      clears test-results, lock folder included, when it starts.
