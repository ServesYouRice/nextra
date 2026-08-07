# T20 — Establish the macOS gate baseline

<model>
Model: `claude-haiku-4-5`
Effort: omit — `claude-haiku-4-5` rejects the `effort` parameter
Card: T20 in `../KANBAN.md`
Depends on: none. This is the first card of the macOS sequence.
</model>

<role>
You are running a measurement, not a repair. Your output is an accurate record
of what each gate did on this machine. You do not fix failures, and you do not
edit repository files.
</role>

<context>
Nextra has only ever been built and gated on Windows and on Linux CI. Cards
T21–T23 add macOS as a second packaging target. Before any of that work starts,
we need to know whether the *existing, unchanged* test suite passes on
darwin-arm64.

The reason this is its own card: if `getLanIp()` in `config.js` or
`resolveLogDir()` in `lib/startupRuntime.js` misbehaves on macOS, every later
failure in T21 becomes ambiguous — packaging bug, or pre-existing portability
gap? Measuring first removes that ambiguity. That is the entire value of this
task, and it is why you must not fix anything you find.

Already established on this machine (verified, no need to re-check):

- Homebrew is installed at `/opt/homebrew/bin/brew`.
- Xcode Command Line Tools are installed at `/Library/Developer/CommandLineTools`.
  `mediasoup` compiles a native worker binary during `npm ci` and needs them.
- No Node.js is installed. No nvm, fnm, volta, or Homebrew node is present.
- Both GitHub workflows pin `node-version: '22'`. Installing a different major
  version would make this baseline disagree with CI and waste the measurement.

**One `npm test` failure is expected and is not a macOS problem.**
`tests/releaseWorkflow.test.js`, in the test named *"release compliance files are
trackable and required package inputs"*, asserts at line 83 that `.gitignore`
contains the literal line `!implementation/archive/**/*.md`. That line is not in
`.gitignore` — commit `403bb09` pruned `implementation/archive/` and its ignore
rule but left the assertion behind. This was found by reading the two files, not
by running the suite, so treat it as expected-but-unconfirmed: if it fails,
report it as pre-existing and do not fix it. If it *passes*, say so — that means
the reading was wrong and is worth knowing. Every other failure is in scope for
the escalation rule below.
</context>

<files>
Read: `package.json` — the `scripts` block defines every gate name used below.
Read: `../../AGENTS.md` — verification and reporting rules.

Do not edit any file in this repository. This card changes no source. If you
believe a file must change, that is an escalation.
</files>

<task>
Install Node.js 22, install dependencies, and run each release gate
individually, recording the real result of every one. Produce a record that
says, gate by gate, whether Nextra's existing test suite passes on macOS.
</task>

<steps>
Order matters throughout — each step depends on the previous one succeeding.

1. Confirm Node 22 is absent: `node -v` in a login shell. If Node 22 is already
   present, skip to step 3.
2. Ask the user for explicit go-ahead before installing, then run
   `brew install node@22`. Installing a toolchain modifies their machine, so it
   is theirs to approve. Follow Homebrew's post-install instructions to put
   `node@22` on `PATH` — it is keg-only and is not linked automatically.
   Confirm with `node -v` (expect `v22.x`) and `npm -v`.
3. Run `npm ci` from the repository root. This compiles the mediasoup worker
   and is the step most likely to fail on a fresh macOS toolchain.
4. Run each gate below **separately**, in this order, recording each result
   before starting the next.

   Do not run `npm run release:prep` for this. It chains its gates with `&&`,
   so it stops at the first failure and tells you nothing about the ones after
   it. A baseline needs all eight results, including the ones that follow a
   failure.

   - `npm run lint`
   - `npm run typecheck`
   - `npm test`
   - `npm run test:coverage`
   - `npm run build`
   - `npm run evaluate:packaging`
   - `npm run oss:check`
   - `npm run audit:prod`
5. Confirm the working tree is still clean: `git status --porcelain` must print
   nothing. A gate that modified a tracked file is an escalation.
</steps>

<constraints>
- Do not fix, patch, work around, or retry-with-changes any failure. Record it
  and move to the next gate.
- Do not edit any repository file, including `../KANBAN.md`. The controller
  moves cards.
- Do not install any package other than `node@22`.
- Quote failing output verbatim in your report. Do not paraphrase an error, and
  do not summarize a stack trace.
- Report only results from commands you ran in this session. Never infer that a
  gate passed because a related one did.
</constraints>

<acceptance_criteria>
- `node -v` reports a 22.x version.
- `npm ci` completed and `node_modules/mediasoup` exists.
- All eight gates above have been run individually and each has a recorded
  pass or fail.
- `git status --porcelain` prints nothing.
- No repository file was modified.
</acceptance_criteria>

<verification>
Run from the repository root, in order. Expected result follows each.

    node -v                  # v22.x
    npm -v                   # prints a version
    npm ci                   # exits 0; builds the mediasoup worker
    npm run lint             # record pass/fail
    npm run typecheck        # record pass/fail
    npm test                 # record pass/fail and the test count
    npm run test:coverage    # record pass/fail
    npm run build            # record pass/fail
    npm run evaluate:packaging   # record pass/fail; prints a JSON report
    npm run oss:check        # record pass/fail
    npm run audit:prod       # record pass/fail
    git status --porcelain   # prints nothing
</verification>

<escalate_if>
- `npm ci` fails to build the mediasoup native worker. Escalate to
  `claude-opus-5` with the full compiler output — this decides whether macOS
  packaging is viable at all, and it is the one failure that can stop T21–T23.
- Any of the eight gates fails. Escalate to `claude-opus-5` with the verbatim
  output. Classifying a darwin failure as a portability defect to fix versus a
  Windows-only assumption that is correct to leave alone is a judgment call this
  task deliberately does not make.
- `git status --porcelain` prints anything.
- The user declines the Node installation, or wants a version manager (nvm,
  fnm, volta) instead of Homebrew. Stop and report; do not choose for them.
</escalate_if>

<report_format>
Return exactly this, nothing else:

**Outcome:** done | blocked | escalated
**Changed:** none (this card changes no files — say so explicitly)
**Node:** the `node -v` and `npm -v` output
**Gates:** all eight, one per line, each `pass` or `fail`. For every failure,
quote the output verbatim beneath its line.
**Tree clean:** yes | no
**Blocker:** what stopped it, or "none"
**Next:** T21 if every gate passed; otherwise name the failing gates and hand
them to `claude-opus-5` for classification.
</report_format>
