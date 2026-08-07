# T23 — macOS CI, release artifact, and support documentation

<model>
Model: `claude-sonnet-5`
Effort: `high`
Card: T23 in `../KANBAN.md`
Depends on: T22 done, with the portable smoke green on both platforms.
</model>

<role>
You are extending a working release pipeline to a second platform and correcting
the documentation that currently claims Nextra is Windows-only. The pipeline
publishes to the public; a mistake here is visible to everyone who downloads a
release.
</role>

<context>
`.github/workflows/ci.yml` runs three jobs — `verify` and `browser-media` on
ubuntu, `windows-package` on windows-2022. `.github/workflows/release.yml` runs a
single `package-smoke` job on windows-2022 that packages, smoke-tests, uploads
`Nextra.exe` and its checksum, and then creates or updates the GitHub Release.

Three things shape how this card must land:

**The publish step is not safe to run twice concurrently.** Today one job both
builds and publishes. The obvious change — turning `package-smoke` into a
two-platform matrix — would have both legs racing on the same
`gh release view` / `create` / `upload` sequence: both can observe "not found"
and both call `gh release create`, and the loser fails the build or clobbers the
winner's notes. Split it instead: a matrix job that only packages, smokes, and
uploads a build artifact, plus a single publish job with `needs:` on the matrix
that downloads both artifacts and does all `gh` calls exactly once. Do not try to
make the concurrent path safe with retries or `--clobber`; remove the concurrency.

**`tests/releaseWorkflow.test.js` pins this pipeline tightly.** It asserts the tag
patterns, `runs-on: windows-2022`, `node-version: '22'`, the exact `run:` lines,
`Nextra.exe` and `Nextra.exe.sha256` as line-final strings, `contents: write`,
`gh release create`, `gh release upload`, the notes phrase
`This is an unsigned Windows build`, and — at line 31 — that no signing machinery
appears (`assert.doesNotMatch(workflow, /SIGNING_PFX|signtool|Authenticode/)`).
Restructuring the workflows will break several of these. Update each to describe
the new structure with the same tightness. Line 31 must keep passing unchanged:
D09 keeps signing out of scope, so nothing you add may reference signing tooling.

**The docs currently state the opposite of what will be true.** `README.md:414`
says to keep "the verified `caxa` Windows package"; lines 421-429 describe the
release as Windows-only; the troubleshooting table at line 430 offers only a
`%LOCALAPPDATA%` log path. `scripts/evaluate-packaging.js` reports
`format: 'Windows executable'` with a `verifiedBy` list naming only Windows
evidence. Leaving these is worse than not shipping macOS at all — a user who
follows them will conclude the macOS artifact is unsupported.

Per D09 in `../KANBAN.md`, macOS artifacts ship **unsigned and non-notarized**.
Gatekeeper quarantines a binary downloaded from a browser, so the README must
give the `xattr -dr com.apple.quarantine` step or the artifact simply will not
run on a normal user's machine.
</context>

<files>
Edit: `.github/workflows/ci.yml` — add a macOS packaging job
Edit: `.github/workflows/release.yml` — split matrix build from single publish
Edit: `tests/releaseWorkflow.test.js` — update pins to the new structure
Edit: `README.md` — platform support, Gatekeeper first-run, corrected wording at
      lines 414, 421-429, and the troubleshooting table at 430
Edit: `scripts/evaluate-packaging.js` — report both targets

Read: `../KANBAN.md` *Standing product decisions* — D04, D06, D08, D09 govern
      what the release notes may claim.
Read: `scripts/package-app.js` — for the exact artifact filenames T21 produces.
Read: `../../AGENTS.md`.

Do not touch: `scripts/package-app.js`, `scripts/smoke-packaged.js`, `lib/`,
`src/`, `server.js`.
</files>

<task>
Build and smoke the macOS artifact in CI alongside Windows, publish both artifact
and checksum pairs from a single non-racing publish step, and correct every
document and script that currently describes Nextra as Windows-only.
</task>

<steps>
1. Add a macOS packaging job to `ci.yml` mirroring `windows-package`: pin
   `runs-on: macos-14` (arm64, pinned for the same reason `windows-2022` is),
   `node-version: '22'`, `npm ci`, `npm run release:prep`,
   `npm run package:artifact`, `npx playwright install chromium`, then the
   portable smoke from T22. A macOS smoke failure must fail the build exactly as
   the Windows one does.

2. Restructure `release.yml` into two jobs:
   - a build matrix over `windows-2022` and `macos-14` that packages, smokes, and
     uploads each platform's artifact and checksum via `actions/upload-artifact`;
   - a publish job with `needs:` on the matrix that downloads both, then runs the
     `gh release view` / `create` / `upload` / `edit` sequence **once**.
   Keep `permissions: contents: write`, the existing tag triggers, and the
   `RELEASE_VERSION` environment variable. Pin any new action by commit SHA with
   a version comment, matching the style already used in both workflows.

3. Rewrite the release notes to state the unsigned status per platform and to
   give macOS users the quarantine step. Keep the existing truthful claims: the
   tested-browser scope (D05), the checksum instruction, and the
   corresponding-source tag (D08). Do not claim either artifact is signed.

4. Update every assertion in `tests/releaseWorkflow.test.js` that the
   restructure invalidates, pinning the new job names, runners, artifact names,
   and notes text as tightly as the old ones were pinned. Add assertions that the
   macOS artifact and checksum are uploaded and that publishing happens in a
   single job. Leave the line-31 no-signing assertion untouched and passing.

5. Correct the documentation:
   - `README.md`: a supported-platforms statement covering Windows x64 and macOS
     arm64; the `xattr -dr com.apple.quarantine ./Nextra-macos-arm64` first-run
     step with one sentence on *why* it is needed (unsigned, non-notarized, per
     D09); the line-414 sentence rewritten so "Windows package" no longer reads
     as the only supported target; lines 421-429 rewritten to describe a
     two-platform release; a macOS log-path row in the troubleshooting table
     alongside the `%LOCALAPPDATA%` one.
   - `scripts/evaluate-packaging.js`: report both packaging targets rather than
     the single `'Windows executable'` string, and extend `verifiedBy` to name
     the macOS evidence. Keep its `status: 'invalid'` exit-code behavior.
</steps>

<constraints>
- Do not enable, reference, or scaffold code signing or notarization on either
  platform. D06 and D09 keep both out of scope, and
  `tests/releaseWorkflow.test.js:31` enforces it.
- Do not claim in any document or release note that an artifact is signed,
  notarized, or tested on a browser outside the D05 scope.
- Do not make the two publish paths concurrent, and do not paper over a race with
  `--clobber` or a retry. Publishing happens once.
- Do not weaken or delete an assertion in `tests/releaseWorkflow.test.js` to make
  it pass. Rewrite it to describe the new structure with equal precision.
- Pin every action by commit SHA, as the existing workflows do.
- Scope: workflows, their tests, README, and the packaging evaluator. Do not
  touch the packager or the smoke script.
- Never state that a workflow works because it looks right. Say plainly which
  jobs actually ran.
</constraints>

<acceptance_criteria>
- `ci.yml` packages and smokes on `macos-14`, and a failure there fails the build.
- `release.yml` builds both platforms in a matrix and publishes from exactly one
  job that `needs:` the matrix.
- A tagged run attaches four files: the Windows artifact and checksum, and the
  macOS artifact and checksum.
- Release notes state the unsigned status per platform and include the macOS
  quarantine step.
- `tests/releaseWorkflow.test.js` passes, still pins exact strings, and its
  no-signing assertion is unchanged.
- `README.md` documents both platforms and the `xattr` first-run step, and no
  longer describes packaging or releases as Windows-only.
- `scripts/evaluate-packaging.js` reports both targets.
- Every new action reference is SHA-pinned.
</acceptance_criteria>

<verification>
Run from the repository root.

    node --test tests/releaseWorkflow.test.js   # passes with updated pins
    npm run evaluate:packaging                  # JSON names both targets
    npm run lint
    npm test                                    # no regressions
    npm run oss:check

Then confirm the pipeline itself, which local commands cannot:

    # push the branch and confirm all four CI jobs pass
    gh run list --branch <branch> --limit 5
    gh run view <id>

A tagged pre-release is the only real proof of the publish path. Ask the
controller before creating a tag — publishing a release is outward-facing and is
the user's call, not yours.
</verification>

<escalate_if>
- `macos-14` runners are unavailable or the packaging job cannot complete within
  the job timeout. Runner capacity affects release cadence and is the user's
  call.
- The macOS artifact needs signing or notarization to pass its own smoke in CI.
  That reverses D09 and requires a paid Apple Developer account — user decision.
- Restructuring `release.yml` appears to require dropping an existing guarantee
  (tag patterns, `contents: write`, the truthful-notes content, or the no-signing
  assertion).
- You are asked to, or find yourself about to, push a tag. Stop. Tags publish a
  public release.
</escalate_if>

<report_format>
Return exactly this, nothing else:

**Outcome:** done | blocked | escalated
**Changed:** file paths
**Workflow structure:** the resulting job graph, and one sentence on how the
publish race is eliminated
**Test pins:** which assertions in `tests/releaseWorkflow.test.js` you rewrote and
what each now pins; confirm line 31 is unchanged
**Docs:** each README claim you corrected, with line references
**Checks:** each command with its real result. Say which CI jobs actually ran and
which are untested.
**Blocker:** what stopped it, or "none"
**Next:** the release tag decision for the user, or the blocker
</report_format>
