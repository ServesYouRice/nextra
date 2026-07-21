# audits-fable

Production-readiness audit of Nextra, performed 2026-07-21 on `main` @ `500e04b`. Audit only — no application code was changed.

**Headline:** the codebase itself is in strong shape (prior remediation shows), but the delivery pipeline is broken on `main`: the committed `package-lock.json` is corrupted JSON (`npm ci` fails → all CI + release workflows red), `npm run lint` fails with 6 errors, and one integration test can never pass from a clean checkout because `release:prep` runs tests before the build it depends on. All three were reproduced and verified in this audit.

| File | Contents |
|---|---|
| [audit-plan.md](./audit-plan.md) | Stack, user flows, method, verification performed |
| [logical-issues.md](./logical-issues.md) | 15 findings incl. **Production Blockers** section |
| [ui-issues.md](./ui-issues.md) | 12 findings + Recommended UI Priorities Before Production |
| [security-issues.md](./security-issues.md) | 9 items (mostly refinements; posture is strong) |
| [performance-issues.md](./performance-issues.md) | 8 items incl. memory-ceiling arithmetic |
| [testing-gaps.md](./testing-gaps.md) | 7 items; CI-red root causes and coverage gaps |
| [production-readiness.md](./production-readiness.md) | Go/no-go verdict, deployment risks, single ordered fix list |
| [nice-to-haves.md](./nice-to-haves.md) | High-impact / polish / DX / architecture / roadmap |

Start with `production-readiness.md` for the ordered plan; blockers are items 1–5 there.
