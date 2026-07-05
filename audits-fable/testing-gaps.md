# Testing Gaps

Assessment of the existing test suite and the surfaces it does **not** cover. Severity here reflects *risk introduced by the absence of a test*, not a defect in the code.

## What exists (credit where due)

Tests run via `node --test` (`package.json` `"test": "node --test"`) and are wired into CI through `release:prep` (`lint && test && build && oss:check && audit:prod`, `.github/workflows/ci.yml`). There are **15 test files**, all unit-level and focused on the server media/utility libs:

| Test file | Covers |
|---|---|
| `tests/rooms.test.js` | Room create/join/reclaim/remove/destroy lifecycle, ICE refresh, cleanup. |
| `tests/config.test.js` | Env parsing, TURN config normalization, ICE server building. |
| `tests/network.test.js` | IP normalization, forwarded-header trust logic. |
| `tests/portResolver.test.js` | Free-port resolution. |
| `tests/cloudflareTurn.test.js` | Cloudflare TURN credential fetch/shape. |
| `tests/whip.test.js`, `whipRoutes.test.js` | SDP offer parse, codec validation, WHIP route behavior. |
| `tests/whep.test.js` | WHEP viewer offer/answer, capability filtering, session cleanup paths. |
| `tests/fmp4Parser.test.js`, `h264Depacketizer.test.js`, `h264Sprop.test.js` | Media byte-level parsing/depacketization. |
| `tests/ffmpegRelay.test.js` | Relay arg building / lifecycle (without spawning real FFmpeg where possible). |
| `tests/socketTransportRecovery.test.js` | `handleViewerTransportFailure` recovery branch (via `__testing` export). |
| `tests/obsOutputModel.test.js`, `watchPlaybackMode.test.js` | OBS encoder model + client playback-mode decision (`.mjs` pure logic). |

This is a **genuinely good unit foundation** for the parsing/lifecycle logic — the hardest-to-reason-about byte-level code is tested, and pure decision functions (`watchPlaybackMode`, `obsOutputModel`) were deliberately extracted into `.mjs` for testability. Credit.

---

## Gaps

### T-1 🟠 No tests for `server.js` (routing, auth gating, IP/trust derivation, startup)

- **Risk:** High
- **Location:** `server.js` (1250 lines) — 0% covered.

The most security-relevant logic is untested: `/api/config` payload (incl. the TURN-credential exposure in `security-issues.md` S-1), `/api/metrics` auth gating and sensitive-field stripping (`:693-730`), `/api/cloudflare-turn-credentials` local-only gate (`:666`), `getClientIpFromHeaders` / `shouldTrustRequestForwardedHeaders` composition, `isKnownPublicShareRequest`, the SPA catch-all, and the rate-limit tracker (`:1157-1174`). Several audit findings (S-1, S-4, L-3, L-8) live in exactly this untested code.

**Recommend:** Extract the pure helpers (origin/IP/trust functions are already mostly pure) and unit-test them; add supertest-style HTTP tests for `/api/config` (asserting TURN creds are *not* leaked once fixed), `/api/metrics` (local vs remote vs token), and the 404 behavior.

### T-2 🟠 No integration test for the Socket.IO signaling surface

- **Risk:** High
- **Location:** `lib/socket.js` (2137 lines) — only one branch (`handleViewerTransportFailure`) is unit-tested via `__testing`.

The core real-time flows — `create-room` → `create-send-transport` → `produce`, `join-room` → `create-recv-transport` → `consume` → `consumer-resume`, relay start/stop, host disconnect grace + `reclaim-host`, the fallback-relay start **race (L-1)** — have no automated coverage. These are where the highest-severity logical bugs live.

**Recommend:** Add integration tests using a real `socket.io`/`socket.io-client` pair against a test server with a mocked or real mediasoup router. At minimum, regression-test: (a) double `fallback-consume-start` does not create two workers (L-1), (b) re-joining an already-joined socket is idempotent (L-4), (c) host-disconnect → reclaim within grace restores the room, (d) leaving a relay viewer updates demand correctly.

### T-3 🟠 Zero coverage of any React client code

- **Risk:** High (the client holds the most complex state machines)
- **Location:** `src/HostView.jsx`, `src/WatchView.jsx`, `src/lib/fmp4RelayPlayer.js`, `src/lib/mediasoupClient.js`, all components.

None of the client is tested. The riskiest client logic is untested: the fMP4 player's generation/cleanup handling (leak **L-5**), `socketRequest` retry semantics (hazard **L-4**), the WatchView reconnect/transport-failed recovery state machine (hundreds of lines, 4 duplicated reset blocks), and the WebM relay MSE append/queue path.

**Recommend:** The pure-ish modules are the cheapest wins: unit-test `mediasoupClient.socketRequest` (retry/idempotency, transient-error classification) with a fake socket, and `fmp4RelayPlayer` queue/generation logic with a mocked `MediaSource`/`SourceBuffer`. Add React Testing Library smoke tests for HostView/WatchView happy paths and the join-double-click case (U-2/L-4). `watchPlaybackMode.mjs` shows the team already knows how to factor logic out for testing — apply the same to the recovery decisions.

### T-4 🟡 No end-to-end / browser test of the actual media flows

- **Risk:** Medium
- Playwright + Chromium is available in the environment (per project setup), and the two flows (browser-capture host, viewer join) are automatable with fake media devices (`--use-fake-device-for-media-stream`). There is currently no e2e verifying a viewer can actually see a host's stream, which is the product's single most important behavior.

**Recommend:** One Playwright e2e that starts the server, opens a host tab (fake capture), opens a viewer tab, and asserts the video element receives frames. This would catch whole-flow regressions the unit tests can't.

### T-5 🟡 FFmpeg / mediasoup lifecycle is only lightly exercised; no failure-injection

- **Risk:** Medium
- `ffmpegRelay.test.js` covers arg building and lifecycle logic, but the restart-budget/cap behavior (`ffmpegRelay.js:498-518`), stdin-backpressure drop + `video-gap` (`:410-446`), and init-segment recovery are not failure-injected. The worker-death auto-restart (`server.js:1049`) and its crash-loop guard (`MIN_UPTIME_SECONDS`) are untested.

**Recommend:** Simulate FFmpeg exit codes/signals and assert restart vs. no-restart decisions; simulate worker `'died'` and assert the uptime-gated restart logic.

### T-6 🟢 No coverage measurement or threshold in CI

- **Risk:** Low
- CI runs the suite but there's no `--experimental-test-coverage` gate or coverage report, so regressions in coverage are invisible and the (large) untested surface isn't quantified.

**Recommend:** Enable Node's built-in coverage in CI and surface the number; optionally set a floor for the `lib/` modules that are already well-covered so they don't regress.

---

## Coverage summary

| Area | Status |
|---|---|
| Media byte parsing (fmp4/h264/sprop) | ✅ Good |
| Rooms / config / network / port / TURN helpers | ✅ Good |
| WHIP/WHEP route logic | ✅ Reasonable |
| `server.js` HTTP routes & trust/IP logic | ❌ None (T-1) |
| Socket.IO signaling integration | ❌ Almost none (T-2) |
| React client (Host/Watch/players) | ❌ None (T-3) |
| End-to-end media flow | ❌ None (T-4) |
| Failure injection (ffmpeg/worker death) | ⚠️ Partial (T-5) |
| Coverage reporting | ❌ None (T-6) |

**Priority:** T-2 (signaling integration, to lock down the L-1 race regression) and T-1 (`/api/config` credential-leak regression) first — they guard the highest-severity findings. Then T-3 pure-module client tests, then T-4 e2e.
