# Implementation board

Updated: 2026-08-07. This is the only board, and the only Markdown file directly
in `implementation/`. `implementation/tasks/` holds one executable task file per
Ready card — see `tasks/README.md` for the model routing and the executor
contract. A task file restates its card as a self-contained prompt for an
executor with no conversation history; when the two disagree, this board wins
and the task file is stale.

## Current status

T20–T23 add macOS as a second supported packaging target (user-approved
2026-08-07, D09). All four are done as of 2026-08-07: T20 measured the existing
gate on darwin before any change, T21 produced the artifact, T22 put it under
the same portable smoke gate as Windows, and T23 wired both platforms into CI,
the release pipeline, and the docs.

T21 produced a runnable unsigned `Nextra-macos-arm64` and smoked it on
darwin-arm64. T20 then ran all eight `release:prep` gates individually on the
same machine; seven pass, and the one failure is the pre-existing `.gitignore`
assertion described below, confirmed non-portability. T22 replaced the
Windows-only PowerShell smoke with a portable `scripts/smoke-packaged.js` and
verified it end-to-end against a real macOS artifact, packaged with an
official nodejs.org Node build after Homebrew's dynamically-linked one proved
unusable for caxa packaging. T23 added a `macos-package` CI job alongside
`windows-package`, split `release.yml` into a build matrix plus a single
`publish` job so two platforms can't race on `gh release create`, retargeted
`scripts/evaluate-packaging.js` at both platforms, and corrected every
Windows-only claim in `README.md`.

Two outward-facing steps remain and were deliberately left to the user rather
than run by any card or the controller: pushing a branch so `macos-package`
and the rest of `ci.yml` actually run on GitHub's `macos-14` runner (only
then can `scripts/smoke-packaged.ps1` be deleted, per T22's own sequencing
rule — it still exists alongside `scripts/smoke-packaged.js` right now), and
pushing a version tag to exercise the real `release.yml` publish path. Every
check below that point is local-only and independently re-verified by the
controller; nothing has run on GitHub's infrastructure yet. Nothing in this
work is committed — it sits uncommitted in the working tree alongside T21's
changes, exactly as T21 already did.

One pre-existing failure is open across the whole board, confirmed by T20's
2026-08-07 baseline run: `npm test` fails `tests/releaseWorkflow.test.js`
"release compliance files are trackable and required package inputs", which
asserts `.gitignore` contains `!implementation/archive/**/*.md` while
`.gitignore` has `!archive/**/*.md`. Commit `403bb09` pruned the archive tree
without updating the assertion. This fails `npm run release:prep` on every
platform and is unrelated to macOS; it needs its own card. T22 and T23 both saw
this same failure in their own `npm test` / `node --test
tests/releaseWorkflow.test.js` runs — confirmed baseline both times, not a
regression either introduced.

T18 and T19 are done. T17 remains blocked on an external network/TURN setup, not
on a pending user decision.

Cards T01–T16 are complete. Their completion records, along with the 2026-07-26
audit consolidation that produced them, were removed on 2026-08-04 and remain
retrievable from git history at commit `84b1634`.

### In progress

_None._

### Ready

_None._

### Backlog

#### T24 — macOS media play/pause fallback

`pressMediaPlayPauseFallback()` in `lib/socket.js` rejects on darwin: Windows uses
a `keybd_event` PowerShell path and Linux uses `xdotool`, leaving macOS covered
only by the optional `@nut-tree-fork/nut-js` dependency. The AppleScript key-code
equivalent requires the user to grant Accessibility permission to the process,
which is a product decision about prompting, not a mechanical port. Not started;
needs a user decision before it becomes Ready.

### Done

#### T23 — macOS CI, release artifact, and support documentation

CI and the release pipeline now build, smoke, and publish macOS alongside
Windows, and every Windows-only claim in the docs and packaging evaluator is
corrected. Controller independently re-ran every check below against the
executor's report rather than accepting it as written; all matched exactly.

`.github/workflows/ci.yml` gains a `macos-package` job (`runs-on: macos-14`)
mirroring `windows-package`: `npm ci` → `npm run release:prep` →
`npm run package:artifact` → `npx playwright install chromium` →
`node scripts/smoke-packaged.js`. A failure there fails the run exactly as
`windows-package` does; `verify`, `browser-media`, and `windows-package` are
unchanged.

`.github/workflows/release.yml` is split to remove the publish race a
same-file two-platform matrix would have created (both legs of a bare matrix
could observe "no release yet" and both call `gh release create`, and the
loser fails or clobbers the winner's notes):

- `package-smoke`: a `fail-fast: false` matrix over `windows-2022` and
  `macos-14` that packages, smokes (platform-appropriate shell, `if:
  runner.os == ...`), and uploads each platform's artifact/checksum pair
  under its own `actions/upload-artifact` name
  (`Nextra-${{ github.ref_name }}-windows` /
  `-macos`).
- `publish`: `needs: package-smoke`, `runs-on: ubuntu-latest`, downloads both
  artifact sets via `actions/download-artifact`
  (`pattern: Nextra-${{ github.ref_name }}-*`, `merge-multiple: true`), then
  runs `gh release view/create/upload/edit` in bash exactly once for all four
  files. The race is closed structurally — there is only one call site left
  in the file, gated by `needs:` — not papered over with `--clobber` or
  retries. New action reference (`actions/download-artifact`) is SHA-pinned
  with a version comment, matching the existing style.

`tests/releaseWorkflow.test.js`: the first test renamed and re-pinned to the
new structure (`runs-on: ${{ matrix.os }}`, the per-platform notes wording);
12 of its other assertions are untouched because they're still literally true
of the restructured file. Three new tests added: the matrix builds and
uploads both artifacts; publishing happens in exactly one job (asserts `gh
release view/create/upload "$tag"` — the real invocations, argument included
— each occur exactly once in the file, guarding against the specific race
this card exists to close; the regex deliberately excludes the explanatory
comment above `publish:`, which itself contains the prose "gh release
create"); and pull-request macOS CI mirrors the Windows smoke path. Line 31,
`assert.doesNotMatch(workflow, /SIGNING_PFX|signtool|Authenticode/)`, is
confirmed byte-for-byte unchanged at the same line number — D06/D09 stay out
of scope.

`scripts/evaluate-packaging.js`: `format` is now `['Windows x64 executable',
'macOS arm64 executable']`; `verifiedBy` adds `scripts/smoke-packaged.js` (was
`.ps1`) and `'macOS CI'`. The `status: 'invalid'` ternary is untouched.

`README.md`: supported-platforms statement and the `chmod +x` +
`xattr -dr com.apple.quarantine ./Nextra-macos-arm64` first-run steps added to
Quick Start; lines 414 and 421-429 rewritten for both platforms while keeping
the D05 browser-scope and D08 source-tag sentences verbatim; troubleshooting
table gained a macOS row pointing at `$TMPDIR/Nextra/logs/startup-latest.log`
— verified against `resolveLogDir()` in `lib/startupRuntime.js`, which falls
through to `os.tmpdir()` on macOS since `LOCALAPPDATA` is Windows-only; the
cloudflared-verification sentence corrected to state Authenticode checking is
Windows-only (macOS gets pinned-SHA-256-only verification, matching what T21
already found in `verifyCloudflared()`); "do not commit" note and the
`npm run package` description generalized to both artifact names.

Checks, all re-run independently by the controller after the executor's
report, same results both times: `node --test tests/releaseWorkflow.test.js`
— 9 tests, 8 pass, 1 fail (the pre-existing `.gitignore`/`403bb09` mismatch,
confirmed baseline by T20, not touched here). `npm run evaluate:packaging` —
exit 0, `current.format` names both platforms. `npm run lint` — exit 0. `npm
test` — 203 tests, 201 pass, 1 fail (same pre-existing failure), 1 skipped
(pre-existing, FFmpeg absent on this machine). `npm run oss:check` — exit 0,
"Tracked-file safeguards and reviewed production dependency licenses passed."
`git status --porcelain` after all of the above shows only the expected
modified/added files across T21+T22+T23, nothing stray.

Not run, and explicitly not the executor's or controller's call: no branch was
pushed and no CI job was triggered on GitHub's infrastructure, so
`macos-package`, the matrix legs, and `publish` are unexercised beyond static
assertions against the workflow YAML; no tag was created or pushed, so the
real publish path (matrix → download-artifact → single `gh release`
call) has not run for real. Both are outward-facing actions and are the
user's decision — see **Current status**.

#### T22 — One portable packaged smoke test for both platforms

`scripts/smoke-packaged.js` (327 lines, CommonJS, no new dependency) replaces
`scripts/smoke-packaged.ps1` as the single script both `ci.yml`'s
`windows-package` job and `release.yml`'s packaging job run. All ten assertions
from the PowerShell script are ported and enforced, none dropped or loosened:
the child env (`AUTO_PUBLIC_TUNNEL`, `OPEN_BROWSER`, `PORT=31847`,
`NEXTRA_SMOKE_TEST`, `LOCAL_HTTPS`, `BIND_HOST`, `WORKER_RECOVERY_MIN_UPTIME_SECONDS`),
`/readyz` polling, the SPA shell, the Socket.IO polling handshake, the four
`/api/package-info` artifacts, media-worker kill-and-recover with both PIDs
changed, the Playwright decoded-frame flow, graceful shutdown, and leftover
caxa/cloudflared process detection against a pre-launch baseline. Process
enumeration/termination branches per platform (POSIX `ps -Ao pid=,args=` vs.
Windows `Get-CimInstance Win32_Process`), matching the two macOS findings T21
flagged: SIGTERM now targets the `node` child (not just the caxa stub), and the
stale-extraction check catches a reused caxa identifier.
`tests/releaseWorkflow.test.js` lines 22 and 41 now pin
`node scripts/smoke-packaged.js` as tightly as they pinned the old path.
`scripts/smoke-packaged.ps1` is retained — Windows CI has not yet run against
the replacement — so both files currently exist, exactly per the card's own
sequencing rule.

`scripts/package-app.js` was read but not touched, per the card's own scope.

A real packaging environment bug surfaced and was resolved without any source
change: this machine's default `node` is Homebrew's `node@22`, dynamically
linked against `@rpath/libnode.127.dylib`; caxa embeds only the bare `node`
binary, so a macOS artifact packaged under it dies at launch with a dyld error
— the exact failure T21 already flagged under **Current status**/T20's record
as "packaging on macOS requires an official nodejs.org build." First
verification pass hit this and was correctly diagnosed (`otool -L`) rather than
worked around in-repo; second pass downloaded the official
`node-v22.23.2-darwin-arm64.tar.gz`, verified its SHA-256 against nodejs.org's
`SHASUMS256.txt` before extracting (same discipline as T21's cloudflared
pinning), confirmed via `otool -L` it links no external `libnode`, and used its
`bin/` on `PATH` only for `npm run package:artifact` and the smoke run itself —
no system/Homebrew change, nothing persisted outside the scratch download.

Checks: `npm run package:artifact` under the official nodejs.org Node — pass,
produced a fresh `Nextra-macos-arm64` (109,645,987 bytes) after clearing a
stale `$TMPDIR/caxa/applications/` extraction left over from T21. `node
scripts/smoke-packaged.js` under the same `PATH` — pass, exit 0, all ten
assertions genuinely exercised (no `DYLD_LIBRARY_PATH` override). Post-run
`pgrep -fl cloudflared` and `pgrep -fl 'caxa/applications/nextra-'` — no
matches. `node --test tests/releaseWorkflow.test.js` — 5 pass, 1 fail (the
pre-existing `.gitignore` mismatch T20 already confirmed as baseline, not a
regression); both updated path pins pass. `npm run lint` — pass. `npm test` —
198/200 pass, the one failure the same pre-existing baseline, one pre-existing
FFmpeg-absent skip.

Windows is explicitly outstanding: `windows-package` in `.github/workflows/ci.yml`
must run and pass against `scripts/smoke-packaged.js` before
`scripts/smoke-packaged.ps1` is deleted. Not run — pushing a branch to trigger
CI is outward-facing and was left for the controller/user, not run
unilaterally by the executor.

#### T20 — macOS gate baseline before any packaging change

Confirms, gate by gate, that the release gate is portable to darwin-arm64 except
for one already-known, non-macOS defect. Measurement only; no source change.

Ran on macOS 15 (Darwin 25.6.0) arm64, Node v22.23.2 / npm 10.9.8 (Homebrew
`node@22`, already installed while doing T21). `npm ci` completed against the
existing `node_modules` (mediasoup worker already built by T21). Each of the
eight `release:prep` gates was run individually rather than through the chained
script, so a failure partway through couldn't hide the ones after it:

- `npm run lint` — pass
- `npm run typecheck` — pass
- `npm test` — fail: `tests/releaseWorkflow.test.js` "release compliance files
  are trackable and required package inputs" (line 83) asserts `.gitignore`
  contains `!implementation/archive/**/*.md`; the file has `!archive/**/*.md`
  instead. This is the failure predicted under **Current status** from reading
  commit `403bb09`; this run confirms it with real command output instead of
  leaving it "expected-but-unconfirmed." Not a macOS portability defect — the
  assertion is a plain string match against a checked-in file, unrelated to any
  platform-specific code path, and would fail identically on any OS.
- `npm run test:coverage` — pass
- `npm run build` — pass
- `npm run evaluate:packaging` — pass
- `npm run oss:check` — pass
- `npm run audit:prod` — pass

`git status --porcelain` was captured before the run (already non-empty: T21's
uncommitted changes plus this card's own board edit) and again after; the two
were identical, so no gate touched a tracked file. No repository file was edited
by this card.

Checks: the eight gates above, run individually rather than via
`npm run release:prep`, per the card's own instruction not to chain them so a
later failure isn't hidden by an earlier one.

Classification (controller call, since the task deliberately withholds this
judgment from its executor): the one failure is the already-tracked
`.gitignore`/test mismatch from commit `403bb09`, still needing its own separate
card. It blocks neither T21 (already done) nor T22/T23, which do not depend on
that assertion; both will see the same pre-existing failure in their own
`npm test` runs and should treat it as baseline, not a regression.

Carried forward from T21, restored here after being dropped from this card's
first draft — still load-bearing for T22/T23: Homebrew's `node@22` (the `node`
this gate baseline ran under) is dynamically linked against
`@rpath/libnode.127.dylib`. caxa copies only the `node` binary into a packaged
artifact, so a macOS artifact built with the Homebrew node dies at launch with a
dyld error. Packaging on macOS requires an official nodejs.org build instead,
which is what `actions/setup-node` installs, so CI is unaffected — this only
bites local packaging on a machine whose default `node` is Homebrew's. T22
independently rediscovered this exact failure while packaging for its smoke
verification; see its card.

#### T21 — Package Nextra on macOS through the existing caxa path

`npm run package:artifact` now produces a runnable unsigned macOS artifact.
caxa is retained; no dependency was added.

cloudflared ships macOS as a `.tgz` holding a single `cloudflared` entry, while
Windows ships a bare `.exe`, so on macOS the pinned digest covers the archive and
the download path needed an extraction step. `bundleCloudflared()` branches on
`assetName.endsWith('.tgz')` and runs download → verify → extract → chmod → stage
in that order, inside an `os.tmpdir()` scratch directory removed in a `finally`.
Extraction uses `/usr/bin/tar` (bsdtar) via `spawnSync`. On macOS the pinned
checksum is the only check a download gets, since `verifyCloudflared()` returns
early for non-win32 before the Authenticode block — hence the strict ordering.

- `scripts/cloudflared-manifest.json`: added `cloudflared-darwin-arm64.tgz` and
  `cloudflared-darwin-amd64.tgz`, both SHA-256 computed from the downloaded
  archives. Cross-check: re-downloading `cloudflared-windows-amd64.exe` from the
  same `2026.7.1` tag reproduced its already-pinned digest exactly, confirming
  the tag's assets are the ones originally pinned. Windows entries unchanged.
- `getCloudflaredAssetName()` takes `(platform, arch)` defaulting to the
  `process` values so it is unit-testable, and returns the darwin assets instead
  of throwing.
- `outputExe`/`outputSha256` are platform-specific. Windows keeps the literals
  `Nextra.exe` and `Nextra.exe.sha256`; macOS uses `Nextra-macos-${process.arch}`
  so arm64 and x64 can coexist in one Release.
- `require.main === module` guard plus a `module.exports`, following
  `scripts/opensource-preflight.js`. New `tests/packageApp.test.js` covers the
  four supported platform/arch pairs, asserts each resolves to a pinned manifest
  entry, and asserts unsupported architectures still throw.
- `.gitignore` and `scripts/opensource-preflight.js` gained the macOS artifact
  name, which neither previously covered — without this a ~105 MB binary was
  committable.

Checks on darwin-arm64 with an official nodejs.org Node 22.23.2:
`node --test tests/packageApp.test.js` 3 pass, confirmed 0 pass / 1 fail against
the pre-change source (no exports, and the unconditional `main()` fired on
require — the two things step 5 fixes). `npm run lint`, `npm run typecheck`, and
`npm run build` clean. `npm test` 198 pass / 1 fail, the failure pre-existing and
unrelated (see **Current status**). `npm run package:artifact` produced
`Nextra-macos-arm64` (105 MB, Mach-O arm64) and `Nextra-macos-arm64.sha256`;
`shasum -a 256 -c` OK. The artifact started, `/readyz` returned 200 with http,
socketIo, mediaWorker, spa, and whip all ready, and `/` served the SPA shell —
so the mediasoup native worker runs inside a caxa bundle on macOS.

Negative path verified: with the darwin digest deliberately corrupted, packaging
aborted with the checksum mismatch before extracting, and left no `.caxa-stage`,
no scratch directory, and no stray binary or archive.

Bundled cloudflared verified inside the extracted bundle at all three paths
`copyCloudflaredToStage()` writes to, each mode 0755 with the same SHA-256 as the
binary independently extracted from the pinned archive, and executing as
`cloudflared version 2026.7.1`.

Windows was reviewed by reading, not run — that regression check belongs to the
`windows-package` CI job and is still outstanding. On win32, `assetName` is
always a `.exe`, so the new `.tgz` branch is skipped and the original download
tail runs unchanged; the `getCloudflaredAssetName()` Windows switch returns the
same three assets and only interpolates the `arch` parameter, which equals
`process.arch` at its single call site; `verifyCloudflared()`,
`prepareWindowsCaxaStub()`, `clearOutputExe()`, `getBuildIdentifier()`, and
`writeReleaseChecksum()` are untouched.

Known macOS limitation, not a regression: the manifest pins the archive, so the
`CLOUDFLARED_PATH`, `ALLOW_LOCAL_CLOUDFLARED`, and PATH-reuse shortcuts cannot
match a bare `cloudflared` binary and macOS always downloads. All three fail
closed. `cloudflared-windows-arm64.exe` also remains returnable but unpinned, a
pre-existing gap that fails closed at the "No pinned cloudflared checksum" guard.

#### T19 — Stop OBS when the room it streams to goes away

User-reported: killing the server or closing the host page mid-stream leaves OBS
streaming, and the next session misbehaves.

WHIP is client-driven: a session ends only when OBS sends
`DELETE /whip/broadcast/:resourceId`, and OBS ignores ICE/DTLS teardown. The
server's only leave-detector is `dtlsstatechange` (`lib/whipRoutes.js`), which a
SIGKILL never triggers. obs-websocket is the only channel that can stop OBS, and
it was wired to exactly one call site: the Stop sharing button.

Two changes, both in the browser:

- `src/lib/obsWebSocket.js`: `stopActiveStream()` moved out of the `if (autoStart)`
  block in `configureObsStream()`. `SetStreamServiceSettings`, `SetVideoSettings`,
  `SetProfileParameter`, and `SetOutputSettings` all ran unconditionally below it,
  so with auto-start off they rewrote settings underneath a live output — the
  obs.dll video-pipeline race already noted in that file. A stream that outlived
  its target is still `outputActive`, making this the common path on the second
  Start sharing.
- `openObsControlChannel()` holds one identified obs-websocket connection for the
  session. `stopObsStream()` opens, identifies, and closes per call, and that
  handshake cannot finish during unload, so unload paths could not use it. The
  channel writes `StopStream` synchronously; the browser flushes queued data
  before the close frame. `withObsConnection()` gained a non-finite
  `transactionTimeoutMs` opt-out to support it.
- `src/HostView.jsx`: `stopObsIngest()` prefers the open channel and falls back to
  `stopObsStream()` when there is none (e.g. after a reload-recovery reclaim). It
  runs on pagehide, non-pagehide unmount, the start-sharing failure path, Stop
  sharing, and `terminateHostSession` — which covers a graceful server shutdown,
  since the `room-ended` broadcast is the only warning OBS can get.

Reload recovery is deliberately untouched: it keeps the room alive across
pagehide, so OBS should keep streaming. A killed or crashed server still cannot
signal anything; the reconfigure fix is what stops that from breaking the next
session.

Checks: `npm run lint`, `npm run typecheck`, `npm test` (197 pass, 4 new in
`tests/obsWebSocket.test.js`), `npm run build`. The 4 new tests were confirmed
failing against the pre-change `src/lib/obsWebSocket.js` via `git stash`.
`README.md` troubleshooting table gained a row for the surviving gap.

#### T18 — Responsive layout pass across all views

User-reported: the How to Use and Host tabs did not scale across resolutions,
and the Host settings cards kept their height until the page grew a scrollbar.

Measured before the change (Playwright, `src/index.css` as shipped):

- `/#host` with OBS ingest selected: video stage 160 px wide at 1024 px, 416 px
  at 1280 px. The side panel is `flex: 0 0 auto` with a hard width, so the stage
  absorbed every pixel the two settings cards took.
- `/#host` page height a constant 965 px: +197 px over a 1366x768 viewport and
  +245 px over 1280x720, in both ingest modes. No `max-height` media query
  existed anywhere in the stylesheet.
- `/#how-to`: prose fixed at 680 px (27% of a 2560 px screen) while the browser
  support table overflowed into a sideways scroll at *every* width, 1024 through
  2560.

After:

- Stage ≥ 560 px at 1024/1280/1440/1600 px with OBS on (was 160/416/576/672).
- `/#host` fits 1366x768 and 1280x720 with no page scroll, both ingest modes.
- Support table no longer overflows at any width (630 px → 899-1118 px).
- Article prose 640 px, legal 704 px — within 8 px of the previous design.

Changes, all in `src/index.css` except the last two:

- Shared layout tokens; vertical rhythm clamps on `vh` so it compresses on short
  viewports, `vh` rather than `dvh` to avoid mobile URL-bar reflow.
- Host tiers at 1280 px (cards stop sharing a row) and 900 px (column stacks).
  1280 is where two side-by-side cards still leave the stage above 560 px;
  keeping them side by side also keeps the page short, since stacked cards sum
  their heights instead of the taller one winning.
- `--stage-chrome` bounds the 16:9 stage by leftover viewport height.
- Articles became a breakout grid: prose at `--article-measure`, the support
  table spanning the full width. `h2`/`.article-cta` top margins were reduced to
  compensate for grid items not collapsing margins.
- Fixed a specificity bug: the `@media (max-width: 900px)` `.host-side-panel`
  override lost to `.host-side-panel:has(.settings-expanded)` and never applied.
- `tests/browser/ui-semantics.spec.mjs`: reflow matrix widened to 9 widths x 7
  routes, plus vertical-fit and stage-width tests for `/#host`. The two new test
  groups were confirmed failing on the pre-change tree before any CSS was edited.
- `README.md`: tested-width list and the two host breakpoints.

Checks: `npm run lint`, `npm run typecheck`, `npm test` (194 pass),
`npx playwright test` (46 pass, both projects), `npm run build`.

Known gap: at 1280x720 with OBS selected the page still scrolls ~38 px, because
a WHIP preflight warning banner is showing. That banner only appears when the
server has WHIP disabled, as the test server does; the layout itself fits. The
vertical-fit test allows for visible `.alert` height rather than encoding that
environment quirk.

### Blocked

#### T17 — Real-network NAT/TURN validation

Dependencies: T05, T07, T10, T13, T14.

Goal: validate the existing public H.264 relay and TURN-backed WebRTC paths from a
viewer outside the host LAN without expanding the supported topology or limits.

Source/tests: `README.md` Internet Sharing and Operations sections,
`tests/browser/media-flow.spec.mjs`, and `scripts/benchmark-runtime.js`.

Acceptance criteria:

- an external-network viewer decodes H.264 relay media through the supported
  public-tunnel path;
- a configured TURN path is exercised across a real NAT boundary and its selected
  route is recorded without exposing credentials;
- the environment, topology, result, and any failure are recorded as
  machine-specific evidence rather than a portable support claim; and
- the default room, viewer, and relay-pipeline limits remain unchanged.

Checks when unblocked: the focused decoded-frame browser flow, one labelled live
WebRTC measurement, and manual external-network H.264 relay and TURN observations.

Blocker: the operator does not currently have the external network/TURN environment
configured. No repository change can substitute for that topology.

## Standing product decisions

| ID | Decision |
| --- | --- |
| D01 | 2026-07-28: Loopback hosts by default; remote hosting requires an operator token; public WHIP is off. |
| D02 | 2026-07-28: H.264 relay on non-loopback HTTP is allowed only for a declared trusted home LAN with a plaintext warning; TLS is required elsewhere. |
| D03 | 2026-07-29: Hardware-specific OBS/FFmpeg sync measurement is optional operator validation, not an open-source release gate. |
| D04 | 2026-07-29: Publish CI-built unsigned artifacts with checksums; signing, legal review, and dedicated release hardware are optional maintainer actions. |
| D05 | 2026-07-29: Claim desktop Chrome/Edge plus mobile Chrome viewers with a retained mobile-Chrome E2E project; everything else remains “not tested.” |
| D06 | 2026-08-01: Keep Authenticode signing out of scope while it requires maintainer-provided credentials; retain the unattended unsigned/checksum path. |
| D07 | 2026-08-01: Keep the conservative default capacity limits; raise them or change media concurrency/timing only for a demonstrated use case backed by target-host evidence. |
| D08 | 2026-08-01: Public version tags publish the tested unsigned executable and checksum with accurate support/source notes; missing or new production dependency licenses fail review. |
| D09 | 2026-08-07: macOS (arm64) is a second supported packaging target built with the existing caxa path. Artifacts ship unsigned and non-notarized; the README documents clearing the quarantine attribute. Notarization requires a paid Apple Developer account and stays out of scope, consistent with D04 and D06. |

## Future scope — requires a new user-approved card

These items are not a committed backlog and do not block the current board.

| Area | Scope and start condition |
| --- | --- |
| Packaging | Replace caxa only after an explicit migration decision and compatibility proof. |
| Hosting architecture | Add containers, multiple replicas, persistence, or accounts only for an approved hosted-product target. |
| Product features | Recording, multiple presenters, chat/reactions, E2EE, and i18n require product scope and acceptance criteria. |
| Media scaling | Add worker pools or relay worker threads only when operator measurements breach the documented thresholds. |
| Media timing | Redesign A/V timestamps only when an operator-measured sync matrix demonstrates drift. |
| Operations | Named-tunnel onboarding and configurable support/legal contacts require an operator-facing product decision. |
| Protocols | Add formal protocol schemas when clients and servers need independent deployment. |

## Verification policy

For a new card, add it to this file with dependencies, goal, named source/tests,
acceptance criteria, and exact checks. Move only one card to **In progress** per
executor. Inspect current behavior first, add a focused regression where practical,
implement the smallest complete change, and record only evidence produced by the
current run. A partial change is **Blocked**, not Done.

The standard gates are the focused test, then the smallest relevant subset of
`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and
`npm run test:e2e`; use `npm run release:prep` for the full release gate.
