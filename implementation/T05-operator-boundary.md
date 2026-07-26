# T05 — Operator, LAN, and WHIP boundary

Depends on T01 and user decision D01.
Findings: CF-04, CF-08, CF-09.

<goal>
Enforce the approved operator policy before room allocation, sensitive metrics,
TURN minting, or public WHIP work. Public viewers never gain host authority.
</goal>

<read>
`server.js`, `lib/socket.js`, `lib/network.js`, `lib/whipRoutes.js`,
`lib/whepRoutes.js`, `config.js`, `.env.example`, and network/WHIP/WHEP tests.
</read>

<do>
1. Centralize classification of loopback, explicitly trusted LAN, known proxy/
   tunnel, and other remote clients. Test forwarded-header spoofing.
2. Authorize `create-room` before replacement, hashing, media setup, or capacity use.
3. Implement D01 with one high-entropy operator capability for approved remote
   hosting. Compare it constant-time; never expose it in config, links, logs, or storage.
4. Keep dedicated loopback WHIP available. Mount public/main WHIP only if D01
   enables it; then add per-IP limits and a global pending-start reservation before
   SDP/media work, with exactly-once release on fail/cancel/success.
5. Apply the same operator boundary to sensitive metrics and TURN minting.
6. Document config, recovery, and rotation; add denial/no-allocation/overlap tests.
</do>

<accept>
Public create attempts allocate nothing and cannot replace a room; loopback Host/
OBS passes; spoofing fails; concurrent WHIP cannot exceed caps; no secret leaks.
</accept>

<checks>
Run focused network, socket, WHIP, and WHEP tests, then `npm test`.
</checks>

<stop>
Do not choose the remote-host or public-WHIP policy. If D01 is not explicit, keep
this card Blocked.
</stop>
