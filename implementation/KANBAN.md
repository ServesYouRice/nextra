# Implementation task queue

Updated: 2026-10-05.

This file contains only work that is ready to delegate. Historical cards,
completed work, deferred ideas, and audit transcripts are intentionally absent.
Each card has one self-contained executor prompt under `tasks/`; that prompt is
the implementation contract.

## Executor rules

- Work only on the task explicitly assigned to you. Do not select another card.
- Read the assigned task file, then only the repository files it names.
- Stay within its file scope and escalation conditions.
- Do not edit this queue or another task prompt.
- Run the task's checks in the stated order and return its exact report format.
- A behavior-fix card's named regressions must fail before production source is
  edited. Every other card is assertion-only; an unexpected failure is a finding
  to report, not an expectation to weaken.

## Ready

No cards are ready.

| Card | Goal | Change type | Owned implementation files | Prompt |
| --- | --- | --- | --- | --- |
