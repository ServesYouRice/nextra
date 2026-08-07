# T21 — Package Nextra on macOS through the existing caxa path

<model>
Model: `claude-opus-5` (or Codex)
Effort: `xhigh`
Card: T21 in `../KANBAN.md`
Depends on: T20 done, with its gate results recorded.
</model>

<role>
You are making an unsigned macOS build possible without weakening the supply-chain
checks that protect the Windows build, and without changing the Windows output at
all. Two things can go wrong here that no test on this machine will catch: a
regressed Windows artifact, and a bundled binary that was never really verified.
Both are your responsibility.
</role>

<context>
`npm run package:artifact` runs `scripts/package-app.js`, which stages the app,
installs production dependencies, bundles `cloudflared`, and hands the stage to
`caxa` to produce a single executable. It works on Windows and refuses to run
anywhere else.

Established before this card was written — verified, do not re-derive:

- **caxa 3.0.1 ships `stub--darwin--arm64` and `stub--darwin--x64`.** Confirmed by
  listing the published npm tarball. `getDefaultCaxaStub()` at
  `scripts/package-app.js:314` already interpolates `process.platform` and
  `process.arch`, so it resolves correctly on macOS with no change. caxa is
  retained, not replaced — replacing the packager is explicitly out of scope
  under `../KANBAN.md`'s *Future scope* table.
- **cloudflared ships macOS as gzipped tarballs, not bare binaries.** For tag
  `2026.7.1` the assets are `cloudflared-darwin-arm64.tgz` and
  `cloudflared-darwin-amd64.tgz`. Windows ships bare `.exe` files, which is why
  the current download path writes the response body straight to its final
  location and has no extraction step. This asymmetry is the substance of the card.
- `prepareWindowsCaxaStub()` (line 317) already returns early on non-win32, and
  `getBuildIdentifier()` (line 257) already handles the bare `cloudflared` name.
  Neither needs changing.
- `verifyCloudflared()` (line 171) compares the SHA-256 first, then returns early
  for non-win32 at line 179 — Authenticode is Windows-only. On macOS the pinned
  checksum is therefore the *only* thing standing between a hostile download and
  a bundled binary. That is why the ordering requirement below is absolute.
- `lib/tunnel.js` `getCloudflaredCandidates()` already looks for a file named
  `cloudflared` (no extension) on non-Windows, in the same three locations
  `copyCloudflaredToStage()` writes to. Nothing in `lib/` needs to change.
- `scripts/opensource-preflight.js` guards its entry point with
  `if (require.main === module) main();` and exports its pure helpers, and
  `tests/opensourcePreflight.test.js` imports them directly. Follow that
  convention — `scripts/package-app.js` currently calls `main()` unconditionally
  at line 481 and exports nothing, which is why it has no unit test today.
</context>

<files>
Edit: `scripts/package-app.js`
  - `outputExe` / `outputSha256` (lines 11-12) — hardcoded `Nextra.exe`
  - `getCloudflaredAssetName()` (lines 104-119) — throws on non-win32
  - `bundleCloudflared()` (lines 368-430) — downloads, never extracts
  - bottom of file (line 481) — add the `require.main` guard and exports
Edit: `scripts/cloudflared-manifest.json` — add the two darwin checksums
Add:  `tests/packageApp.test.js` — focused unit test

Read: `lib/tunnel.js` `getCloudflaredCandidates()` — confirms the bundled name
      and search paths you must match. Do not edit it.
Read: `tests/opensourcePreflight.test.js` — the export/test convention to follow.
Read: `tests/releaseWorkflow.test.js` lines 56-75 — it asserts against the *text*
      of `scripts/package-app.js`. Line 60 requires the literal string
      `Nextra.exe.sha256` to appear in the file, and lines 66-74 require the
      Windows checksum and Authenticode diagnostic strings to survive verbatim.
      Your step 4 must therefore keep the Windows filenames as literals in the
      win32 branch rather than composing them entirely from variables, and your
      step 3 must not reword the existing failure messages. These tests are not
      yours to relax — if one has to change, that is an escalation.
Read: `../../AGENTS.md` — product boundaries and verification rules.

Do not touch: `lib/`, `src/`, `server.js`, `.github/workflows/` (T23 owns CI),
`scripts/smoke-packaged.ps1` (T22 owns it).
</files>

<task>
Make `npm run package:artifact` produce a runnable unsigned macOS arm64
executable, while leaving the Windows output byte-identical in name and layout.
The macOS cloudflared archive must be checksum-verified against a pinned manifest
entry *before* it is extracted, and a failed verification must leave nothing
behind.
</task>

<steps>
Steps 1 and 2 are ordered: the manifest entries must exist before the code that
reads them can be tested. Steps 3-5 are independent of each other.

1. Fetch the two darwin asset checksums for the version already pinned in
   `scripts/cloudflared-manifest.json` (`2026.7.1`) and add them under the
   existing `assets` key, alongside the Windows entries. Compute each SHA-256
   from the downloaded archive itself; do not copy a digest out of a web page.
   Leave the Windows entries untouched.

2. Teach `getCloudflaredAssetName()` to return the darwin `.tgz` asset for
   `arm64` and `x64` instead of throwing. Keep the existing Windows branch and
   its unsupported-architecture error exactly as they are.

3. Add extraction to `bundleCloudflared()` for the darwin path, in this order,
   which is a security boundary and not a style preference:
   download the archive → verify its SHA-256 against the manifest → only then
   extract → confirm the extracted `cloudflared` is executable → stage it.
   Never extract an archive whose digest has not matched. On any failure, remove
   both the archive and anything extracted from it, so a failed run cannot leave
   a partially-staged binary that a later run might pick up.

   Use the system `tar` via `spawnSync`. macOS ships bsdtar at `/usr/bin/tar`.
   Adding a tar library would be a new dependency, which `../../AGENTS.md`
   forbids without an approved card. Extract into a scratch directory rather
   than directly into the stage, and stage only the `cloudflared` entry.

4. Make the release output path platform-specific. Windows keeps `Nextra.exe`
   and `Nextra.exe.sha256` exactly as today. macOS produces a name carrying the
   architecture, so an arm64 and an x64 artifact can coexist in one GitHub
   Release without collision — `Nextra-macos-arm64` and
   `Nextra-macos-arm64.sha256`. Keep the existing `${checksum} *${basename}`
   line format; the `*` binary marker is understood by `shasum -c` on macOS.

5. Add the `require.main === module` guard and a `module.exports` block exposing
   the pure helpers, then write `tests/packageApp.test.js` covering:
   - `getCloudflaredAssetName()` returns the right asset for darwin arm64,
     darwin x64, win32 x64, and win32 ia32;
   - every name it can return has a matching entry in the manifest — this is the
     test that fails loudly if someone bumps the pinned cloudflared version and
     forgets one platform;
   - an unsupported architecture still throws.
</steps>

<constraints>
- The Windows path must be untouched in behavior. The stub, icon, locked-file
  rename dance, Authenticode check, and output filenames all stay as they are.
  You cannot test this locally, so review the Windows branch of every function
  you edit and state in your report what you checked.
- Never extract, execute, or stage a downloaded file before its pinned SHA-256
  has matched.
- Do not add a runtime or dev dependency. Use Node built-ins and system `tar`.
- Do not change `caxa`, the packaging format, or the set of staged files.
- Scope: no adjacent refactors. `clearOutputExe()` keeps its name even though it
  now clears a non-`.exe` on macOS — renaming it is churn this card does not need.
- Do not add error handling for cases that cannot occur. Validate the download,
  the checksum, the extraction, and the child process — those are trust
  boundaries. Do not validate internal call shapes.
- Never claim a code path works without reading it. If you assert something about
  the Windows branch, quote the lines you read.
</constraints>

<acceptance_criteria>
- `scripts/cloudflared-manifest.json` contains SHA-256 entries for
  `cloudflared-darwin-arm64.tgz` and `cloudflared-darwin-amd64.tgz`, and its
  Windows entries are unchanged.
- `getCloudflaredAssetName()` returns the darwin asset on darwin and no longer
  throws there; it still throws for an unsupported architecture.
- A checksum mismatch, a missing manifest entry, or a failed extraction aborts
  packaging and leaves no archive and no extracted binary on disk.
- The staged `cloudflared` is executable and lands at all three paths
  `copyCloudflaredToStage()` already writes to.
- `npm run package:artifact` on darwin-arm64 produces `Nextra-macos-arm64` and a
  matching `Nextra-macos-arm64.sha256`.
- The produced binary starts, serves the SPA, and `/readyz` returns 200.
- `tests/packageApp.test.js` passes and fails against the pre-change file.
</acceptance_criteria>

<verification>
Run from the repository root, in order.

    node --test tests/packageApp.test.js
        # passes; then confirm it fails against the original file
        # (git stash the change, re-run, restore) and say so in your report

    npm run lint
    npm run typecheck
    npm run package:artifact
        # produces Nextra-macos-arm64 and Nextra-macos-arm64.sha256

    shasum -a 256 -c Nextra-macos-arm64.sha256      # OK
    ./Nextra-macos-arm64 &                          # note the PID
    curl -fsS http://127.0.0.1:3000/readyz          # 200 with every required
                                                    # component ready
    kill <pid>

If the port differs from 3000 in `config.js`, use the configured one; say which
you used.

The Windows regression check cannot run here. It belongs to the `windows-package`
CI job and is the controller's to dispatch — report that it is outstanding rather
than claiming the Windows path is unaffected.
</verification>

<escalate_if>
- A published cloudflared darwin checksum cannot be obtained for the pinned
  version `2026.7.1`. Do not substitute a different version and do not proceed
  unpinned — stop and report.
- The macOS artifact builds but fails to start, and the cause is the caxa stub
  or the mediasoup native worker rather than your change. That decides whether
  caxa remains viable on macOS, which is a packaging-format decision reserved for
  the user under `../KANBAN.md`'s *Future scope* table.
- Making this work appears to require touching `lib/`, `src/`, or `server.js`.
  The card asserts it does not; if that assertion is wrong, the card is wrong.
- Making this work appears to require a new dependency.
</escalate_if>

<report_format>
Return exactly this, nothing else:

**Outcome:** done | blocked | escalated
**Changed:** file paths
**Windows review:** which Windows branches you read and why each is unaffected,
with line references. Say plainly that the Windows build was not run here.
**Checks:** each command with its real result, including whether the new test was
confirmed failing against the pre-change file.
**Artifact:** the produced filename and its SHA-256, or why none was produced
**Blocker:** what stopped it, or "none"
**Next:** T22, or the decision needed
</report_format>
