# Packet 01 - Restore release reproducibility

Findings: CF-01 and the lint portion of Fable L-2/T-1.

## Objective

Produce a valid reviewed lockfile and recreate the exact dependency tree on the
CI Node version so later work is based on shipping dependencies. Do not fix
speculative lint/runtime issues before the clean graph exists.

## Read first

- `package.json`, corrupted `package-lock.json`
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- `scripts/evaluate-packaging.js`, `scripts/package-app.js`
- `audits-codex/verification-log.md` and lockfile sections of `testing-gaps.md`

## Invariants

- Generate with the Node/npm versions used by CI.
- Preserve declared ranges and the `minimatch` override unless proven invalid.
- Regenerate; do not hand-repair the spliced JSON as the final result.
- Do not suppress audit/lint errors or relax tests.
- Avoid unrelated dependency upgrades and application changes.

## Plan

1. Record Node/npm versions and the corrupted region.
2. Regenerate `package-lock.json` in a clean disposable checkout/environment.
3. Review the whole lock diff: unexpected majors, native mediasoup artifacts,
   integrity fields, platform packages, and removal of the interleaved object.
4. Run `npm ci` and confirm `npm ls --depth=0` has no invalid/extraneous top-level packages.
5. Run lint before editing lint findings. If the historical six errors reproduce,
   record exact versions/errors and fix minimally; otherwise close them as stale output.
6. Run all local gates and repeat clean install/gates on Windows CI.
7. Require clean install in CI. Record branch protection as an owner action;
   repository code cannot configure GitHub protection.

## Acceptance criteria

- Lockfile parses and matches the manifest.
- Fresh `npm ci` succeeds on supported Linux and Windows.
- Top-level dependency inventory is valid.
- Packaging evaluation and production audit execute meaningfully.
- Actual clean-graph lint outcome is recorded/resolved, not assumed.
- No unrelated upgrade/refactor is included.

## Verification

```text
node -e "JSON.parse(require('fs').readFileSync('package-lock.json','utf8'))"
npm ci
npm ls --depth=0
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run evaluate:packaging
npm run oss:check
npm run audit:prod
npm run test:e2e
```

## Dispatch objective

```xml
<objective>
Restore a valid reproducible dependency graph without changing application
scope. Regenerate/review package-lock.json on the CI Node version, recreate
dependencies with npm ci, and run the full gate. Fix only lint errors that
actually reproduce under that graph. Report exact versions and results.
</objective>
```

Stop for registry/platform-native failure, audit-policy decisions, or any needed
major dependency change.
