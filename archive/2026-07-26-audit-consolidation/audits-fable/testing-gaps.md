# Testing Gaps

State of the suite: unusually strong for a project of this size — 141 `node --test` tests across 33 files (parsers, muxers, depacketizer, rate limits, recovery decision logic, real-server integration, real worker-kill recovery, churn harness), a Playwright browser media-flow gate, and packaged smoke tests in CI. The gaps below are what the audit actually hit or what the suites structurally cannot see.

---

## T-1 · CI is red from a clean checkout — three independent causes

- **Severity:** Critical (aggregate)
- **Causes:** corrupted lockfile (L-1, kills `npm ci` in every job), lint failures (L-2), and the `serverIntegration` dist-dependency vs `release:prep` ordering (L-3).
- **Verified:** all three reproduced in this audit environment; the integration test flips to green once `npm run build` has run.
- **Why it matters:** With the gate red, *every* future regression lands silently — the entire value of the 141-test suite is currently switched off at the CI level.
- **Fix order:** L-1 → L-2 → L-3, then require green CI for merges to `main` (branch protection), since L-1 was merged while the gate was necessarily failing.
- **Blocker:** Yes.

## T-2 · Hidden environment dependency: tests that need a built `dist/`

- **Severity:** High (cause of L-3)
- **Location:** `tests/serverIntegration.test.js:217`
- **Fix:** Besides the ordering fix, make the dependency explicit — either the test creates its own `dist` fixture, or it asserts and documents the 503 path. A test that changes result based on a gitignored directory is a trap for every future contributor.

## T-3 · No test pins the audio-offset default to the A/V-sync design

- **Severity:** Medium
- **Problem:** The L-4 contradiction (config default 1500 ms vs "default 0" comments) survived precisely because no test asserts the relationship between `FALLBACK_AUDIO_OFFSET_MS`, the keyframe-anchored start, and the resulting `-itsoffset` FFmpeg argument. `tests/ffmpegRelay.test.js` covers arg-building — extend it to assert the *default* config produces `avOffset === 0` (or whatever the decided behavior is).

## T-4 · Client-side coverage is thin relative to server-side

- **Severity:** Medium
- **Covered:** `lifecycleController`, `mediasoupClient` (socketRequest), `fmp4RelayPlayer`, `connectionQuality`, `watchPlaybackMode`, `obsOutputModel`, `obsWebSocket` (incl. wire-level) — the extracted pure modules are well tested.
- **Not covered:** the two largest files in the repo — `HostView.jsx` (2,044 lines) and `WatchView.jsx` (1,437 lines) — have no component-level tests. Their state machines (reconnect → rejoin → resume-playback; fallback enter/exit; reload recovery; stop-confirm) are exactly where the audit found L-6/L-8/U-5. The Playwright suite exercises one happy-path slice.
- **Fix:** Not full component testing — extract the reconnect/resume decision logic (currently inline in `onReconnect`/`onTransportFailed`) into pure functions like the codebase already did for `watchPlaybackMode.mjs`, and unit-test the decisions. That pattern is established and cheap here.

## T-5 · Coverage gate covers only 4 files

- **Severity:** Low
- **Location:** `package.json` `test:coverage` — thresholds apply only to `roomMediaPipeline`, `lifecycleController`, `mediasoupClient`, `fmp4RelayPlayer`.
- **Problem:** The gate is honest (it doesn't pretend repo-wide coverage) but `lib/socket.js` — the highest-risk file — has no coverage floor; regressions in its 2,300 lines are invisible to the gate.
- **Fix:** Add `lib/socket.js` and `lib/rooms.js` to the coverage include list with realistic floors, or split socket.js first (see nice-to-haves) and gate the extracted modules.

## T-6 · Externally-blocked validation remains open (acknowledged, do not re-litigate)

`REMAINING-WORK.md` §2 already lists what local CI cannot prove: target-host benchmarks, 30–60 min live-media churn with real OBS/FFmpeg/GPU, public-topology matrix (TURN, strict NAT, ICE restart, real Cloudflare TURN mint, real OBS wire behavior). These remain valid release conditions; nothing in this audit found the local suites overclaiming.

## T-7 · Playwright job pins a different setup-node hash than the other jobs

- **Severity:** Informational
- **Location:** `.github/workflows/ci.yml` — `browser-media` uses `actions/setup-node@49933ea…# v4.4.0` while the other jobs use `@48b55a0…# v6.4.0`.
- **Fix:** Align intentionally (probably all on v6) so cache behavior is uniform. Not a defect.
