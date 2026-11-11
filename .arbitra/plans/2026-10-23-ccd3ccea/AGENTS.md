# Working through this plan

This folder is a plan to fix defects found in the project it sits in. It was written by arbitra, which audited the project with several models and checked each finding against the code.

How to work:

1. Read README.md for the order of work and any questions to answer first. If a question is marked as blocking, ask the person you are working with before starting the tasks it affects.
2. Take the first unticked item in PROGRESS.md and open its prompt under `prompts/`. Follow that prompt; it says what to read, what not to change, and how to check the result.
3. Do one task at a time. Prove each defect before fixing it: a test that fails on the current code for the reason the issue gives. Verify the task as its prompt says before you tick it in PROGRESS.md. If a check fails or the code does not match the prompt, stop and report instead of guessing.
4. Record each issue's result in results.json as you finish it: `fixed`, `not_reproducible`, `no_change_needed`, `blocked`, whether its test failed before the fix, the test, and the proof (the failing output, or why no test could show it).
5. Do not change anything in this folder except PROGRESS.md and results.json.

The prompt folders say which kind of model each task suits:

- `0-check-first`: your strongest model, to decide whether a reported defect the audit could not settle is real, and to fix it if it is.
- `1-strong-model`: your strongest model (such as Claude Opus), for reasoning across files, or a fix that is easy to get subtly wrong.
- `2-balanced-model`: a balanced model (such as Claude Sonnet), for a contained change with a clear target.
- `3-fast-model`: a fast, inexpensive model (such as Claude Haiku), for a small, mechanical change.

There are 105 tasks and 20 issues to check.
