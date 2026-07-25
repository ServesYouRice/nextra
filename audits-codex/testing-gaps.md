# Testing and Quality-Gate Gaps

## Verification performed during this audit

| Check | Result | Important limitation |
| --- | --- | --- |
| `npm run lint` | Pass | No JSX accessibility plugin is configured |
| `npm run typecheck` | Pass | The check-JS project covers lifecycle files, not the whole application |
| `npm test` | 141 tests pass | Uses an invalid/stale local dependency tree and an existing ignored `dist/` |
| `npm run test:coverage` | Pass: 76.83% lines, 65.57% branches, 81.61% functions | Gate includes only four selected files |
| Production build to `C:\tmp\nextra-audit-dist` | Pass | Built from the existing local dependency tree |
| `npm run oss:check` | Pass | Pattern/file check, not a dependency-license legal approval |
| `npm run evaluate:packaging` | Fail | Invalid `package-lock.json` |
| `npm run audit:prod` | Fail | npm cannot load a valid lockfile |
| `npm --prefix poc-mediasoup audit --omit=dev` | Pass, 0 vulnerabilities | Covers only the POC subproject |
| In-app rendered browser review | Unavailable | No browser backend was available; no visual claim is made |

## T-1 - The committed lockfile makes every clean quality gate fail at install time

- **Severity:** High
- **Location:** `package-lock.json:2402-2406`; `.github/workflows/ci.yml:18,29,41`; `.github/workflows/release.yml:23`
- **Description:** `package-lock.json` is invalid JSON. All CI jobs and tagged releases begin with `npm ci`, so none can reach lint, tests, packaging, or signing.
- **Why it matters for production:** A release cannot be reproduced or shipped from the committed revision, and production vulnerability auditing is unavailable.
- **Recommended fix:** Regenerate and review the lockfile in a clean environment, run `npm ci` on Linux and Windows, and make successful clean install a required branch check before merge.
- **Blocker before production:** Yes.
- **Related risks/dependencies:** S-8, local dependency mismatch in T-3, SBOM/signing chain.

## T-2 - `release:prep` runs the server integration test before creating `dist`

- **Severity:** High
- **Location:** `package.json:37`; `tests/serverIntegration.test.js:216-219`; `server.js:980-1063`
- **Description:** The release command runs `npm test` before `npm run build`. `dist/` is ignored and absent from a clean checkout. The integration test expects an SPA request to return 200 and `<div id="root">`, while the server returns a build-required 503 when `dist/index.html` is absent.
- **Why it matters for production:** After T-1 is fixed, clean CI/release preparation will still fail. Local tests pass only because this workspace already contains an old ignored build.
- **Recommended fix:** Build before integration tests that require the client, or make that test build/serve an isolated temporary output. Add an explicit test that production startup without `dist` is not ready and returns the build-required page.
- **Blocker before production:** Yes.
- **Related risks/dependencies:** L-7 readiness semantics, stale-build false confidence.

## T-3 - Local passing tests do not exercise the declared dependency graph

- **Severity:** High
- **Location:** `package.json:43`; local `node_modules`; corrupt `package-lock.json`
- **Description:** `npm ls mediasoup --depth=0` reports `mediasoup@3.19.17 invalid: "^3.21.0"`. The build reported Vite 7.3.2 while the manifest minimum is 7.3.1 and no valid lock determines the shipping version.
- **Why it matters for production:** Native mediasoup behavior, Engine.IO buffer shape, and packaging can change across versions. A green local test run cannot certify the version a repaired clean install will select.
- **Recommended fix:** After regenerating the lock, delete/recreate dependencies with `npm ci` on supported Node 20, rerun every test and packaging gate, and record exact versions in the release SBOM.
- **Blocker before production:** Yes.
- **Related risks/dependencies:** Native worker binaries, relay backpressure compatibility, signed artifact reproducibility.

## T-4 - No test covers the late-joining public browser relay contract

- **Severity:** High
- **Location:** `tests/browser/media-flow.spec.mjs`; relay logic in `src/HostView.jsx` and `src/WatchView.jsx`
- **Description:** Browser E2E covers direct WebRTC only. It does not simulate a tunnel origin without TURN, allow host prewarm to run, then join a relay viewer and wait for decoded frames. That exact omission leaves L-1 undetected.
- **Why it matters for production:** The default packaged public-sharing route can break while all 141 tests and current Playwright scenarios pass.
- **Recommended fix:** Add a deterministic E2E test with relay-first conditions, a delayed viewer, fresh-generation assertion, decoded video frames, bounded queue, and cleanup to zero rooms/listeners.
- **Blocker before production:** Yes.
- **Related risks/dependencies:** L-1, MediaRecorder support in CI Chromium, tunnel-origin injection fixture.

## T-5 - Browser coverage is narrow relative to the product surface

- **Severity:** Medium
- **Location:** `playwright.config.mjs:17-25`; three tests in `tests/browser/media-flow.spec.mjs`
- **Description:** Only Desktop Chromium browser capture/direct WebRTC is tested. Protected rooms, relay, OBS auto-config, H.264 fallback, AV1, WHEP, status/error states, public origin behavior, mobile layouts, Firefox, and WebKit are absent.
- **Why it matters for production:** Most compatibility and failure claims are unverified in the browser layer where media APIs differ most.
- **Recommended fix:** Add a risk-based matrix: core join/host lifecycle on Chromium/Firefox/WebKit; mobile layout/accessibility routes; protocol fixtures for OBS/WHEP; and real external topology runs outside PR CI.
- **Blocker before production:** The declared supported matrix must be tested or narrowed.
- **Related risks/dependencies:** U-12, AV1 capability, system-audio limitations.

## T-6 - Coverage thresholds apply to only four files

- **Severity:** Medium
- **Location:** `package.json:29`
- **Description:** The coverage command includes `roomMediaPipeline`, `lifecycleController`, `mediasoupClient`, and `fmp4RelayPlayer`. It excludes the large HostView, WatchView, socket handlers, server trust/auth code, room admission, WHIP/WHEP routes, tunnel supervision, and packaging scripts.
- **Why it matters for production:** The reported 76.83% line coverage can be mistaken for project-wide coverage despite excluding most risk-bearing code.
- **Recommended fix:** Rename the metric as targeted critical-module coverage immediately, then expand instrumentation in stages. Set per-domain thresholds only after deterministic tests exist; do not lower current focused thresholds to inflate a global number.
- **Blocker before production:** No, but coverage claims must be accurate.
- **Related risks/dependencies:** L-10, protocol/module extraction.

## T-7 - Accessibility and responsive behavior have no automated or retained manual evidence

- **Severity:** Medium
- **Location:** UI test configuration and `REMAINING-WORK.md`
- **Description:** No automated accessibility scanner, keyboard script, responsive screenshot set, contrast output, or screen-reader checklist is part of CI/release evidence.
- **Why it matters for production:** Primary-flow issues such as U-4 are not detected, and CSS breakpoints cannot prove usable 320 px/mobile behavior.
- **Recommended fix:** Add accessibility tests for each route/state, representative viewport screenshots/layout assertions, and a manual NVDA/VoiceOver + keyboard release checklist.
- **Blocker before production:** Yes for a WCAG/accessibility claim.
- **Related risks/dependencies:** U-4/U-5/U-8/U-12.

## T-8 - Packaged smoke tests do not exercise media-worker restart or live media

- **Severity:** Medium
- **Location:** `scripts/smoke-packaged.ps1`; `tests/workerProcessRecovery.test.js`
- **Description:** Source tests kill and replace a real mediasoup subprocess. The packaged smoke checks readiness, static shell, Socket.IO handshake, compliance artifacts, and shutdown, but never kills the packaged worker or decodes a frame.
- **Why it matters for production:** Relaunch arguments, caxa extraction paths, native worker binaries, and child cleanup differ in the executable. Source recovery does not prove packaged recovery.
- **Recommended fix:** Extend Windows CI with a packaged-only recovery test endpoint, verify the replacement executable becomes ready, verify the old process/children exit, and run one short decoded-frame host/viewer test against the packaged artifact.
- **Blocker before production:** Required before claiming packaged automatic recovery; otherwise document the narrower smoke scope.
- **Related risks/dependencies:** L-2, caxa packaging, Authenticode exact-artifact testing.

## T-9 - External production evidence remains intentionally open

- **Severity:** High
- **Location:** `REMAINING-WORK.md:12-113`; `docs/performance-benchmark.md`; `docs/churn-suite.md`
- **Description:** Signing/clean-machine validation, legal approval, target-host capacity, long live-media churn, and the external network/OBS/TURN matrix have not been completed.
- **Why it matters for production:** Deterministic local tests cannot prove GPU/driver stability, real strict-NAT traversal, public announced-address correctness, tunnel fallback, signed reputation, or legal distribution readiness.
- **Recommended fix:** Execute the documented procedures, retain artifacts/results with host and version inventory, assign named owners, and require sign-off in the release checklist.
- **Blocker before production:** Yes for a public production release.
- **Related risks/dependencies:** D-2/D-3, capacity limits, provider credentials.

## T-10 - Browser CI uses a different setup-node action revision

- **Severity:** Low
- **Location:** `.github/workflows/ci.yml:15-16`, `.github/workflows/ci.yml:25-27`, `.github/workflows/ci.yml:38-39`
- **Description:** Verify and Windows jobs use the pinned setup-node v6 commit; browser-media uses a pinned v4 commit.
- **Why it matters for production:** Different cache/runtime setup behavior complicates CI diagnosis and leaves one job on a separately maintained action baseline without a documented reason.
- **Recommended fix:** Align the action commit across jobs or comment the compatibility reason and add a dependency-update owner.
- **Blocker before production:** No.
- **Related risks/dependencies:** Lockfile/cache behavior, Dependabot action updates.
