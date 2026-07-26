# T06 — Contained backend correctness

Depends on T01 and the shared auth helper from T05, so it inherits decision D01.
Complete A, B, and C as separate reviewable changes; do not turn them into a
socket rewrite.
Findings: CF-11, CF-12, CF-20.

<goal>
Fix three contained backend defects: viewer bandwidth estimation, room-creation
hashing with capacity accounting, and token comparison plus WebSocket CSP scope.
</goal>

<read>
`lib/mediasoup.js`, `lib/socket.js`, `lib/rooms.js`, `server.js`, WHIP/WHEP
routes, Helmet CSP, and their focused tests.
</read>

<do>
A. Pass `{ purpose: 'viewer' }` for browser receive transports. Contract-test
600 kbps viewer versus 8 Mbps Host; keep WHEP conservative.

B. Replace `scryptSync` room creation with Promise-based `crypto.scrypt`. Count
active plus pending room creations against capacity. One socket cannot overlap
creations. Release each reservation exactly once on failure, disconnect, cancel,
or success. Do not destroy an existing room until replacement is ready. Test
near-capacity concurrency, duplicate calls, hash failure, disconnect, replacement
failure, and event-loop responsiveness.

C. Reuse one constant-time non-empty string comparator for metrics, reclaim,
WHIP, and operator tokens. Restrict CSP `connect-src` to same-origin and the exact
configured loopback OBS WebSocket endpoints. Test allowed and unrelated origins.
</do>

<accept>
Purpose omission fails a test; no sync scrypt/over-admission/leaked reservation;
protected rooms still verify; all supported Socket.IO/OBS connections satisfy CSP.
</accept>

<checks>
Run focused transport/room/socket/WHIP/server tests, then lint, typecheck, unit,
coverage, and browser gates.
</checks>

<stop>
Block if the T05 comparator does not exist yet, or if bounding capacity would
change the documented room limit or the create-room protocol. Name which of
A, B, or C is affected and leave the others complete.
</stop>
