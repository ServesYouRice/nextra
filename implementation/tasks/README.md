# Task files

One file per Ready card in `../KANBAN.md`. A task file is a **complete prompt**:
the executor that runs it has no memory of the conversation that produced it, so
each file carries its own context, file paths, constraints, verification
commands, and report format. Nothing is inherited.

Written against Anthropic's prompting best practices
(`platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices`):
explicit over implicit, motivation stated alongside every constraint, XML tags
separating instruction from context, numbered steps only where order is
load-bearing, and exact commands rather than described ones.

## Roles

**Controller** — Claude Opus 5. Owns `../KANBAN.md` and this directory. Writes
task files, dispatches them, reviews returned reports, moves cards. No executor
edits the board.

**Executor** — the model named in the task file's `<model>` block. Reads
`../../AGENTS.md`, then its own task file, then only the source files that file
names. It does not read other task files, and it does not pick up the next card
on its own.

## Routing

No Ready cards, so no task files. Only this contract and `TEMPLATE.md` remain.

T20–T23 completed on 2026-08-07 and their task files were removed with the
board's usual rule: a spent prompt is not a record. Their outcomes live in the
Done cards in `../KANBAN.md`, and the files themselves are retrievable from git
history at commit `db28627`.

The two open cards have no task file and should not get one yet. T24 (macOS
media-key fallback) needs a user decision about prompting for macOS
Accessibility permission before it can be specified, and an unspecifiable task
must not be dispatched. T17 (real-network NAT/TURN validation) is blocked on an
environment no repository change can supply.

When a card next becomes Ready, add its row here:

| Task | File | Model | Effort | Escalates to |
| --- | --- | --- | --- | --- |

`claude-haiku-4-5` does not accept the `effort` parameter — sending one errors.
Leave it unset for any task routed there.

## Which tier gets a task

The question is not how large the task is. It is **how much of the task is
already decided** by the time the file is written.

**Haiku 4.5** — every decision is made. The task runs named commands, records
output verbatim, and reports. Getting it wrong looks like a transcription error,
not a design error. T20 is this: install a toolchain, run a gate, write down
what happened.

**Sonnet 5** — the decisions are made but the work is substantial: translating
a known artifact to another form, editing config against a stated shape,
applying an enumerated checklist. There is judgment in the execution, none in
the specification. T22 (PowerShell → Node, assertion list supplied) and T23
(CI jobs and docs against a stated shape) are this.

**Opus 5 or Codex** — a decision inside the task is genuinely open, and getting
it wrong is expensive or hard to detect. Security boundaries, ordering that
determines whether a failure leaves a bad artifact behind, and anything that
changes a currently-passing gate. T21 is this: it verifies a downloaded archive
before extracting it, and it must not regress a Windows build no one will run
locally.

When a card spans tiers, it stays one task file at the higher tier. Splitting a
tightly coupled card across two executors costs more in re-briefing than the
cheaper tier saves — and `../../AGENTS.md` forbids it.

## Executing a task

1. Read `../../AGENTS.md` in full. Product boundaries there override anything a
   task file implies.
2. Read the assigned task file. Read only the source files it names.
3. Move the card to **In progress** — ask the controller to do it; do not edit
   the board.
4. Inspect the current code before editing. If the card is already satisfied,
   prove it with its own checks and say so instead of rewriting it.
5. Run the verification commands exactly as written.
6. Return the `<report_format>` block. Nothing else.

## Escalating

Stop and hand back — do not improvise — when any of these is true:

- a `<escalate_if>` condition in the task file fires;
- a verification command fails for a reason the task file does not cover;
- completing the task appears to require changing a file it does not name;
- completing the task appears to require a product-boundary change (a new
  dependency, a new supported platform, persistence, accounts).

An escalation report is a successful outcome. A task completed by working
around its constraints is not.
