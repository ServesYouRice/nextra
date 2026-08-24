# Executor task prompts

This directory contains one self-contained prompt per current Ready card. An
executor receives exactly one task file; it does not need conversation history,
an audit transcript, a template, or instructions from another task.

## Routing

| Task | Model | Effort | Change type | Escalates when |
| --- | --- | --- | --- | --- |
| `T27.md` | `claude-sonnet-5` | `high` | Behavior fix | Either TLS regression is not red, or the key-pair oracle differs |
| `T28.md` | `claude-sonnet-5` | `low` | Tests only | An asserted encoder branch differs |
| `T29.md` | `claude-sonnet-5` | `high` | Behavior fix | Either parser regression is not red, or another parser defect appears |
| `T30.md` | `claude-sonnet-5` | `medium` | Tests only | Muxer framing differs or timestamp wraparound needs a product decision |
| `T31.md` | `claude-sonnet-5` | `medium` | Tests only | Fallback transport state or ordering differs |
| `T32.md` | `claude-sonnet-5` | `medium` | Tests only | The UI strands, the browser is unavailable, or the check is flaky |
| `T36.md` | `claude-sonnet-5` | `medium` | Tests only | The native boundary cannot be restored or shared-server behavior differs |
| `T37.md` | `claude-sonnet-5` | `medium` | Tests only | Admission behavior differs or a rejection allocates media |
| `T38.md` | `claude-sonnet-5` | `medium` | Tests only | Limit classification or reservation cleanup differs |
| `T39.md` | `claude-sonnet-5` | `high` | Tests only | Any allocation stage leaks resources or returns a different contract |
| `T40.md` | `claude-sonnet-5` | `high` | Tests only | A first-signal timer or terminal-event lifecycle differs |
| `T41.md` | `claude-sonnet-5` | `low` | Tests only | DELETE or PATCH behavior differs |
| `T42.md` | `claude-sonnet-5` | `medium` | Behavior fix | Either repeated-ICE timer regression is not red before the fix |

## Execution contract

1. Read only the assigned prompt, then the source files listed in its `<files>`
   block.
2. Inspect current code before editing and stay inside the prompt's file scope.
3. Follow ordered red-test steps exactly for T27, T29, and T42.
4. For a tests-only card, stop and report if an expectation fails; do not change
   production source or relax the assertion.
5. Run every command in `<verification>` in order. Report only checks actually
   run in the current session.
6. Return the prompt's `<report_format>` and stop. Do not start another task or
   edit `../KANBAN.md`.

The prompts deliberately use separate test files and non-overlapping production
ownership, so they may be assigned independently.
