#!/bin/bash
# Installs what .claude/hooks/check.sh needs, so every Claude web session can
# run the full checks. Runs only in Claude web (cloud) sessions.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"

# REPO-SPECIFIC: install dependencies and start services the checks need.
# nextra has no database. The checks need the npm packages (mediasoup builds or
# fetches its worker on install), Playwright's Chromium with its system
# libraries, and ffmpeg for the relay tests.
# --no-save: install from package-lock.json without rewriting it.
npm install --no-save --no-audit --no-fund
if ! command -v ffmpeg >/dev/null 2>&1; then
  apt-get -o DPkg::Lock::Timeout=600 update -qq
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y -qq ffmpeg >/dev/null
fi
npx playwright install --with-deps chromium
