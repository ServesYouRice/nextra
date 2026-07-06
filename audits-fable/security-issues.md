# Security Issues

Findings on authentication/authorization, credential exposure, origin/IP trust, the process-spawn surface, TLS, and CSP. Severity legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low.

**Threat-model note.** Nextra is designed to run on a *user's own machine*, bind to loopback by default (`BIND_HOST=127.0.0.1`), and expose viewing via an opt-in tunnel or manual reverse proxy. Many "weak" defaults are acceptable for the loopback case but become real exposures once the app is reachable from the internet (public tunnel, `BIND_HOST=0.0.0.0`, or a reverse proxy). Findings are framed for the **exposed** posture, since that is what "production" means here.

---

## S-1 🔴 `/api/config` returns full ICE servers incl. ephemeral HMAC TURN credentials to any unauthenticated caller

- **Severity:** Critical (when TURN is configured)
- **Blocker:** Yes if a TURN server is configured and the app is internet-reachable
- **Location:** `server.js:643-664` — `/api/config` responds with `iceServers: config.getIceServers()`; credential minting in `config.js:109-137` (24-hour HMAC-SHA1 username `\`${timestamp}:nextra\`` + base64 credential).

**Problem.** The `/api/config` endpoint is unauthenticated (it must be — the client needs config before joining). When a global TURN secret is configured (`TURN_URL`+`TURN_SECRET`), `getIceServers()` embeds freshly-minted TURN credentials valid for **24 hours** (`config.js:115`). Anyone who can reach `/api/config` — every internet viewer, every scanner that hits the tunnel URL — gets working TURN credentials for a full day.

**Why it matters.** TURN relays media bytes; stolen credentials let a third party use the operator's TURN server as a free relay (bandwidth theft, potential traffic-laundering) for 24 h per fetch, renewable indefinitely. This is the classic "coturn secret leaked to the browser" problem, amplified by the long TTL.

**Fix.** (1) Shorten the credential TTL drastically (minutes, not 24 h) — the client only needs them for the session. (2) Prefer issuing TURN credentials **per join** tied to the room/socket rather than blanket via `/api/config`; the room-scoped path already exists (`refreshRoomIceServers` in `rooms.js:115`, delivered in `create-recv-transport`/`create-send-transport` responses). (3) Document that a global TURN secret + public exposure means credential distribution — recommend the Cloudflare-TURN autofill / BYOK path (which is local-only gated, `server.js:667`) over a baked-in global secret.

**Related.** The room-scoped BYOK TURN and Cloudflare autofill endpoints are gated to local/LAN clients (`server.js:667-669`) — good. This finding is specifically about the *global* `getIceServers()` leaking through `/api/config`.

---

## S-2 🟠 WHIP bearer token travels over plain HTTP; broadening `WHIP_BIND_HOST` exposes it

- **Severity:** High (posture-dependent)
- **Blocker:** Conditional — yes if `WHIP_BIND_HOST` is widened beyond loopback
- **Location:** WHIP is intentionally served over **HTTP** (`server.js:1105-1112`, comment "OBS cannot connect to self-signed HTTPS reliably"), auth is a Bearer token equal to `room.hostToken` (`lib/whipRoutes.js:228-233`); bind host `config.js:317` defaults to `127.0.0.1`.

**Problem.** The host token is a 24-byte hex secret (`rooms.js:46`) that also authorizes room reclaim (`socket.js:1175`). Over WHIP it is sent as a plaintext `Authorization: Bearer` header on an unencrypted HTTP connection. On loopback (default) this is fine. But `WHIP_BIND_HOST` is configurable; if an operator sets it to `0.0.0.0` (e.g. to run OBS on another LAN machine), the token — and the SDP — cross the network in cleartext, and the WHIP request logging at `server.js:980` prints method/URL/IP for every call.

**Why it matters.** A sniffed host token lets an attacker hijack the room (reclaim as host, redirect OBS ingest). The plaintext channel is invisible to the user.

**Fix.** Keep WHIP loopback-only by default (it is) and **document loudly** that widening `WHIP_BIND_HOST` requires a trusted network or an encrypted front (e.g. a local reverse proxy / VPN). Consider warning at startup if `WHIP_BIND_HOST` is non-loopback. Rotate the host token independently of the WHIP resource if feasible.

---

## S-3 🟠 `toggle_media` spawns PowerShell / xdotool as a viewer-triggered action

- **Severity:** High (surface), Medium (exploitability — well gated)
- **Blocker:** No (defenses are reasonable) but must be understood
- **Location:** `lib/socket.js:1774-1847` (handler), fallback spawn `:144-179` (`pressMediaPlayPauseFallback` runs `powershell.exe … keybd_event` on Windows, `xdotool key XF86AudioPlay` on Linux), primary path uses `@nut-tree-fork/nut-js` if present (`:132-142`).

**Problem.** A **viewer** action (`toggle_media`) causes the **host** machine to synthesize a media key press. The PowerShell script is a fixed, non-interpolated template (no user data reaches the shell — good), gated by: host opt-in (`allowMediaControl`, `:1793`), host-can't-toggle-self (`:1784`), room membership, and dual cooldowns (`:1804,1812`). So it is not an injection vector as written. The concern is the **capability**: remote input synthesis on the host, spawning a shell interpreter per invocation, and the dependency on OS tooling. `nut-js` is `require`d dynamically and is **not** in `package.json` dependencies (`socket.js:136`), so the PowerShell/xdotool fallback is the *default* path.

**Why it matters.** Input synthesis is a powerful primitive; today it presses exactly one key, but the pattern (spawn a shell to simulate input on viewer command) is one refactor away from danger, and repeated PowerShell spawns are a performance/AV-flagging concern. It should be explicitly threat-modeled and kept minimal.

**Fix.** Keep the fixed-template discipline (never interpolate). Consider making the whole feature opt-in at the server/config level (not just per-room), add a hard global rate limit, and document that enabling media control grants viewers a (constrained) input primitive on the host. Note the `nut-js` optional dependency situation in docs.

---

## S-4 🟠 Forwarded-header / tunnel trust model funnels all remote viewers to one identity

- **Severity:** High (availability + abuse-control)
- **Blocker:** Cross-referenced as a blocker in `logical-issues.md` L-3
- **Location:** `server.js:210-230`, `lib/network.js:34-51`, tunnel origin recognition `server.js:162-217`.

**Problem.** With `TRUST_X_FORWARDED_HEADERS=false` (default), requests arriving via the recognized public-share origin are labeled `'public-share-proxy'` and all share one rate-limit/identity bucket (see L-3 for the availability impact). The alternative — setting `TRUST_X_FORWARDED_HEADERS=true` — trusts `cf-connecting-ip`/`x-forwarded-for` **only from local/private peer addresses** (`network.js:34-37`), which is correct for a co-located reverse proxy but subtle: an operator who terminates the tunnel elsewhere and forwards over the LAN must understand the peer-locality requirement or spoofed `x-forwarded-for` becomes trusted.

**Why it matters.** The default is safe-but-self-DoSing; the opt-in is correct-but-easy-to-misconfigure. Either way, per-IP abuse controls over the tunnel are weak.

**Fix.** As in L-3: derive a per-viewer bucket from `cf-connecting-ip` for the *known* tunnel origin even while keeping it untrusted for URL derivation. Document the reverse-proxy trust model with an explicit "only trust forwarded headers from a proxy you control on a private address" warning (the code enforces locality; the docs should state it).

---

## S-5 🟡 `PUBLIC_TUNNEL_NO_TLS_VERIFY` defaults to `true`

- **Severity:** Medium
- **Blocker:** No
- **Location:** `config.js:169` (default `true`); used to add `--no-tls-verify` to cloudflared when the local origin is HTTPS (`lib/tunnel.js:166`).

**Problem.** When the local server runs HTTPS (self-signed), cloudflared is told to skip TLS verification to the local origin. This is defensible (the cert is self-signed and the hop is loopback), but shipping `no-tls-verify` **on by default** is a footgun if the pattern is copied to a non-loopback origin, and it weakens the "media is encrypted end-to-end" story on the cloudflared→origin hop.

**Fix.** Keep default behavior but scope it explicitly to loopback origins, and document that it only disables verification for the local self-signed hop. Consider defaulting to `false` and enabling automatically only when `LOCAL_HTTPS` + loopback.

---

## S-6 🟡 CSP allows `'unsafe-inline'` styles and depends on external Google Fonts

- **Severity:** Medium
- **Blocker:** No
- **Location:** `server.js:94-110` — `styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']`, `fontSrc` includes `https://fonts.gstatic.com`; fonts loaded in `index.html:26-29`.

**Problem.** Scripts are correctly nonce-locked (`scriptSrc` uses a per-request nonce, `server.js:98,744`) — good. But styles permit `'unsafe-inline'`, weakening CSP against style-based injection/exfiltration, and the app fetches CSS + fonts from `fonts.googleapis.com`/`fonts.gstatic.com`, a third-party dependency and a privacy/availability coupling (fonts fail if Google is blocked or offline; the "self-hosted, nothing leaves your machine" positioning is undercut by a call to Google on every load).

**Fix.** Self-host the Inter / JetBrains Mono fonts (bundle via Vite) to drop the external origins entirely; then tighten `styleSrc` (remove the Google origin, and ideally move to hashed/nonce'd styles to drop `'unsafe-inline'`). This also improves offline/LAN operation.

---

## S-7 🟡 Metrics token comparison leaks length; token optional for remote metrics

- **Severity:** Medium (low)
- **Blocker:** No
- **Location:** `server.js:614-627` (`timingSafeStringEqual` returns early on length mismatch, `:617-618`), metrics gate `:693-707`.

**Problem.** `timingSafeStringEqual` uses `crypto.timingSafeEqual` (good) but returns `false` immediately when lengths differ, leaking the token length via timing. More importantly, remote metrics require a token *only if* `METRICS_TOKEN` is set **and** the client is non-local (`:701`); if `ALLOW_REMOTE_METRICS=true` is set without a token, remote clients get metrics with no auth (the code does gate on `!config.ALLOW_REMOTE_METRICS && !isLocalClient` first, so this requires explicit opt-in — still worth flagging). Sensitive room fields (codes, host socket ids) are stripped for unauthorized callers (`:707-710`) — good.

**Fix.** Hash both sides to a fixed length before `timingSafeEqual` to avoid the length leak. Refuse to enable `ALLOW_REMOTE_METRICS` without a `METRICS_TOKEN` (fail closed with a startup warning).

---

## S-8 🟢 Predictable FFmpeg SDP temp filenames in a shared tmp dir

- **Severity:** Low
- **Blocker:** No
- **Location:** `lib/ffmpegRelay.js:299-301` — `path.join(os.tmpdir(), \`nextra-ffmpeg-${roomCode}-${Date.now()}.sdp\`)`, written `0644` implicitly, cleaned on stop (`:487-489`).

**Problem.** The SDP path is guessable (room code is 6 chars from a known alphabet; timestamp is coarse) and lives in the world-readable OS temp dir. The SDP contains only loopback IPs and the audio RTP port — low sensitivity — but on a multi-user host another local user could read it or pre-create the path to interfere with the relay.

**Fix.** Add random bytes to the filename and create with `0600` via `fs.writeFileSync(path, data, { mode: 0o600 })`. Low priority given the low-sensitivity contents and loopback-only ports.

---

## S-9 🟢 Room code is the sole viewer credential; 6 chars from a 32-symbol alphabet

- **Severity:** Low (by design) — documentation item
- **Blocker:** No
- **Location:** `lib/rooms.js:5-37` (`CHARS` = 31 usable symbols, `CODE_LENGTH=6`, `crypto.randomInt`), join at `socket.js:1201`.

**Problem.** ~31^6 ≈ 8.9×10^8 codes — fine entropy against blind guessing, and generation uses a CSPRNG. But it is the *only* gate on viewing a stream, and (per L-3/S-4) online guessing over the tunnel is rate-limited by a *shared* bucket that a single client can consume, so distributed guessing isn't cleanly throttled per-attacker. Realistically low risk, but the security model ("anyone with the code can watch, no other auth") should be stated so operators streaming sensitive content understand it.

**Fix.** Document the trust model. For higher-assurance use, offer an optional room passphrase / host approval step (see `nice-to-haves.md`). Fixing the shared rate-limit bucket (L-3) also hardens against code guessing.

---

## S-10 🟢 cloudflared / ffmpeg / OBS binaries invoked from resolved paths and system PATH

- **Severity:** Low
- **Blocker:** No
- **Location:** `lib/tunnel.js:46-70` (candidate resolution incl. `process.cwd()` when `ALLOW_SYSTEM_CLOUDFLARED=1`), `config.FFMPEG_PATH` default `'ffmpeg'` (`config.js:318`) → resolved via PATH.

**Problem.** `ffmpeg` and (optionally) `cloudflared` are launched by name, resolved through the environment PATH / cwd. On a compromised or shared machine, PATH/cwd hijacking could substitute a malicious binary. The cloudflared resolver deliberately restricts system-PATH lookup behind `ALLOW_SYSTEM_CLOUDFLARED` (good), but `FFMPEG_PATH` defaults to a bare `ffmpeg`.

**Fix.** Recommend absolute `FFMPEG_PATH` in production docs; the packaged exe should bundle/point at a known ffmpeg. Low risk on a single-user host.

---

## Summary

| # | Issue | Severity | Blocker |
|---|---|---|---|
| S-1 | `/api/config` leaks 24h HMAC TURN creds unauthenticated | 🔴 Critical | Yes (if TURN + exposed) |
| S-2 | WHIP bearer over plaintext HTTP if bind widened | 🟠 High | Conditional |
| S-3 | Viewer-triggered PowerShell/xdotool input synthesis | 🟠 High (surface) | No |
| S-4 | Tunnel/forwarded-header trust funnels remote viewers to one identity | 🟠 High | Cross-ref L-3 |
| S-5 | `PUBLIC_TUNNEL_NO_TLS_VERIFY` default true | 🟡 Medium | No |
| S-6 | CSP `unsafe-inline` styles + external Google Fonts | 🟡 Medium | No |
| S-7 | Metrics token length leak / opt-in remote metrics | 🟡 Medium | No |
| S-8 | Predictable SDP temp filenames | 🟢 Low | No |
| S-9 | Room code is sole viewer credential | 🟢 Low (doc) | No |
| S-10 | ffmpeg/cloudflared launched via PATH/cwd | 🟢 Low | No |

**Top security priorities before public exposure:** S-1 (TURN credential TTL + per-room issuance), then S-4/L-3 (tunnel rate-limit identity), then S-6 (self-host fonts, tighten CSP) and the S-2 documentation/startup-warning for non-loopback WHIP.
