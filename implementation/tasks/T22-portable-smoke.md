# T22 — One portable packaged smoke test for both platforms

<model>
Model: `claude-sonnet-5`
Effort: `high`
Card: T22 in `../KANBAN.md`
Depends on: T21 done, with a macOS artifact produced.
</model>

<role>
You are porting a passing gate to a second platform without loosening it. The
existing PowerShell smoke is the only thing standing between a broken packaged
build and a published release, and every assertion in it was added because
something once went wrong. Your job is a faithful translation, not a redesign.
</role>

<context>
`scripts/smoke-packaged.ps1` (124 lines) launches the packaged executable, proves
it serves real traffic, kills its mediasoup worker to prove recovery, runs a
decoded-frame Playwright flow, shuts it down, and fails if any caxa extraction or
cloudflared process outlived it. It runs in two CI jobs today
(`.github/workflows/ci.yml:47` and `.github/workflows/release.yml:27`).

It is PowerShell-only, so the macOS artifact from T21 currently has no gate at
all. The card's goal is that the macOS artifact ships under the *same* gate as
the Windows one, not a weaker one.

Replace rather than add a second script. Two smoke tests drift: a fix applied to
one and forgotten on the other silently un-gates a platform, and that divergence
is invisible until a release breaks. One script that both jobs run cannot drift.

Two things constrain how you land this:

- **The Windows gate must be proven, not assumed.** You cannot run Windows here.
  The PowerShell script is therefore deleted only after the `windows-package` CI
  job passes on the replacement. Until then both files exist.
- **`tests/releaseWorkflow.test.js` pins the literal script path.** Line 22
  asserts `/\.\\scripts\\smoke-packaged\.ps1/` against `release.yml` and line 41
  asserts `/run: \.\\scripts\\smoke-packaged\.ps1/` against `ci.yml`. Changing the
  workflows without updating those assertions leaves the suite asserting a path
  that no longer exists. Update them to match the new invocation — do not delete
  them, and do not weaken them into a looser pattern.

`scripts/` is CommonJS (`scripts/package-app.js`, `scripts/coverage-gate.js`).
Match that; do not introduce ESM here.
</context>

<files>
Read: `scripts/smoke-packaged.ps1` — the source of truth for every assertion.
      Read all 124 lines before writing anything.
Read: `playwright.packaged.config.mjs` and `tests/browser/packaged-media.packaged.mjs`
      — the decoded-frame flow the smoke invokes.
Read: `scripts/package-app.js` `run()` (lines 47-61) — the established convention
      for `spawnSync` with `shell: process.platform === 'win32'`.

Add:  `scripts/smoke-packaged.js` — the portable replacement
Edit: `.github/workflows/ci.yml` (line 47) and `.github/workflows/release.yml`
      (line 27) — invoke the new script
Edit: `tests/releaseWorkflow.test.js` (lines 22 and 41) — update the pinned paths
Delete: `scripts/smoke-packaged.ps1` — **only after** Windows CI is green on the
      replacement. If that has not happened, leave it in place and say so.

Do not touch: `scripts/package-app.js`, `lib/`, `src/`, `server.js`.
</files>

<task>
Replace the PowerShell smoke with a single CommonJS Node script that runs the
identical assertion set on both Windows and macOS, wire both CI jobs to it,
update the tests that pin its path, and verify it against a real packaged macOS
artifact.
</task>

<steps>
1. Port every assertion below. This list is the acceptance contract — each line
   is one thing the PowerShell script proves, and none may be dropped, reordered
   into irrelevance, or softened:

   - the same env for the child: `AUTO_PUBLIC_TUNNEL=false`, `OPEN_BROWSER=false`,
     `PORT` (default `31847`), `NEXTRA_SMOKE_TEST=1`, `LOCAL_HTTPS=false`,
     `BIND_HOST=127.0.0.1`, `WORKER_RECOVERY_MIN_UPTIME_SECONDS=0`;
   - `/readyz` reaches `status: ready` **and** no required component is
     non-ready, polling ~60 times at 500 ms before failing;
   - `GET /` returns 200 and the body contains `<div id="root"`;
   - `GET /socket.io/?EIO=4&transport=polling` returns 200 and the body starts
     with `0{`;
   - `GET /api/package-info` reports all four artifacts present: `license`,
     `notices`, `sourceInstructions`, `sbom`;
   - `POST /api/test/kill-media-worker` is accepted, returning
     `status: terminating` with a `workerPid` equal to the pre-kill
     `mediaWorker.pid` from `/api/metrics`;
   - within ~60 s the app is ready again with **both** `process.pid` and
     `mediaWorker.pid` changed from their pre-kill values;
   - the Playwright decoded-frame flow passes with `NEXTRA_PACKAGED_BASE_URL`
     set, via `npx playwright test --config=playwright.packaged.config.mjs
     --project=chromium`;
   - `POST /api/test/shutdown` is followed by `/healthz` becoming unreachable
     within ~10 s;
   - after shutdown no caxa extraction process and no `cloudflared` process
     started by this run remains — both compared against a baseline captured
     *before* launch, so unrelated pre-existing processes never fail the run.

2. Write one process-enumeration helper with a branch per platform, returning
   `{ pid, command }` records for both:
   - POSIX: `ps -Ao pid=,args=` via `spawnSync`;
   - Windows: the existing `Get-CimInstance Win32_Process` query, matching on
     `ExecutablePath` and on the caxa command-line pattern
     `[\\/]caxa[\\/]applications[\\/]nextra-`.
   Keep the cleanup in a `finally` block, as the PowerShell script does, so a
   mid-run failure still tears the child down.

3. Default the executable path per platform — `Nextra.exe` on win32, the
   `Nextra-macos-arm64` name T21 produces on darwin — and accept an override
   argument, as the PowerShell `-Executable` parameter does.

4. Point both workflow jobs at `node scripts/smoke-packaged.js` and update the
   two assertions in `tests/releaseWorkflow.test.js` to match the new invocation.

5. Delete `scripts/smoke-packaged.ps1` only once the `windows-package` job has
   passed on the replacement.
</steps>

<constraints>
- Do not drop, relax, or make conditional any assertion in step 1 to get a green
  run on macOS. A check that cannot be made to work on macOS is an escalation.
- Do not weaken the two `tests/releaseWorkflow.test.js` assertions into a vaguer
  regex. They should pin the new path as tightly as they pinned the old one.
- Do not add a dependency. Node 22 has `fetch` built in; use `node:child_process`
  and `node:timers/promises` for the rest.
- Do not change the packaged app, its endpoints, or the Playwright flow. If an
  assertion fails, the artifact is wrong — not the assertion.
- Scope: the smoke script, the two workflow invocations, and the two pinned test
  assertions. Nothing else.
- Never claim the Windows path works. You cannot run it here.
</constraints>

<acceptance_criteria>
- `scripts/smoke-packaged.js` exists, is CommonJS, and adds no dependency.
- Every assertion in step 1 is present and enforced.
- Process enumeration and termination work on both platforms, each compared to a
  pre-launch baseline.
- Both workflow jobs invoke the new script.
- `tests/releaseWorkflow.test.js` passes and still pins an exact path.
- The smoke passes against a real packaged macOS artifact.
- `scripts/smoke-packaged.ps1` is deleted only if Windows CI passed on the
  replacement; otherwise it remains and the report says why.
</acceptance_criteria>

<verification>
Run from the repository root, in order.

    npm run package:artifact              # produces the macOS artifact (T21)
    npx playwright install chromium       # once, if not already present
    node scripts/smoke-packaged.js        # every stage passes; exits 0

    node --test tests/releaseWorkflow.test.js   # passes with the updated pins
    npm run lint
    npm test                              # full unit suite; no regressions

After the run, confirm nothing leaked:

    pgrep -fl cloudflared                 # no process from this run
    pgrep -fl 'caxa/applications/nextra-' # nothing

The Windows leg runs in the `windows-package` CI job and is the controller's to
dispatch. Report it as outstanding.
</verification>

<escalate_if>
- An assertion cannot be reproduced on macOS — most likely the caxa extraction
  path shape or the process-command matching differs. Report the specific
  assertion and what differs; do not drop it and do not loosen its pattern.
- The macOS artifact fails the media-worker replacement check. That is a
  packaged-runtime defect belonging to T21, not a smoke-test defect.
- The Playwright decoded-frame flow fails on macOS for a browser or codec reason
  rather than an app reason. Tested-browser scope is a product decision (D05 in
  `../KANBAN.md`) and is not yours to widen or narrow.
- Making the two CI jobs share one script appears to require restructuring the
  workflows beyond the smoke step. T23 owns workflow structure.
</escalate_if>

<report_format>
Return exactly this, nothing else:

**Outcome:** done | blocked | escalated
**Changed:** file paths, and whether `smoke-packaged.ps1` was deleted or retained
**Assertion parity:** each of the ten assertions from step 1, marked ported or
not, with a line reference into the new script
**Checks:** each command with its real result
**Windows:** stated as outstanding, with the CI job that must run
**Blocker:** what stopped it, or "none"
**Next:** T23, or the decision needed
</report_format>
