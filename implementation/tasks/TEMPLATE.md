# T00 — <imperative title, same wording as the KANBAN card>

<model>
Model: `claude-haiku-4-5` | `claude-sonnet-5` | `claude-opus-5`
Effort: `low` | `medium` | `high` | `xhigh` — omit entirely for `claude-haiku-4-5`
Card: T00 in `../KANBAN.md`
Depends on: T00 done, or none
</model>

<role>
One or two sentences. What the executor is for this task, and the standard it is
held to. A role focuses tone and priorities; it is not a personality.
</role>

<context>
Why this task exists and what it is part of. State the motivation behind every
non-obvious constraint here rather than in `<constraints>` — a constraint whose
reason is given generalizes correctly to cases the file did not anticipate; a
bare prohibition does not.

Include facts already established that the executor cannot rediscover cheaply:
library behavior confirmed by hand, upstream asset shapes, decisions the user
already made. Say which are verified and which are assumptions.
</context>

<files>
Exact repo-relative paths, grouped by what happens to them. Never write "the
packaging script" — write `scripts/package-app.js`, with the function name and
line range where it matters.

Read: path — why
Edit: path — what changes
Do not touch: path — why it is off limits
</files>

<task>
The goal in two or three sentences. What is true when this is done that is not
true now. Not the method — that is `<steps>`.
</task>

<steps>
Numbered only when order is load-bearing; say why order matters when it does.
When the order is free, use a bulleted list instead so the executor is not
forced into a sequence that costs it efficiency.
</steps>

<constraints>
- Scope: change only what the task requires. A fix does not need surrounding
  cleanup; a one-time operation does not need a helper.
- No abstractions, error handling, or validation for cases that cannot occur.
  Validate at trust boundaries only: user input, network input, credentials,
  files, child processes, external APIs.
- Never speculate about code not opened. Read every file named above before
  making a claim about it.
- Do not weaken, skip, or delete a test to make a check pass. A test that must
  change is an escalation, not an edit.
- Match the surrounding code's naming, comments, and structure.
</constraints>

<acceptance_criteria>
Independently checkable statements, one per line. Each must be verifiable by a
command in `<verification>` or by reading a named file — not by judgment.
</acceptance_criteria>

<verification>
Exact commands, copy-pasteable, in the order they should run. State the expected
result for each. Name the smallest sufficient gate; do not invoke the full
release gate when a focused test proves the change.
</verification>

<escalate_if>
Conditions that end the task and produce an escalation report instead of a
result. Be concrete — "if something seems wrong" is not a condition.
</escalate_if>

<report_format>
Return exactly this, nothing else:

**Outcome:** done | blocked | escalated
**Changed:** file paths, or "none"
**Checks:** each command with its real result. Quote failing output verbatim.
Never report a check that was not run in this session.
**Blocker:** what stopped it, or "none"
**Next:** the card this unblocks, or what decision is needed
</report_format>
