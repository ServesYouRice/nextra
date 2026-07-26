# Packet 06 - Contained backend correctness and hardening

Findings: CF-11, CF-12, CF-20. Prerequisites: Packets 01 and 04 policy helpers.

Execute as three reviewed sub-batches; do not combine them into a general socket refactor.

## A. Viewer initial bandwidth estimate

Read `lib/mediasoup.js`, receive/send transport handlers in `lib/socket.js`, WHEP
transport creation, and transport tests.

Plan: pass `{ purpose: 'viewer' }` only for browser receive transports; keep host
send/WHIP high and WHEP conservative. Add a factory/contract test proving browser
receive selects 600 kbps and host selects 8 Mbps. Do not tune either number here.

Acceptance: the purpose cannot be accidentally omitted without a failing test;
constrained-network tuning remains an external evidence task.

## B. Asynchronous passphrase hashing with atomic admission

Read `lib/rooms.js`, `create-room` in `lib/socket.js`, room capacity/rate tests, and
Packet 04 authorization changes.

Plan:

1. Replace `scryptSync` with Promise-based `crypto.scrypt`.
2. Add one owner for in-flight room creation/reservation. Authorization and cheap
   validation occur before reservation; reservation occurs before hashing.
3. Count active plus pending creations against capacity. Concurrent calls from
   the same socket cannot create/replace multiple rooms.
4. Release the reservation exactly once on validation failure, hash failure,
   disconnect/cancel, success, or callback error.
5. Do not destroy an existing room until the replacement room is fully prepared;
   a failed hash/allocation must leave the old room usable.
6. Test concurrent near-capacity creation, same-socket duplicates, hash failure,
   disconnect, replacement failure, and event-loop responsiveness.

Acceptance: no over-admission, no leaked reservation, no synchronous scrypt, and
existing protected-room verification still uses timing-safe comparison.

## C. Token comparison and CSP

Read metrics token helper in `server.js`, host reclaim in `lib/rooms.js`, WHIP auth,
Helmet CSP, OBS WebSocket configuration, and integration tests.

Plan:

1. Extract a small shared constant-time string comparison helper. Reject empty or
   unequal-length values before `timingSafeEqual`; use it for metrics, host reclaim,
   WHIP bearer, and Packet 04 operator capability.
2. Restrict `connect-src` to `'self'` and the exact supported loopback OBS WebSocket
   endpoints/ports. If the port is configurable, construct the smallest valid list.
3. Test same-origin Socket.IO, supported OBS loopback under HTTP/HTTPS constraints,
   and rejection of an unrelated WebSocket origin.

Do not add elaborate secret types or change bearer token format/entropy.

## Verification

Run focused room/socket/WHIP/network/server tests, then lint, typecheck, complete
unit/integration, coverage, and browser media tests.

## Dispatch objective

```xml
<objective>
Implement three contained changes without refactoring socket architecture:
(A) mark browser receive transports as viewer purpose and contract-test bitrate;
(B) make protected room creation use asynchronous scrypt behind atomic capacity
and same-socket admission with exact cleanup; (C) centralize constant-time token
comparison and narrow connect-src to supported same-origin/loopback endpoints.
Complete and verify each sub-batch before starting the next.
</objective>
```
