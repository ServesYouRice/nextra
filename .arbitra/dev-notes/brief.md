# Brief for an agent carrying out one item of nextra's arbitra plan

You are carrying out exactly one item of a fix plan, as a coding agent a user handed the plan to. The plan was
written by arbitra from an audit of this repository. Someone reviews your work afterwards and counts what they had
to correct, so do the item fully and report plainly, including anything the prompt got wrong.

## Where

- Repository: `C:\Users\V\nextra` (Windows; the Bash tool runs Git Bash, PowerShell is also available).
- Branch: `dev`. Run `git -C C:/Users/V/nextra branch --show-current` first. If it is not `dev`, or the working tree
  has changes you did not make (`git status --short`; the gitignored `.arbitra/` folder does not show), stop and
  report; do not switch branches or stash.
- Plan: `C:\Users\V\nextra\.arbitra\plans\2026-10-23-ccd3ccea`.

## Lanes (when your instructions name one)

Several agents now work at once, each in its own git worktree. If your instructions name a lane, then instead of
the above:

- Work in `C:\Users\V\nextra-lanes\<lane>` on branch `lane/<lane>` (check it with `git branch --show-current`).
  `node_modules`, `dist` and `certs` there are links to the main checkout: never install, delete or write into them.
- The plan files (`AGENTS.md`, the prompts, `validation.md`, `questions.md`, `answers.md`) are still read from
  `C:\Users\V\nextra\.arbitra\`.
- Do not edit the plan's `PROGRESS.md` or `results.json` (other agents share them). Write your issue entries, in the
  `results.json` entry format, as a JSON array to `C:\Users\V\nextra\.arbitra\dev-notes\results\<TASK-nnn>.json`,
  and any note you would have put under the item in `PROGRESS.md` into `...\results\<TASK-nnn>.md`.
- Playwright's own web server builds into `dist`, which is a link to the main checkout: never let it. If your item
  needs a browser check, build with vite into your scratchpad and start `server.js` yourself with
  `NEXTRA_SMOKE_TEST=1` and `NEXTRA_TEST_DIST_DIR` pointing at that build, on a free port, and stop it afterwards.
  Set `NEXTRA_TEST_DIST_DIR` to that build in the Playwright process too: some specs start their own `server.js`
  and otherwise serve the main checkout's `dist`, which is an old client (that once made three specs fail falsely).
- Never create another git worktree or copy of the repository with links to `node_modules`: `git worktree remove`
  follows the junction and deletes the shared `node_modules` (it happened once). To run old code, write the old
  file over yours from `git show <rev>:<path>` in your own lane, run the test, and restore it with `git checkout --
  <path>`; or copy single files into a scratch folder that has no links. Never delete a directory that holds a link.
- Browser tests run on your lane's own ports, with no lock, once your lane has dev 437b8f2 or later
  (`git merge-base --is-ancestor 437b8f2 HEAD`; if it fails, run `git merge --ff-only dev`, or `git merge dev`
  when you already have commits). `playwright.config.mjs` takes `NEXTRA_E2E_PORT`, `NEXTRA_E2E_RTC_MIN_PORT` and
  `NEXTRA_E2E_RTC_MAX_PORT`, and a launcher does the rest. From your lane's root:
  `NEXTRA_E2E_WORK_DIR=<shared scratchpad> node <shared scratchpad>/run-e2e.cjs --workers=1 <spec files or
  playwright test options>`. The shared scratchpad is
  `C:\Users\V\AppData\Local\Temp\claude\c--Users-V-arbitra\53025464-426b-4472-9c62-52c45e3849f5\scratchpad`.
  It builds your source with vite into a private folder (never `dist`), claims a port pair, starts `server.js`,
  runs Playwright there with `NEXTRA_TEST_DIST_DIR` set, keeps traces when a run fails, and stops everything. To
  run a build of older code, write the old files over yours first and restore them afterwards, as above. Use
  `--workers=1` when several spec files run together: media-flow asserts global room counts on the shared server.
  Never run Playwright on the defaults (3210, RTC 42100-42199). The `.playwright-lock` directory is retired.
- Real-server tests take their ports from `tests/serverPorts.js` (`claimServerPorts()`); a new test that starts
  `server.js` must do the same, never a released port-0 listener.
- Name every file you put in the shared scratchpad with your lane and task (`<lane>-<TASK-nnn>-before.txt`); other
  lanes write there too.
- Put no `.js`, `.cjs` or `.mjs` file in `C:\Users\V\nextra\.arbitra\` (eslint lints that folder in the main
  checkout); keep probe scripts in the shared scratchpad, or save a copy as `.txt` if the record needs it.
- The owner does not use GitHub Actions or any hosted CI. Never add, edit or rely on `.github/workflows`; if a
  prompt asks for that, do the rest of the item and record the workflow part as not done for that reason.
- If an existing test pins the very defect you fix (it asserts the wrong behaviour, or its fixture only works because
  of the defect), do not stop: change that test as little as keeps its intent, and say exactly what and why in the
  report and in the commit body.
- Other suites run at the same time on this machine, so a test that binds ports can fail for that reason alone
  (EADDRINUSE, or "Internal error" in `tests/churnRuntime.test.js`). Run the files your item touches on their own
  first; then run `npm test` once. If only such port failures remain, rerun those files alone and report it.

## Read first

1. The plan's `AGENTS.md`.
2. `C:\Users\V\nextra\.arbitra\dev-notes\answers.md`: the owner's answers to the plan's blocking questions. They
   override any option a prompt leaves open.
3. Your item's prompt file (named in your instructions), then the files its `read_first` lists.
4. The prompts cite validation ids (`VAL-001` and so on) that the plan export left out; their assertion and evidence
   are in `C:\Users\V\nextra\.arbitra\dev-notes\validation.md`. Read the ones your prompt cites. Likewise, open
   questions it cites (`section-…/Q-004`) are in `C:\Users\V\nextra\.arbitra\dev-notes\questions.md`, each with the
   default to assume; `answers.md` overrides them. Some prompts cite VAL-145, VAL-146 or VAL-147 by mistake:
   `C:\Users\V\nextra\.arbitra\dev-notes\validation-fixes.md` gives the id each of them means.

## Do

- Follow the prompt's goal, constraints, steps and success criteria. Earlier items may already have changed the
  code it quotes; work from the code as it is now. If the defect is already gone, prove that and record
  `no_change_needed`.
- Prove first: write a test that fails on the current code for the reason the issue gives, run it, and keep the
  failing output, before you change the code. Never edit or remove an existing test to make a check pass. If no test
  can show the defect, say why.
- A check-first item (`prompts/0-check-first`) asks you to decide whether a defect is real. Decide from the code and
  a test; fix it only if it is real.
- Stay inside the files the prompt allows. If the fix truly needs another file, change it and say why in the report.

## Check

- The prompt's own verify commands.
- Then, from the repository root: `npm run lint`, `npm run typecheck` and `npm test`. All three passed on `dev`
  before this item (the test count grows as items add tests); they must pass again. The suite takes about 30 seconds.
  `tests/churnRuntime.test.js` has failed once ("Internal error" on all operations) and passed on rerun with the code
  unchanged: if it fails for you, rerun once and report it, but do not try to fix it in your item.
- The plan's `PROGRESS.md` lists the unsure "check" items first; they are handled separately, so skip them.
- Do not run `npm run package`, `release:prep` or the packaged smoke tests unless the prompt requires it; if it
  does, say so in the report. Playwright (`npm run test:e2e`) only if the prompt asks for a browser check.
- Stop any server or process you start.

## Record and commit

- Tick the item in the plan's `PROGRESS.md` (note anything left open under it) and add each issue's entry to the
  plan's `results.json` `issues` array, in the format its existing entries use (`issue`, `title`, `severity`,
  `task`, `result`, `failedBefore`, `test`, `proof`). Change nothing else in the plan folder.
- Commit on `dev` only the files of this item, one commit, never push. Message style (conventional commits, as
  the repository uses):

  ```
  fix(<area>): <what now works, in plain words>

  Found by arbitra (run-ccd3ccea, plan .arbitra/plans/2026-10-23-ccd3ccea, <TASK-nnn or check nn>); <proven by a
  test that failed on the unchanged code | why no test could show it>.

  - <one line per change that matters>

  Co-Authored-By: <your model, e.g. Claude Sonnet 5.5> <noreply@anthropic.com>
  ```

  Describe only what this commit fixes; never mention other open issues of the plan (the repository is public).
  If nothing needed changing, commit nothing.

## Report (your final message, short)

- Item, and for each issue: result, whether the test failed before the fix, the test's name.
- Files changed and the commit hash.
- Checks run and their results (test counts).
- Where the prompt was wrong, stale or incomplete, and what you did instead; anything you changed outside the
  allowed files and why; anything left for the owner.
