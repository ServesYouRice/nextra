# Implementation

This folder is the only active remediation plan. `KANBAN.md` is the status source;
each `Txx-*.md` file is one executable card. Historical audits and superseded
plans are archived under `../archive/2026-07-26-audit-consolidation/`.

## Low-cost model dispatch

Assign one card per session. Use this prompt, replacing `Txx`:

```xml
<role>You are maintaining Nextra, a single-node real-time media app.</role>
<task>Implement card Txx end to end.</task>
<instructions>
Read AGENTS.md, implementation/KANBAN.md, the Txx card, and only the source files
the card names. Move the card to In progress. Inspect current behavior, add a
focused regression where practical, implement the smallest complete fix, run the
listed checks, and update the board. Act when evidence is sufficient; do not
survey unrelated options or refactor adjacent code.
</instructions>
<output>
Lead with the outcome. Then list changed files, exact check results, and one
blocker or next card. Never claim an unrun check passed.
</output>
```

If the card reaches a listed stop condition, move it to **Blocked**, add the
smallest concrete question under **User needs to decide / provide**, and stop.
Do not guess policy, credentials, hardware results, or external approvals.

## Card format

Every `Txx-*.md` file uses the same shape, so an executor always knows where to
look. Keep new cards identical:

```
# Txx — Title
Depends on ...        one line; decisions inherited through another card included
Findings: CF-nn, ...  IDs in ../archive/2026-07-26-audit-consolidation/audits-codex/consolidated-findings.md
<goal>      one or two sentences: the end state
<read>      the only files to open
<contract>  optional: the state/event table the change must satisfy
<do>        numbered or lettered steps
<accept>    observable outcomes
<checks>    exact commands to run
<stop>      when to stop and mark Blocked instead of guessing
<parked>    optional: out of scope without a new user card
```

The `Findings` IDs are traceability only. Read the archived register when a card
seems ambiguous; never treat it as extra scope.

## Board rules

- A card appears in exactly one status section.
- Keep at most one card **In progress** per executor.
- Status entries are one line; detail belongs in the task card or code/tests.
- **Done** means its acceptance checks passed. A partial fix stays **Blocked**.
- Work in ID order unless the board explicitly promotes another card.

## Design basis

The workflow uses direct objectives, explicit outputs, progressive disclosure,
and evidence-grounded progress. Multiple agents are reserved for independent
cards; a lower-cost executor may consult a stronger advisor for a hard decision,
but the executor still owns implementation and verification.

References:

- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models
- https://claude.com/blog/the-advisor-strategy
- https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration
