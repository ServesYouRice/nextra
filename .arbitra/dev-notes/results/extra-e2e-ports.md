# extra-e2e-ports (lane depack, not a plan item)

Commit `e931842` on `lane/depack` (on top of dev 73a9b31): `test: let several worktrees run the Playwright browser tests at the same time`.
Files: `playwright.config.mjs`, `tests/browser/media-flow.spec.mjs`, `tests/browser/ui-semantics.spec.mjs`. No new file in the repository.

## What changed

- `playwright.config.mjs`: `NEXTRA_E2E_PORT` (default 3210), `NEXTRA_E2E_RTC_MIN_PORT` (42100), `NEXTRA_E2E_RTC_MAX_PORT` (42199).
  They feed `baseURL`, the webServer `url`, `PORT`, `SHARE_BASE_URL`, `RTC_MIN_PORT`, `RTC_MAX_PORT`. An empty variable counts as unset;
  a value that is not a port number 1-65535, or a minimum above the maximum, throws with a message naming the variable.
- `media-flow.spec.mjs`: the port comes from `testInfo.project.use.baseURL` (new helper `serverPort(testInfo)`) for the relay viewer URL
  `nextra.cloudflare.test:<port>`, the proxy allow-list, the proxy's upstream port and the contexts' `baseURL`; the benchmark `--url=` is the
  configured baseURL itself. `joinAndWatchRelay` and `measureLiveWebRtcTopology` take `testInfo`; the two tests that call them now take it.
- `ui-semantics.spec.mjs` (~285): the second viewer context uses `testInfo.project.use.baseURL`.
- `grep 3210` over `tests/browser` and the config now finds only the default in the config. The other three specs already claim their own ports.

## Proof

- No variables set: the resolved config (`JSON.stringify` of the default export, whole `process.env` spread included) is identical to the one
  from `git show 73a9b31:playwright.config.mjs` (checked by importing both). `baseURL https://127.0.0.1:3210`, `webServer.url .../readyz`,
  `PORT 3210`, `SHARE_BASE_URL https://nextra.cloudflare.test:3210`, RTC 42100/42199, as before. Bad values fail as described above (`--list`).
- **The run on 3210 with the defaults was NOT done**: the coordinator told me during the work not to take the lock and not to touch 3210 or
  42100-42199 (another lane held the lock). So "nothing changed on 3210" rests on the identical config above plus the specs' default path
  (`new URL('https://127.0.0.1:3210').port` is 3210, so every string they build is the old one).
- Runs on other ports, own server from a vite build outside `dist` (`NEXTRA_SMOKE_TEST=1`, `NEXTRA_TEST_DIST_DIR`), ports from `claimServerPorts()`,
  `--workers=1`, `ui-semantics.spec.mjs` + `media-flow.spec.mjs`, both projects: 59 passed, 13 skipped (the mobile-chrome project skips the
  desktop-only tests), 0 failed:
  - 27524 / RTC 27525 (alone);
  - 29632 / 29633 and 29094 / 29095 at the same time, while another lane held the lock and ran on 3210.
  The relay test (viewer on `nextra.cloudflare.test:<port>` through the allow-listed proxy) and the benchmark `--url` test are among them.
- npm run lint: pass. npm run typecheck: pass. npm test: 1263 tests, 1263 pass, 0 fail (run before the final commit; the commit only touches the three files above).

## Things to know (not caused by this change)

- Running the two files together with Playwright's default worker count (3 here) fails 3 media-flow tests (`rooms.active` was 6 where 0 or 1 was
  expected, and a relay test timed out): both files share one server and media-flow asserts global room counts while ui-semantics starts rooms in
  another worker. It is the same whatever the port, so pass `--workers=1` when running both files together, or run the files one after the other.
  I did not run the old specs this way (they cannot leave 3210), so "same on 3210" is my reading of the code, not a measurement.
- Two Playwright runs started from the same worktree share `test-results/` and wipe each other's traces (ENOENT in `.playwright-artifacts-*`; my
  first concurrent attempt failed that way). Different worktrees are unaffected. Use `--output=<own dir>` for a second run in one worktree.
- `reuseExistingServer` is what keeps Playwright from building into `dist`: if the server on your port is not up when Playwright starts, its
  webServer command (`npm run build && node server.js`) runs and builds into the linked `dist`. Start your server first and wait for `/readyz`.

## The command a lane uses (no lock)

From the lane's worktree root (it builds, claims a free port pair, starts the server, runs Playwright, stops the server, deletes its build;
the exit code is Playwright's; on failure it keeps traces and prints where):

    NEXTRA_E2E_WORK_DIR=<your scratchpad> node C:/Users/V/nextra/.arbitra/dev-notes/run-e2e.cjs --workers=1 tests/browser/ui-semantics.spec.mjs tests/browser/media-flow.spec.mjs

Everything after the script name goes to `playwright test`. `NEXTRA_E2E_WORK_DIR` is optional (default: the system temp folder).
The script is not in the repository (`.arbitra/dev-notes/run-e2e.cjs`, written for this note). It does, in order:

1. `node node_modules/vite/bin/vite.js build --outDir <work>/dist --emptyOutDir` (never `dist`);
2. `claimServerPorts()` from the lane's `tests/serverPorts.js` (a pair below 32000, claimed so no other run takes it);
3. `server.js` with the environment `playwright.config.mjs` gives its webServer, plus `RTC_MIN_PORT=RTC_MAX_PORT=<rtc port>`, `NEXTRA_SMOKE_TEST=1`,
   `NEXTRA_TEST_DIST_DIR=<work>/dist`, `HTTPS_CERT_DIR=<work>/certs` (so the linked `certs` is never written), and waits for `/readyz`;
4. `node node_modules/@playwright/test/cli.js test <args> --output=<work>/test-results` with `NEXTRA_E2E_PORT`, `NEXTRA_E2E_RTC_MIN_PORT`,
   `NEXTRA_E2E_RTC_MAX_PORT` set to that pair;
5. kills the server tree and removes `<work>` when Playwright exited 0.

If a lane prefers to do it by hand, the contract is: start `server.js` yourself with the config's webServer environment on the ports you pick
(plus `NEXTRA_SMOKE_TEST=1`, `NEXTRA_TEST_DIST_DIR`), wait for `https://127.0.0.1:<port>/readyz`, then
`NEXTRA_E2E_PORT=<port> NEXTRA_E2E_RTC_MIN_PORT=<rtc> NEXTRA_E2E_RTC_MAX_PORT=<rtc> npx playwright test --workers=1 <files>`;
`SHARE_BASE_URL` must be `https://nextra.cloudflare.test:<port>` or the relay test cannot work. Pairs outside 3210 / 42100-42199 need no lock.
The lock stays necessary only for a run on the defaults (3210, 42100-42199).
