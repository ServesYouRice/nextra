# Consolidated production audit

This folder is the canonical merged audit for Nextra. It combines the original
Codex audit with a source-level validation of every finding in `audits-fable`.
The source tree has not changed between the audited revision (`500e04b`) and the
current revision (`d359725`); only audit documents were added.

Start here:

1. [`consolidated-findings.md`](./consolidated-findings.md) is the deduplicated
   register and priority order.
2. [`fable-triage.md`](./fable-triage.md) records whether each Fable finding is
   confirmed, reclassified, conditional, or not actionable.
3. [`verification-log.md`](./verification-log.md) records the commands and
   limitations behind the reconciliation.
4. [`production-readiness.md`](./production-readiness.md) and the category
   reports remain detailed source appendices. Where they conflict with the
   three files above, the merged register wins.
5. [`../implementation/README.md`](../implementation/README.md) turns the
   actionable register into bounded implementation packets suitable for lower
   capability models.

## Current verdict

Not releasable. Seven release conditions remain:

1. Repair and review the invalid lockfile, then recreate the dependency tree.
2. Make `release:prep` independent of an ignored, pre-existing `dist/`.
3. Fix delayed public browser-relay joins and prove decoded playback.
4. Enforce an operator boundary for public room creation and bound public WHIP.
5. Replace impossible restart-continuity behavior with a tested terminal/new-room flow.
6. Make readiness match the declared deployment profile.
7. Complete the exact-artifact signing, legal, target-host, churn, topology,
   browser, and accessibility evidence required by the supported release scope.

The first six are repository work. The seventh includes external work that no
local code change can close.
