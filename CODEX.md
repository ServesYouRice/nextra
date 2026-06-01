# Project Audit Report

Date: 2026-05-30

Scope: full repository audit of the Node/Express/Socket.IO server, React/Vite client, mediasoup WebRTC path, WHIP/WHEP/fMP4 relay code, packaging scripts, configuration, tests, dependency posture, and local workspace hygiene.

## Executive Summary

The project is functional by the current local checks: lint, unit tests, and production build all pass. The highest-risk blockers before a wider release are dependency vulnerabilities, production-mode ambiguity, surprising default media listener exposure, unbounded synchronous FFmpeg logging, weak secret handling in the browser, and missing production static asset optimizations.

The codebase also has a few maintainability issues that will slow future changes: large server/client modules, stringly typed Socket.IO payloads, configuration drift, and tests that depend on ambient `.env` values. None of these require a rewrite, but they should be handled before adding more transport modes or packaging surfaces.

## Verification Results

- `npm.cmd run lint`: passed.
- `npm.cmd test`: passed, 62 tests.
- `npm.cmd run build`: passed.
- `npm.cmd audit`: failed with 5 moderate vulnerabilities in production dependency graph.
- `npm.cmd outdated`: multiple packages have patch/minor updates available; Vite, ESLint, plugin-react, and concurrently also have major updates available.

## Critical Findings

### P1 - Production Start Does Not Force Production Behavior

Evidence:

- `package.json:10` starts the app with `node server.js`.
- `server.js:325-327` appends Vite development origins whenever `process.env.NODE_ENV !== 'production'`.
- Express production guidance expects `NODE_ENV=production` for production deployments.

Risk:

Running `npm start` or a packaged source build without an external `NODE_ENV=production` keeps development-origin behavior enabled. This is easy to miss because the command name reads like a production start command.

Recommendation:

Make production mode explicit in the start path. Either set `NODE_ENV=production` in the packaged launcher/start command, or introduce an explicit app mode such as `APP_ENV=development` where development origins are opt-in. Add a startup log line that prints the resolved mode and allowed origins.

### P1 - Dependency Vulnerabilities In Production Graph

Evidence:

- `npm audit --omit=dev` reports 5 moderate vulnerabilities.
- `qs` `6.15.0` is present in `package-lock.json:4816-4818`; advisory: `GHSA-q8mj-m7cp-5q26`.
- `ws` `8.18.3` is present in `package-lock.json:5888-5890`; advisory: `GHSA-58qx-3vcg-4xpx`.
- `engine.io`, `engine.io-client`, and `socket.io-adapter` pull affected `ws` ranges through the Socket.IO stack.

Risk:

The vulnerable packages are in the runtime dependency graph. Even moderate advisories matter here because this app exposes long-lived WebSocket/WebRTC coordination endpoints.

Recommendation:

Run `npm audit fix`, inspect the lockfile change, and rerun lint/tests/build. If the `ws` advisory requires transitive movement through Socket.IO packages, update Socket.IO/Engine.IO within their compatible ranges and add `npm audit --omit=dev` to release verification.

### P1 - Default WebRTC Listener Exposure Is Surprising

Evidence:

- `config.js:52` defaults `rtcListenIp` to `127.0.0.1` unless the bind host is `0.0.0.0`.
- `lib/mediasoup.js:25-31` rewrites `127.0.0.1` to a listen IP of `0.0.0.0` and announces LAN or public IP.
- `lib/mediasoup.js:40-44` enables UDP and TCP transports.
- `.env.example:35` suggests `RTC_LISTEN_IP=0.0.0.0` as a commented option even though the mediasoup layer effectively does this in the default local path.

Risk:

An operator can think the app is local-only because HTTP binds to loopback, while mediasoup UDP/TCP transport sockets listen on all interfaces. That is a security and deployment surprise, especially on laptops, shared networks, and packaged desktop runs.

Recommendation:

Make WebRTC listen behavior explicit. Preserve true loopback mode when the server binds to loopback, and require an explicit LAN/public mode to bind mediasoup on `0.0.0.0`. Update `.env.example` and startup diagnostics so HTTP bind, RTC listen IP, and announced IP are all printed separately.

### P1 - FFmpeg Logging Can Block The Event Loop And Fill Disk

Evidence:

- `lib/ffmpegRelay.js:155` writes relay SDP synchronously.
- `lib/ffmpegRelay.js:190-191` logs every FFmpeg stderr line and appends synchronously to `ffmpeg-error.log`.
- The local workspace already contains a large `ffmpeg-error.log` artifact.

Risk:

High-volume FFmpeg stderr can block the Node event loop, degrade signaling and relay cleanup, and grow without bound on disk. This is especially risky in long-running streaming sessions.

Recommendation:

Replace synchronous append logging with an asynchronous logger that supports levels, redaction, max size, and rotation. Gate verbose FFmpeg logs behind a debug flag and summarize repeated errors. Prefer temporary files under an app-owned temp directory with cleanup.

### P1 - OBS Password Persists In Browser Local Storage

Evidence:

- `src/HostView.jsx:36-37` defines browser storage keys.
- `src/HostView.jsx:289-302` loads the saved OBS password from `localStorage`.
- `src/HostView.jsx:394` and `src/HostView.jsx:493-495` persist OBS connection details automatically.
- `src/HostView.jsx:1429-1434` renders the OBS password input.

Risk:

`localStorage` is long-lived and readable by any script that runs in the origin. Combined with a CSP that still allows inline styles, a future XSS issue would expose the OBS WebSocket password. The TURN BYOK path is more careful because it uses optional session storage; the OBS path is weaker.

Recommendation:

Default to in-memory or session-only storage for the OBS password. If persistence is needed, require an explicit "remember password" control and document the tradeoff. Continue moving inline styles into CSS so the CSP can eventually remove `'unsafe-inline'`.

## High Priority Findings

### P2 - Static Assets Are Not Compressed Or Given Immutable Cache Headers

Evidence:

- `server.js:737-746` serves `dist` through `express.static` with custom HTML no-cache headers.
- `server.js:748-755` returns the SPA fallback HTML with no-store headers.
- There is no compression middleware in `package.json`.

Risk:

Hashed Vite assets are safe to cache aggressively, but the server currently treats all static output similarly except HTML. Users pay extra bandwidth and startup latency, especially on relayed/video-heavy sessions where control UI responsiveness matters.

Recommendation:

Add Brotli/gzip compression at the reverse proxy or Express layer. Set `Cache-Control: public, max-age=31536000, immutable` for hashed assets under `dist/assets`, while keeping `index.html` and SPA fallback no-store.

### P2 - Socket.IO Transport And Recovery Are Brittle For Real Networks

Evidence:

- `src/context/SocketContext.jsx:8-12` forces `transports: ['websocket']` and disables transport upgrade.
- `server.js:1045-1059` initializes Socket.IO without connection state recovery.
- Producer notifications are event-driven, for example `lib/socket.js:1222` and `lib/whipRoutes.js:208-214`.
- `src/WatchView.jsx:685-695` consumes producer events on the client.

Risk:

WebSocket-only mode is simpler, but it removes Socket.IO's HTTP long-polling fallback. Some proxies, captive networks, and corporate environments break or delay WebSocket upgrades. Without connection state recovery, short disconnects can miss producer lifecycle events unless custom rejoin logic catches every case.

Recommendation:

Either document WebSocket-only as a hard deployment requirement with reverse proxy examples and health checks, or restore polling fallback where feasible. Evaluate Socket.IO connection state recovery for missed events and add reconnect tests around producer creation/removal.

### P2 - Socket Event Payloads Are Not Schema-Validated

Evidence:

- `lib/socket.js:1170-1191` validates `connect-transport` only shallowly before passing DTLS parameters to mediasoup.
- `lib/socket.js:1203-1216` validates `produce` kind but not full RTP parameter shape.
- `lib/socket.js:1246-1286` accepts truthy RTP capabilities and relies on router checks.
- Large modules increase review risk: `server.js` is over 1,100 lines, `lib/socket.js` over 1,800 lines, `src/HostView.jsx` over 1,700 lines, and `src/WatchView.jsx` over 1,300 lines.

Risk:

Malformed payloads can create noisy failures, unexpected mediasoup errors, or cleanup edge cases. The lack of schemas also makes it harder to evolve client/server contracts safely.

Recommendation:

Introduce explicit schemas for Socket.IO event payloads, using a small validator or a TypeScript/shared-schema migration. Start with public/high-volume events: `join-room`, `create-transport`, `connect-transport`, `produce`, `consume`, WHIP/WHEP session lifecycle, and fallback viewer state.

### P2 - `MAX_FALLBACK_VIEWERS` Is Documented But Not Enforced

Evidence:

- `config.js:311` parses `MAX_FALLBACK_VIEWERS`.
- `.env.example:72` documents `MAX_FALLBACK_VIEWERS`.
- `lib/socket.js:1467-1468` adds fallback viewers without checking that setting.
- `lib/socket.js:974-981` enforces only the general room viewer cap.

Risk:

Operators may tune `MAX_FALLBACK_VIEWERS` expecting fMP4 fallback load protection, but the value is currently ineffective. That can lead to CPU/bandwidth overload during fallback mode.

Recommendation:

Either enforce the fallback-specific cap or remove the setting. If enforcing it, test mixed WebRTC/WHEP/fallback viewer counts and make the error message distinct from the general room limit.

### P2 - Tests Depend On Ambient `.env`

Evidence:

- `config.js:2` unconditionally calls `require('dotenv').config()`.
- `npm test` output showed dotenv loading values from the local `.env`.

Risk:

Tests can pass or fail based on developer-local secrets and network settings. This makes CI/debugging less reproducible and can hide configuration bugs.

Recommendation:

Load `.env` at the application entry point, not inside the shared config module, or gate dotenv loading behind an explicit runtime path. In tests, use a known fixture env and clear process-level mutations between cases.

### P2 - WHIP Public Surface Needs Tighter Deployment Guardrails

Evidence:

- `lib/whipRoutes.js:27-30` allows CORS from `*`.
- `lib/whipRoutes.js:100-105` requires a bearer token, which is good.
- `lib/whipRoutes.js:283-289` builds the `Location` header from forwarded/host headers.
- `WHIP_BIND_HOST` defaults to loopback, but `.env.example` allows exposing it.

Risk:

The current default is local, but once WHIP is bound beyond loopback, broad CORS and forwarded-host handling become part of the public ingest surface. Token auth is the primary protection, so host/proxy normalization should be explicit.

Recommendation:

When WHIP is public, restrict CORS to expected origins where possible, validate forwarded host/proto through the same trusted-proxy posture as the main server, and document the required reverse proxy behavior.

### P2 - Vite Dev Host Allowlist Is Broad For Tunnel Use

Evidence:

- `vite.config.mjs:24-26` allows `.trycloudflare.com`.
- `vite.config.mjs:46` and `vite.config.mjs:50` apply this to dev/preview host checks.
- Vite documentation warns that host allowlists affect DNS rebinding exposure.

Risk:

Allowing a whole public suffix is convenient for ephemeral tunnels, but it broadens the set of hostnames accepted by the dev server. This is most relevant if the dev server is exposed beyond localhost.

Recommendation:

Prefer adding the concrete tunnel hostname when it is known. If suffix allowlisting remains, keep it dev-only, document why it exists, and avoid using Vite preview/dev servers as production surfaces.

## Medium Priority Findings

### P3 - CSP Still Requires `'unsafe-inline'` For Styles

Evidence:

- `server.js:82-89` configures Helmet CSP and includes `styleSrc` with `'unsafe-inline'`.
- The React views contain many inline style objects, for example in `src/HostView.jsx` and `src/WatchView.jsx`.

Risk:

Inline styles are not equivalent to inline scripts, but requiring `'unsafe-inline'` weakens the CSP and makes future hardening harder.

Recommendation:

Move repeated inline styles into CSS modules/classes or a small component style system. Then remove `'unsafe-inline'` from `style-src` and keep script nonces.

### P3 - Local Workspace Contains Large Ignored Runtime Artifacts

Evidence:

- The workspace root contains large ignored artifacts such as `Nextra.exe`, `cloudflared.exe`, and `ffmpeg-error.log`.
- `.gitignore` intentionally ignores packaged binaries and logs.

Risk:

This does not directly affect tracked source, but large root-level artifacts slow inspections, backups, and accidental packaging checks. Logs can also contain environment details.

Recommendation:

Move runtime binaries/logs into a dedicated ignored runtime directory such as `.runtime/` or `var/`, and keep the project root focused on source and release artifacts.

### P3 - `CODEX.md` Is Ignored By The Current Gitignore

Evidence:

- `.gitignore:46-48` ignores `*.md`, then unignores only `README.md` and `SENATE3.md`.

Risk:

This audit report exists in the workspace but will not be tracked by Git unless the ignore rules are changed or the file is force-added.

Recommendation:

If this report should be committed, add `!CODEX.md` to `.gitignore` near the existing markdown exceptions.

## Positive Observations

- Helmet is configured with CSP and per-request script nonces.
- WHEP has explicit session cleanup and capacity checks.
- WHIP ingest requires a bearer token.
- The release preflight script checks for problematic binary/secret packaging patterns.
- Unit tests cover a meaningful amount of parser, config, relay, TURN, and route behavior.
- The build is already split into separate chunks for host/watch views and major dependencies.

## Dependency Freshness Notes

Notable `npm outdated` results:

- Runtime patches/minors available: `dotenv`, `helmet`, `mediasoup`, `mediasoup-client`, `react`, `react-dom`.
- Tooling patches/minors available: `@eslint/js`, `@types/react`, `@vitejs/plugin-react`, `eslint`, `eslint-plugin-react-hooks`.
- Major updates available: Vite 8, ESLint 10, plugin-react 6, concurrently 10, globals 17.

Recommendation:

Handle security fixes first. Then update runtime packages in small batches with focused smoke tests for mediasoup transport setup, WHIP ingest, WHEP playback, Socket.IO reconnect, and packaged startup.

## Test Coverage Gaps

- No browser E2E coverage for host screen capture, watcher join/reconnect, relay fallback playback, or room lifecycle.
- No integration test that exercises real mediasoup worker startup plus Socket.IO signaling.
- No CI gate for `npm audit --omit=dev`.
- No packaging smoke test that launches the built app and verifies `/health`, static assets, and Socket.IO connection.
- No stress/load test for fallback viewers or FFmpeg relay log volume.

## Suggested Remediation Order

1. Fix `npm audit --omit=dev` vulnerabilities and add an audit gate to release checks.
2. Make production mode explicit in `npm start` and packaged startup.
3. Correct default mediasoup listen behavior so local mode stays local unless LAN/public mode is selected.
4. Replace synchronous unbounded FFmpeg logging with levelled, rotating, asynchronous logging.
5. Stop persisting OBS passwords by default; use session/in-memory storage unless the user opts in.
6. Add compression and immutable cache headers for hashed Vite assets.
7. Decide whether Socket.IO should support polling/recovery, then test disconnect/rejoin behavior.
8. Add schemas for the highest-risk Socket.IO payloads.
9. Enforce or remove `MAX_FALLBACK_VIEWERS`.
10. Make tests hermetic by removing unconditional dotenv loading from shared config.
11. Tighten WHIP public deployment guidance and host/proxy validation.
12. Add `!CODEX.md` to `.gitignore` if this report should be versioned.

## References

- Express security best practices: https://expressjs.com/en/advanced/best-practice-security.html
- Express performance best practices: https://expressjs.com/en/advanced/best-practice-performance.html
- Socket.IO connection state recovery: https://socket.io/docs/v4/connection-state-recovery/
- Socket.IO client options and transports: https://socket.io/docs/v4/client-options/
- Socket.IO CORS handling: https://socket.io/docs/v4/handling-cors/
- Socket.IO reverse proxy guidance: https://socket.io/docs/v4/reverse-proxy/
- Vite server options and `allowedHosts`: https://vite.dev/config/server-options
- React Strict Mode reference: https://react.dev/reference/react/StrictMode
- OWASP HTML5 Security Cheat Sheet, browser storage guidance: https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html
- `qs` advisory `GHSA-q8mj-m7cp-5q26`: https://github.com/advisories/GHSA-q8mj-m7cp-5q26
- `ws` advisory `GHSA-58qx-3vcg-4xpx`: https://github.com/advisories/GHSA-58qx-3vcg-4xpx
