#!/bin/bash
# Check 12 (lane scripts): the Playwright runs, while this lane holds
# C:\Users\V\nextra-lanes\.playwright-lock. Always stops the server and
# removes the lock at the end, also on failure.
set -u
LANE=/c/Users/V/nextra-lanes/scripts
S=/c/Users/V/AppData/Local/Temp/claude/c--Users-V-arbitra/53025464-426b-4472-9c62-52c45e3849f5/scratchpad
LOCK=/c/Users/V/nextra-lanes/.playwright-lock
PW="node $LANE/node_modules/@playwright/test/cli.js"
CFG=$S/scripts-check12.config.mjs
ORIG=$LANE/playwright-report/check12-orig
STALE=0000000000001-9998-00000001-0001.ticket
SUMMARY=$S/scripts-check12-pw-summary.txt
cd "$LANE" || exit 2

port_pid() { netstat -ano | grep -E "127\.0\.0\.1:3210 .*LISTENING|0\.0\.0\.0:3210 .*LISTENING" | awk '{print $NF}' | head -1; }
say() { echo "[$(date +%T)] $*" | tee -a "$SUMMARY"; }

cleanup() {
    if [ "${SERVER_STARTED:-0}" = 1 ]; then
        curl -sk -X POST https://127.0.0.1:3210/api/test/shutdown > /dev/null 2>&1
        for _ in 1 2 3 4 5 6 7 8 9 10; do [ -z "$(port_pid)" ] && break; sleep 1; done
        pid=$(port_pid)
        if [ -n "$pid" ]; then taskkill //PID "$pid" //F > /dev/null 2>&1; fi
    fi
    rm -rf "$LOCK"
    say "cleanup done; port 3210 listener: '$(port_pid)'; lock removed"
}
trap cleanup EXIT

: > "$SUMMARY"
if [ "$(cat "$LOCK/scripts" 2>/dev/null)" != "scripts-check-12" ]; then echo "lock not held by this lane"; trap - EXIT; exit 2; fi
if [ -n "$(port_pid)" ]; then say "port 3210 already in use; stopping"; exit 2; fi

# Run 1: the spec as it was (ac1c688 = dev 1be0088), a holder ticket that
# releases when the first test ends, 4 s test timeout, no server needed.
rm -rf "$LANE/test-results"; rm -f "$S/scripts-check12-pw-before.log"
CHECK12_TEST_DIR=$ORIG CHECK12_TIMEOUT_MS=4000 CHECK12_BLOCKER=1 \
CHECK12_LOCK_DIR=$LANE/test-results/.media-flow-lock CHECK12_LOG=$S/scripts-check12-pw-before.log \
    $PW test -c "$CFG" > "$S/scripts-check12-pw-before.txt" 2>&1
say "run 1 (original spec, holder releases after test 1) exit $?"

# Run 4a: outputDir moved elsewhere; a stale ticket from a killed earlier run
# in <cwd>/test-results and one in the new outputDir.
rm -rf "$LANE/test-results" "$S/scripts-check12-out"; rm -f "$S/scripts-check12-pw-outdir-before.log"
mkdir -p "$LANE/test-results/.media-flow-lock" "$S/scripts-check12-out/.media-flow-lock"
touch "$LANE/test-results/.media-flow-lock/$STALE" "$S/scripts-check12-out/.media-flow-lock/$STALE"
CHECK12_TEST_DIR=$ORIG CHECK12_OUTPUT_DIR=$S/scripts-check12-out CHECK12_TIMEOUT_MS=4000 \
CHECK12_LOCK_DIR=$S/scripts-check12-out/.media-flow-lock CHECK12_STALE_DIR=$LANE/test-results/.media-flow-lock \
CHECK12_LOG=$S/scripts-check12-pw-outdir-before.log \
    $PW test -c "$CFG" --grep "Host preflight" > "$S/scripts-check12-pw-outdir-before.txt" 2>&1
say "run 4a (original spec, other outputDir, stale tickets) exit $?"
rm -rf "$LANE/test-results" "$S/scripts-check12-out"

# Server on 3210 with the scratch build, as playwright.config.mjs's webServer
# would start it (without building into the shared dist).
mkdir -p "$S/scripts-check12-logs"
NODE_ENV=test PORT=3210 BIND_HOST=127.0.0.1 LOCAL_HTTPS=true OPEN_BROWSER=false AUTO_PUBLIC_TUNNEL=false \
SHARE_BASE_URL=https://nextra.cloudflare.test:3210 WHIP_ENABLED=false WHEP_ENABLED=false \
RTC_LISTEN_IP=127.0.0.1 RTC_MIN_PORT=42100 RTC_MAX_PORT=42199 \
NEXTRA_SMOKE_TEST=1 NEXTRA_TEST_DIST_DIR="$S/scripts-check12-dist" HTTPS_CERT_DIR="$S/scripts-check12-certs" \
NEXTRA_LOG_DIR="$S/scripts-check12-logs" \
    node server.js > "$S/scripts-check12-server.log" 2>&1 &
SERVER_STARTED=1
for _ in $(seq 1 60); do curl -sk https://127.0.0.1:3210/readyz | grep -q '"ready"' && break; sleep 1; done
say "server readyz: $(curl -sk https://127.0.0.1:3210/readyz | head -c 120)"
# Never let playwright.config.mjs start its own web server (it builds into the shared dist).
if ! curl -sk https://127.0.0.1:3210/readyz | grep -q '"ready"'; then say "server not ready; stopping"; exit 2; fi

# Run 3: the real playwright.config.mjs (it reuses the server above), fixed spec.
$PW test tests/browser/media-flow.spec.mjs > "$S/scripts-check12-pw-real-config.txt" 2>&1
say "run 3 (playwright.config.mjs, fixed spec) exit $?"

# Run 2: fixed spec, the same holder scenario as run 1, with the server and
# the config's 60 s timeout so that the later tests can pass.
rm -rf "$LANE/test-results"; rm -f "$S/scripts-check12-pw-after.log"
CHECK12_TIMEOUT_MS=60000 CHECK12_BLOCKER=1 \
CHECK12_LOCK_DIR=$LANE/test-results/.media-flow-lock CHECK12_LOG=$S/scripts-check12-pw-after.log \
    $PW test -c "$CFG" > "$S/scripts-check12-pw-after.txt" 2>&1
say "run 2 (fixed spec, holder releases after test 1) exit $?"

# Run 4b: fixed spec, the same outputDir scenario as run 4a.
rm -rf "$LANE/test-results" "$S/scripts-check12-out"; rm -f "$S/scripts-check12-pw-outdir-after.log"
mkdir -p "$LANE/test-results/.media-flow-lock" "$S/scripts-check12-out/.media-flow-lock"
touch "$LANE/test-results/.media-flow-lock/$STALE" "$S/scripts-check12-out/.media-flow-lock/$STALE"
CHECK12_OUTPUT_DIR=$S/scripts-check12-out CHECK12_TIMEOUT_MS=60000 \
CHECK12_LOCK_DIR=$S/scripts-check12-out/.media-flow-lock CHECK12_STALE_DIR=$LANE/test-results/.media-flow-lock \
CHECK12_LOG=$S/scripts-check12-pw-outdir-after.log \
    $PW test -c "$CFG" --grep "Host preflight" > "$S/scripts-check12-pw-outdir-after.txt" 2>&1
say "run 4b (fixed spec, other outputDir, stale tickets) exit $?"
rm -rf "$LANE/test-results" "$S/scripts-check12-out"
