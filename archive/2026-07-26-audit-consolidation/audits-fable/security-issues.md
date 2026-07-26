# Security Issues

Context: no accounts by design; trust boundaries are room codes (30-bit), host tokens (192-bit), optional scrypt passphrases, origin allow-listing, and loopback-only defaults. The posture is strong for a self-hosted tool: nonce CSP, Helmet, timing-safe metrics token, ephemeral room-scoped TURN credentials deliberately kept off the unauthenticated `/api/config`, loopback-only WHIP with an explicit acknowledgement gate for anything wider, and forwarded-header trust restricted to loopback peers. Findings below are refinements, not holes.

---

## S-1 · Host-token comparisons are not constant-time

- **Severity:** Low
- **Location:** `lib/rooms.js:163` (`reclaimHostRoom`), `lib/whipRoutes.js:258` (WHIP bearer)
- **Details/fix:** See `logical-issues.md` L-12. 192-bit tokens make timing attacks impractical over a network; fix for consistency with `timingSafeStringEqual` (`server.js:667`), which the metrics path already uses.
- **Blocker:** No.

## S-2 · CSP `connect-src` allows `ws:`/`wss:` to any host

- **Severity:** Low
- **Location:** `server.js:148` (`connectSrc: ["'self'", 'ws:', 'wss:']`)
- **Problem:** The wildcard schemes let injected script (were XSS ever found) exfiltrate to any WebSocket endpoint, weakening the otherwise strict nonce CSP. `'self'` covers the same-origin Socket.IO connection in every modern browser (including the OBS auto-config path only when served from localhost — note `ws://127.0.0.1:4455` for OBS **does** rely on the broad allowance when hosting from a non-localhost origin).
- **Fix:** Tighten to `'self'` plus the specific origins actually needed (`ws://127.0.0.1:4455` for obs-websocket; the tunnel origin is same-origin). Verify the OBS auto-config flow from a LAN-origin page before/after.
- **Blocker:** No.

## S-3 · WHIP/WHEP `DELETE` endpoints authenticate by capability URL only

- **Severity:** Low (informational)
- **Location:** `lib/whipRoutes.js:518` (`DELETE /whip/broadcast/:resourceId`), `lib/whepRoutes.js:420` (`DELETE /whep/watch/:sessionId`)
- **Problem:** Anyone holding the 128-bit resource/session ID can terminate the session — that is the WHIP/WHEP standard model, and the IDs are only ever disclosed in the `Location` header to the client that created them. Fine; documenting so future proxies/logging don't leak `Location` headers (access logs on a fronting proxy would capture the DELETE path, which is post-hoc harmless, but the `Location` response header in proxy logs would be a live capability).
- **Fix:** None required; add a note to `docs/service-deployment.md` warning against logging response headers on any fronting proxy.
- **Blocker:** No.

## S-4 · Share-link base URL reflects an unauthenticated `Host` header for non-local hostnames

- **Severity:** Low
- **Location:** `server.js:428-433` (`getShareBaseUrl` falls back to `req.get('host')`), similar in `getShareBaseUrlFromHeaders`
- **Problem:** A direct request with a forged `Host:` header receives config/share URLs embedding that host. Because `/api/config` is consumed same-origin by the SPA (a browser sends the true host) the practical effect is limited to the attacker fooling themselves; there is no cache in front to poison by default. Becomes relevant only if an operator adds a caching proxy.
- **Fix:** If a reverse proxy + cache is ever documented as supported, validate `Host` against the allowed-origins set before reflecting it. Otherwise accept.
- **Blocker:** No.

## S-5 · Secrets in browser storage (session-scoped, opt-in — acceptable, document it)

- **Severity:** Informational
- **Location:** `src/HostView.jsx:43-45` — OBS WebSocket password and BYOK TURN credentials in `sessionStorage` (the legacy `localStorage` copy is actively migrated/cleared, `HostView.jsx:311-320`)
- **Assessment:** Session-scoped, host-machine-only, opt-in for TURN ("Save for this session" checkbox), and the Cloudflare TURN long-lived API token stays server-side with the browser only ever receiving short-TTL minted credentials. This is the right design. Suggest a line in the Privacy page stating that these fields never leave the host machine except toward OBS/TURN.
- **Blocker:** No.

## S-6 · Rate limiting is present everywhere it matters; two soft spots

- **Severity:** Low
- **Location:** `server.js:1402-1419` (per-IP socket connection window), `lib/socket.js` (create-room/join/toggle cooldowns), `lib/whepRoutes.js` (per-IP + global caps + pending-reservation admission)
- **Soft spots:**
  1. `media-chunk` ingest (`lib/socket.js:2008`) has a per-chunk size cap but no per-second byte budget per host; a hostile *host* can push `SOCKET_MAX_HTTP_BUFFER_SIZE`-bounded chunks continuously. Only the host of a room can do this (auth by role), and outbound fanout is already capped per-viewer, so impact is confined to the host's own CPU slice — acceptable; document the assumption "hosts are trusted for their own room's resource use".
  2. `POST /api/cloudflare-turn-credentials` is limited per-IP to 1/10 s and cached, but the per-IP map is never pruned (see L-11).
- **Blocker:** No.

## S-7 · `PUBLIC_TUNNEL_NO_TLS_VERIFY` defaults to `true`

- **Severity:** Low
- **Location:** `config.js:205`, used in `lib/tunnel.js:192` (only when the local origin is HTTPS)
- **Problem:** The `--no-tls-verify` flag applies to cloudflared's connection to the *local* self-signed HTTPS listener — necessary for the self-signed cert to work through a quick tunnel, so a `true` default is pragmatic. However, it also silently applies when an operator points the tunnel at a properly-certified local endpoint.
- **Fix:** Keep the default, but log a one-line notice at startup when active so operators know verification is off on the loopback hop. (Traffic on that hop never leaves the machine.)
- **Blocker:** No.

## S-8 · Supply-chain: lockfile corruption defeats pinning; two deprecated packaging deps

- **Severity:** Medium (mostly via L-1)
- **Location:** `package-lock.json` (see L-1); `caxa@3.0.1` and `rcedit@5.0.2` are npm-deprecated/unmaintained
- **Problem:** With the lockfile unparseable, `npm install` free-floats every semver range — integrity hashes and the `npm audit` gate (`audit:prod`) are auditing a moving target. `caxa` being unmaintained is already tracked as a packaging-migration trigger in `REMAINING-WORK.md` §3; it is also a *security* consideration (no patches will come).
- **Fix:** Regenerate the lockfile (L-1). Track caxa/rcedit CVEs manually until the SEA migration trigger fires.
- **Blocker:** The lockfile part is (as L-1).

## S-9 · Positive observations (no action)

- Nonce-based CSP with per-request nonces injected into built HTML; no `unsafe-inline` anywhere.
- `/api/config` intentionally omits ICE/TURN credentials; room-scoped ICE only via membership-gated socket calls — with fresh HMAC credentials minted per transport creation.
- Socket handshake requires a trusted Origin (or explicit opt-outs), with `trycloudflare.com` origins only accepted when they match the *known* tunnel URL.
- Forwarded headers trusted only from loopback peers and only when `TRUST_X_FORWARDED_HEADERS` is set; the tunnel path deliberately namespaces viewer IPs (`public-share:*`) so they can never satisfy `isLocalClientIp` gates.
- Metrics: local-only by default, token via timing-safe compare, sensitive fields (room codes, host socket IDs) stripped for token-remote readers; OpenMetrics refuses to run without a token.
- Test-only endpoints (`/api/test/*`) are 404 unless `NEXTRA_SMOKE_TEST=1` *and* the caller is local.
- Room codes: 6 chars from a 32-char alphabet (30 bits) + join rate limit of 20/min/IP makes online guessing impractical (~54M codes vs ≤10 active rooms).
- WHIP validated as loopback-only at config time with an explicit `WHIP_ALLOW_INSECURE_REMOTE` acknowledgement and startup warning.
