# Executor task prompts

This directory contains one self-contained prompt per current Ready card. An
executor receives exactly one task file; it does not need conversation history,
an audit transcript, a template, or instructions from another task. Start a new
prompt from `TEMPLATE.md`.

## Routing

No cards are ready.

| Task | Model | Effort | Change type | Escalates when |
| --- | --- | --- | --- | --- |

## Execution contract

1. Read only the assigned prompt, then the source files listed in its `<files>`
   block.
2. Inspect current code before editing and stay inside the prompt's file scope.
3. Follow ordered red-test steps exactly for behavior-fix cards.
4. For a tests-only card, stop and report if an expectation fails; do not change
   production source or relax the assertion.
5. Run every command in `<verification>` in order. Report only checks actually
   run in the current session.
6. Return the prompt's `<report_format>` and stop. Do not start another task or
   edit `../KANBAN.md`.

The prompts deliberately use separate test files and non-overlapping production
ownership, so they may be assigned independently.
