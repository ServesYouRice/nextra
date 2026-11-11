#!/bin/bash
# Runs every check for this repo. On success it records the exact code that
# passed, which unlocks `git push` and pull requests (see require-checks.sh).
# Shared template from ServesYouRice/handbook (templates/claude-cloud).
# Only the run_checks function is repo-specific.
set -uo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

run_checks() {
  # REPO-SPECIFIC: the CI's verify and browser-media jobs.
  # release:prep = lint, typecheck, unit/integration tests, coverage gate,
  # build, packaging evaluation, open-source preflight and production audit.
  # Left out, because they cannot run in a Linux container: the Windows and
  # macOS packaged executables (`npm run package:artifact`, which only builds
  # for win32/darwin) and their smoke test (scripts/smoke-packaged.js).
  npm run release:prep && npm run test:e2e
}

# Hash of the working tree as it would be committed (tracked + new, not ignored).
tree_now() {
  local idx; idx=$(mktemp)
  cp "$(git rev-parse --git-dir)/index" "$idx" 2>/dev/null || rm -f "$idx"
  GIT_INDEX_FILE="$idx" git add -A >/dev/null 2>&1
  GIT_INDEX_FILE="$idx" git write-tree
  rm -f "$idx"
}

before=$(tree_now)
if ! run_checks; then
  echo "CHECKS FAILED" >&2
  exit 1
fi
after=$(tree_now)
if [ "$before" != "$after" ]; then
  echo "Checks passed but changed files (formatter or generated output)." >&2
  echo "Review the changes and run this script again." >&2
  exit 1
fi
echo "$after" > "$(git rev-parse --git-dir)/claude-checks-passed"
echo "ALL CHECKS PASSED (recorded for tree $after)"
