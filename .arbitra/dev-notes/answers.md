# Owner's answers to the plan's blocking questions (October 24, 2026)

Plan: `.arbitra/plans/2026-10-23-ccd3ccea`. Work happens on the `dev` branch, never `main`.

1. **WHEP payload types** (`section-189067a43c5f50160f1b8635/Q-001`, TASK-025): option (a). Answer with the payload
   types (and RTX payload types) the mediasoup consumer actually sends, not the offer's numbering, and check that
   browsers accept the answer (the Playwright WHEP/viewer tests, or a test that feeds the answer to a real
   `RTCPeerConnection` where the suite has one).

2. **Mediasoup worker death after minimum uptime** (`section-907fcaeb0abb75a2dbbcbaee/UQ-002`, TASK-058): option (c).
   When a supervisor is declared (an environment/config flag, documented in the README), exit non-zero and let it
   restart Nextra. Otherwise respawn visibly: not detached, output inherited or written to the startup log, and the
   failure reported, so a desktop user without a supervisor keeps a working app.

3. **OBS encoder-reset test stream** (`section-84098610a3c7f7be0c63f39f/Q-001` and
   `section-49e0545c60d121dd3e784d86/Q-002`, TASK-082 and TASK-096): send the reset stream with a probe target or
   token that the server accepts but never forwards to viewers (no fan-out, no relay, no room media). Keep the reset
   even when autoStart is false, since it then broadcasts nothing. TASK-096 owns the behaviour change; TASK-082
   keeps the housekeeping cleanup guarantee and does not gate the reset on autoStart.

4. **Trusted forwarded headers** (`section-49e0545c60d121dd3e784d86/Q-001`, TASK-005 and TASK-094): honour
   `CF-Connecting-IP` only in Nextra's own Cloudflare tunnel mode (Nextra launched cloudflared) or behind an explicit
   config flag; read `X-Forwarded-For` from the right, skipping the configured `TRUST_PROXY` hop count. The
   `lib/network.js` change is made once: whichever of TASK-005 and TASK-094 comes first builds it, the later one
   checks it and adds only what is missing.

## State after TASK-005 (e640d25)

`lib/network.js` now takes the client from X-Forwarded-For counted from the right with `TRUST_PROXY` as the hop
count, and reads `CF-Connecting-IP` only when `trustCloudflareClientIp === true`. `lib/requestIdentity.js` sets that
for any loopback request addressed to a known share URL, which includes a `SHARE_BASE_URL` the operator set for some
other proxy. Answer 4 asks for less: only when Nextra itself launched cloudflared (its tunnel mode), or an explicit
config flag. TASK-094 must narrow it to that, add the flag (documented in the README), and pass the hop count to the
fallback helpers in `lib/socket.js` (`getSocketIp`) and `lib/whepRoutes.js` (`getRequestIp`).
