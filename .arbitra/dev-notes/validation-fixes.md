# Validation ids the prompts cite wrongly

The plan's revision step renumbered the validation assertions it added (so parallel revision calls would not
collide) but left the old numbers in the tasks' text. These prompts therefore cite VAL-145, VAL-146 or VAL-147 where
they mean their own newer assertions. Read the id on the right instead; its text is in `validation.md`.

| Task | Prompt cites | Means |
|---|---|---|
| TASK-026 | VAL-145 | VAL-147 (H.264 profile matching in both matchers) |
| TASK-033 | VAL-145 | VAL-148 (a=setup:passive offers get a=setup:active) |
| TASK-063 | VAL-145 | VAL-151 (done) |
| TASK-071 | VAL-145, VAL-146 | VAL-152 (one FIFO OBS queue), VAL-153 (stale configure stops only its own session) |
| TASK-075 | VAL-145, VAL-146, VAL-147 | VAL-161, VAL-162, VAL-163 (done) |
| TASK-079 | VAL-145, VAL-146 | VAL-154, VAL-155 (done) |
| TASK-087 | VAL-145 | VAL-156 (relay-consume-stop only for the ledger's latest claim) |
| TASK-091 | VAL-146, VAL-147 | VAL-157 (fallback stop only for the latest claim), VAL-158 (single-attempt timed ack) |
| TASK-092 | VAL-145 | VAL-159 (lock reclaim never displaces a live owner) |
| TASK-093 | VAL-145 | VAL-160 (inject exactly the missing parameter sets) |

TASK-026's VAL-035 and TASK-075's VAL-106 are real references to other assertions (VAL-106 is superseded by
VAL-161 to VAL-163).
