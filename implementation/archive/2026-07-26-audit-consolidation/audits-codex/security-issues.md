# Security Issues

## Summary

| ID | Severity | Finding | Production blocker |
| --- | --- | --- | --- |
| S-1 | High | Public clients can create rooms and consume host resources | Yes for public exposure |
| S-2 | Medium | Every private-network client is treated as a privileged operator | Conditional |
| S-3 | Medium | Publicly mounted WHIP ingest has no request rate limit | Yes for public OBS exposure |
| S-4 | Low | Host and WHIP bearer tokens use ordinary string equality | No |
| S-5 | Low | CSP permits WebSocket connections to any host | No |
| S-6 | Medium | Relay media is plaintext on default HTTP LAN links | Conditional |
| S-7 | Low | WHIP/WHEP teardown relies only on unguessable resource URLs | No |
| S-8 | High | Corrupt lockfile prevents dependency integrity and advisory verification | Yes |

## S-1 - Public clients can create rooms and consume host resources

- **Severity:** High
- **Location:** `src/App.jsx:12-20`; `lib/socket.js:1198-1265`; public tunnel configuration in `server.js`/`lib/tunnelSupervisor.js`
- **Description:** The public share origin exposes the complete app, including `#host`. `create-room` requires no operator credential or local-client check; it applies only per-IP throttling and the global room cap. A viewer can navigate to Host, create rooms, publish media, invoke relay work, and fill the default ten-room capacity.
- **Why it matters for production:** One public client can exhaust all room slots under the default per-IP allowance, preventing the machine owner from starting a stream. Distributed clients can also consume CPU, UDP ports, bandwidth, and fallback capacity. Room codes protect viewers; they do not protect the hosting function.
- **Recommended fix:** Restrict room creation to loopback/LAN by default and introduce a per-install host/admin capability for deliberately remote hosting. Validate it server-side before any expensive work, keep it out of viewer URLs, rotate it, and provide a recovery path. Hiding the Host navigation is only presentation; the socket event must enforce authorization.
- **Blocker before production:** Yes for any public-tunnel or public-domain deployment.
- **Related risks/dependencies:** Cloudflare tunnel defaults, MAX_ACTIVE_ROOMS, rate-limit identity, remote OBS configuration, product decision about multi-user hosting.

## S-2 - Every private-network client is treated as a privileged operator

- **Severity:** Medium
- **Location:** `lib/network.js`; `server.js:298-301`, `server.js:745-791`, `server.js:797-869`
- **Description:** `isLocalClientIp` includes RFC1918/private addresses. Any LAN client can receive sensitive room codes/socket IDs from `/api/metrics` and, when Cloudflare TURN autofill is configured, mint and receive cached short-lived TURN credentials. There is no operator authentication inside this trust boundary.
- **Why it matters for production:** Home LANs may be trusted, but office, dorm, guest Wi-Fi, VPN, container bridge, and shared-host networks often are not. A nearby client can discover active rooms or consume paid TURN bandwidth.
- **Recommended fix:** Separate `loopback operator`, `trusted proxy`, and `private network` policies. Default sensitive metrics and credential minting to loopback; require an admin bearer token (and origin check) for LAN access. Document any optional trusted CIDR list explicitly.
- **Blocker before production:** Conditional: yes for deployment on an untrusted/shared LAN or with paid TURN autofill enabled.
- **Related risks/dependencies:** S-1 admin capability, proxy topology, Cloudflare TURN TTL/cache, metrics dashboard access.

## S-3 - Publicly mounted WHIP ingest has no request rate limit

- **Severity:** Medium
- **Location:** `server.js:1354-1357`; `lib/whipRoutes.js:228-264`; compare `lib/whepRoutes.js:20-48`, `lib/whepRoutes.js:180-185`
- **Description:** WHIP is mounted on the main browser-facing server as well as the loopback OBS listener. It parses up to 10 KB of SDP and performs room/token lookups with no per-IP or global request throttle. WHEP has explicit admission and IP rate limiting; WHIP does not.
- **Why it matters for production:** A public tunnel/domain exposes `/whip` to unauthenticated request floods. Invalid-token requests are cheap but still consume HTTP parsing, logging, and event-loop time; valid or leaked tokens reach much more expensive SDP/transport work.
- **Recommended fix:** Add bounded per-IP and global WHIP admission before SDP parsing where possible, return `429` with retry guidance, cap concurrent startup claims globally, and avoid mounting WHIP publicly unless remote ingest is an explicit supported mode.
- **Blocker before production:** Yes if public WHIP ingest is exposed; no for strictly loopback-only OBS usage with the main route disabled externally.
- **Related risks/dependencies:** Trusted proxy IP resolution, host-token handling, OBS reconnect burst behavior.

## S-4 - Host and WHIP bearer tokens use ordinary string equality

- **Severity:** Low
- **Location:** `lib/rooms.js:159-164`; `lib/whipRoutes.js:255-260`; contrast `server.js:667-679`
- **Description:** Host reclaim and WHIP authorization compare high-entropy bearer tokens with `===`, while metrics tokens use a timing-safe comparison.
- **Why it matters for production:** Network timing exploitation is difficult against random 192-bit tokens, but bearer-secret verification should not expose content-dependent comparison behavior, especially on low-latency local/LAN paths.
- **Recommended fix:** Centralize fixed-length token verification using `crypto.timingSafeEqual`, rejecting malformed lengths before comparison, and test reclaim/WHIP behavior.
- **Blocker before production:** No.
- **Related risks/dependencies:** Token rotation, reload recovery, WHIP session replacement.

## S-5 - CSP permits WebSocket connections to any host

- **Severity:** Low
- **Location:** `server.js:141-151`; `src/lib/obsWebSocket.js`
- **Description:** `connect-src` allows the schemes `ws:` and `wss:` without host restriction. The app needs same-origin Socket.IO and loopback OBS WebSocket, but the policy permits any WebSocket endpoint.
- **Why it matters for production:** If an injection bug occurs, the CSP does less to prevent data exfiltration over WebSocket. This is defense in depth, not a current standalone exploit.
- **Recommended fix:** Restrict to `'self'` plus the exact loopback OBS endpoints/ports required by the supported configuration. If a dynamic port is needed, document the smallest viable policy and add a CSP integration test.
- **Blocker before production:** No.
- **Related risks/dependencies:** OBS WebSocket port configurability, HTTP/HTTPS mixed-content rules.

## S-6 - Relay media is plaintext on default HTTP LAN links

- **Severity:** Medium
- **Location:** `.env.example:3-10`; `server.js` local HTTP default; browser/OBS Socket.IO relay paths in `lib/socket.js`
- **Description:** WebRTC media is DTLS-encrypted, and public tunnel traffic is HTTPS, but browser WebM and OBS fMP4 fallback travel as Socket.IO payloads. With the default `LOCAL_HTTPS=false`, a LAN viewer using the Local Link receives relay media and signaling over plaintext HTTP/WebSocket.
- **Why it matters for production:** On an untrusted Wi-Fi/LAN, a passive or active network peer can observe or tamper with fallback traffic even though product copy emphasizes encrypted media paths.
- **Recommended fix:** Document the distinction prominently in the Host/How-To UI. For non-trusted LANs, require a maintained TLS reverse proxy or a trusted local certificate and secure WebSocket. Consider disabling relay over insecure non-loopback origins unless explicitly acknowledged.
- **Blocker before production:** Conditional on the supported LAN threat model.
- **Related risks/dependencies:** Self-signed certificate UX, reverse proxy, tunnel origin traffic, mixed-content OBS constraints.

## S-7 - WHIP/WHEP teardown relies only on unguessable resource URLs

- **Severity:** Low
- **Location:** `lib/whipRoutes.js:483-520`; `lib/whepRoutes.js:304-321`, `lib/whepRoutes.js:420-444`
- **Description:** `DELETE` accepts possession of a random resource ID as the entire authorization decision. This capability-URL pattern is common for WHIP/WHEP, but resource paths can enter access logs, traces, clipboard history, or client diagnostics.
- **Why it matters for production:** Disclosure lets another party terminate an active ingest/viewer session. The 128-bit IDs make guessing infeasible; leakage is the realistic risk.
- **Recommended fix:** Keep capability URLs out of logs and referrers, preserve strict TLS, and where client compatibility permits require the original bearer credential or a session-specific delete token in addition to the resource ID.
- **Blocker before production:** No.
- **Related risks/dependencies:** Protocol-client compatibility, logging/redaction, reverse-proxy access logs.

## S-8 - Corrupt lockfile prevents dependency integrity and advisory verification

- **Severity:** High
- **Location:** `package-lock.json:2402-2406`; `package.json:35`; `.github/workflows/ci.yml:18,29,41`
- **Description:** The committed lockfile is invalid JSON (a missing comma and apparently interleaved dependency fields around `color-convert`). `npm audit --omit=dev`, `npm ci`, packaging evaluation, and SBOM production-graph generation cannot use it.
- **Why it matters for production:** There is no reproducible dependency graph and no trustworthy audit result for the shipping server. The local installation is already divergent (`mediasoup@3.19.17` installed versus declared `^3.21.0`).
- **Recommended fix:** Regenerate the lockfile from a clean, supported Node/npm environment; review the diff for accidental dependency splicing; run `npm ci`, both production audits, SBOM generation, all gates, and Windows packaging from a clean checkout; then protect the lockfile with required CI.
- **Blocker before production:** Yes.
- **Related risks/dependencies:** T-1, T-3, signed release reproducibility, vulnerability triage.

## Positive security controls observed

- Safe loopback defaults for the HTTP and RTC listeners.
- Explicit refusal to bind plaintext WHIP remotely without acknowledgement.
- Socket origin validation and bounded Socket.IO message/chunk sizes.
- Salted scrypt room passphrases and ephemeral TURN credential derivation.
- Local-only smoke/recovery test endpoints guarded by `NEXTRA_SMOKE_TEST`.
- Helmet headers, per-response CSP nonces, no third-party browser scripts, and no persistent media storage.
- Pinned GitHub Action commits and pinned/checksummed/Authenticode-verified `cloudflared` packaging.
