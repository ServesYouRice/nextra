- [x] check 09 `C-a06046ad25c1` Coverage gate calculates directory depth incorrectly causing double slashes and universal target misses: **no_change_needed** (claim does not hold; lane `scripts`, at dev bfe4d26)

  - Why the claim fails: it assumes Node indents nested coverage rows by 2 spaces per level. Node 22.14.0 indents
    by one. The reporter source embedded in `node.exe` builds each row as
    `${prefix}${StringPrototypeRepeat(' ', depth)}${getCell(file, filePadLength - depth, ...)}` and recurses with
    `depth + 1`. The real report (TAP, as `spawnSync` pipes stdout) reads:

    ```
    # lib                           |        |          |         |
    #  roomMediaPipeline.js         |  93.18 |    75.00 |   86.67 | 44-46 66-68 77-79
    # src                           |        |          |         |
    #  lib                          |        |          |         |
    #   fmp4RelayPlayer.js          |  92.12 |    72.08 |   98.18 | ...
    #   lifecycleController.mjs     |  90.00 |    70.00 |   83.33 | 16-18
    #   mediasoupClient.js          |  93.89 |    79.59 |   89.47 | ...
    ```

    In `scripts/coverage-gate.js` (lines 46-53) the regex captures the name with its leading spaces after `# `, so
    the depth is 0, 1 or 2. `pathAtDepth` stays dense and the joined paths are `lib/roomMediaPipeline.js` and
    `src/lib/lifecycleController.mjs`, which match `targets`.
  - Proof: `node scripts/coverage-gate.js` exits 0 with `Coverage thresholds passed for 4 runtime files.` (52 tests,
    0 failures).
  - A scratch harness preloads a `spawnSync` stub so the unchanged gate parses canned reports:
    - The real report: passes, exit 0.
    - The same report with lifecycleController.mjs lines set to 50%: `src/lib/lifecycleController.mjs: lines 50% is
      below 70%`, exit 1. So the gate really reads and checks the values.
    - A flat report with backslash paths (`# lib\roomMediaPipeline.js | ...`): passes, exit 0.
    - The claim's hypothetical report with 2 spaces per level: `no coverage result` for all four targets, exit 1.
      Even in that case the gate fails closed; it never passes silently.
  - Original code: `git diff ac1c688 HEAD -- scripts/coverage-gate.js` is empty, and the report format comes from
    Node, not the repository. So the defect was not real on the original code either.
  - Left open: I checked only Node 22.14.0, the only Node on this machine (`engines` is `>=22.0.0`). I did not read
    the source of other Node versions because that needs network access. If a later Node ever changed the indent, the
    gate would fail loudly with `no coverage result`, as the 2-space case above shows.
  - No file changed and nothing was committed. lint, typecheck and `npm test` were not rerun, since the tree is
    unchanged from bfe4d26.
