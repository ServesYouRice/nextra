# Lower-model implementation program

These packets implement the actionable findings in
[`../audits-codex/consolidated-findings.md`](../audits-codex/consolidated-findings.md).
They are plans, not claims that the code has already been fixed.

Each packet is bounded for a lower-capability coding model: one ownership
boundary, named files, explicit invariants, observable acceptance criteria, and
a mandatory self-review/handoff.

Use one fresh model session per packet. Give it the packet plus
[`PROMPT-CONTRACT.md`](./PROMPT-CONTRACT.md), not both full audit folders.

## Execution order

| Wave | Packet | Findings | Gate to continue |
| --- | --- | --- | --- |
| 0 | `01-release-reproducibility.md` | CF-01 | Valid lock, clean install, real lint/test inventory |
| 1 | `02-clean-build-and-readiness.md` | CF-02, CF-06 | Clean build/test order and truthful readiness |
| 1 | `03-public-relay-generation.md` | CF-03 | Delayed relay viewer decodes frames |
| 1 | `04-operator-boundary-and-whip.md` | CF-04, CF-08, CF-09 | Unauthorized allocation denied; authorized flows pass |
| 1 | `05-restart-semantics.md` | CF-05 | Terminal/new-room recovery tests pass |
| 2 | `06-contained-backend-fixes.md` | CF-11, CF-12, CF-20 | Focused backend/security contracts pass |
| 2 | `07-media-capability-and-sync.md` | CF-13, CF-14, CF-15 | Capability tests pass; live A/V decision recorded |
| 2 | `08-ui-accessibility-and-support.md` | CF-16, CF-17, CF-18 | Semantics pass; claims match evidence |
| 3 | `09-security-and-operations.md` | CF-10, CF-21, CF-22 | Cleanup/polling tests and operator docs pass |
| 3 | `10-release-evidence.md` | CF-07, CF-19, CF-25 | Exact-artifact evidence is signed off |
| 4 | `11-maintainability-and-polish.md` | CF-23, CF-24 | Small batches; no blocker regression |

Wave 1 packets can run independently only after Wave 0 establishes the real
dependency graph. Merge them sequentially and rerun relevant earlier gates.
Packet 07 contains a human/environment decision gate and must not guess the
audio offset.

## Coordinator rules

1. Start clean or record pre-existing changes.
2. Assign exactly one packet; do not let a lower model choose adjacent work.
3. Require it to quote current code evidence before editing.
4. Require a regression to fail for the intended reason when practical.
5. Review the diff, not only green tests; reject test-only/hard-coded behavior.
6. Record commit, commands, exact results, limitations, and contract changes.

## Global stop conditions

Stop and escalate when the repaired dependencies contradict a packet; a task
needs credentials/certificates/release authority; an authorization choice
changes who may host/administer; protocol compatibility would change; real
OBS/browser/topology evidence is unavailable; or unrelated user edits overlap.
