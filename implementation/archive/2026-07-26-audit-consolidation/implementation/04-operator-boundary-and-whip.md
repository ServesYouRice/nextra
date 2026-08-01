# Packet 04 - Operator boundary, LAN privilege, and WHIP admission

Findings: CF-04, CF-08, CF-09. Prerequisite: Packet 01. Use a security review call.

## Objective

Prevent public viewers from allocating host rooms or expensive WHIP work, and
separate loopback operator privileges from ordinary private-network clients.

## Read first

- socket trust/origin/client-IP construction in `server.js`
- `create-room` and rate-limit helpers in `lib/socket.js`
- `lib/network.js`, `config.js`, `.env.example`
- metrics and Cloudflare TURN routes in `server.js`
- main/dedicated WHIP mounting in `server.js`, `lib/whipRoutes.js`
- WHEP admission patterns in `lib/whepRoutes.js`
- network, real-server, WHIP, and WHEP tests

## Policy decision to record

Recommended minimal personal-product policy:

- loopback may host/administer by default;
- explicitly trusted LAN hosting is an opt-in policy, not implied by RFC1918;
- remote hosting requires a configured high-entropy operator capability;
- public viewing never receives that capability;
- the dedicated loopback WHIP listener stays available for local OBS;
- main-server/public WHIP is disabled by default and explicitly enabled/rate-limited.

Escalate if the owner wants a different remote-hosting UX. Hiding `#host` is not authorization.

## Plan

1. Centralize request/socket classification into loopback, explicitly trusted LAN,
   known public-tunnel/proxy client, and other remote. Test forwarded-header cases.
2. Add a server-side `create-room` authorization check before capacity replacement,
   passphrase hashing, media setup, or any other material allocation.
3. Support deliberate remote hosting with one install-scoped operator capability,
   compared constant-time, never logged, never placed in viewer URLs, and absent
   from unauthenticated config. Do not build accounts.
4. Default sensitive metrics and Cloudflare TURN minting to loopback. If token/LAN
   access is retained, use explicit config and the same operator boundary.
5. Split dedicated/local WHIP policy from main/public mounting. Default public
   mount off. For enabled public WHIP add per-IP window, global concurrent-start
   reservation, bounded retry response, and cleanup on every failure/cancel path.
6. Apply admission before SDP parsing/transport creation where possible. Keep
   bearer-token room ownership as a second check.
7. Add abuse tests: public create denied without destroying an existing room;
   invalid/absent operator token allocates nothing; loopback succeeds; rate limits
   release reservations; spoofed forwarded headers do not become loopback; local OBS works.
8. Update `.env.example`, README, How-To, and service docs with recovery/rotation guidance.

## Invariants

- Viewer room codes and host/operator capabilities remain separate.
- Authorization precedes rate-expensive or destructive work.
- No token appears in logs, metrics, config responses, share links, or persistent storage.
- Existing rooms are not replaced by an unauthorized `create-room` attempt.
- Failed/concurrent WHIP starts release reservations exactly once.
- Quick Tunnel viewing keeps working without host privileges.

## Acceptance criteria

- Public/tunnel client cannot allocate a room without explicit operator authority.
- Loopback default host and local OBS flows pass.
- Public WHIP is absent by default or bounded when explicitly enabled.
- LAN metrics/TURN behavior matches documented opt-in policy.
- Concurrency tests show caps cannot be bypassed by overlapping async starts.

## Dispatch objective

```xml
<objective>
Enforce the documented loopback/operator boundary before create-room and other
privileged allocation, separate ordinary LAN clients from operators, and split
local WHIP from explicitly enabled rate-limited public WHIP. Add trust-boundary,
concurrency, and no-allocation-on-denial tests without adding accounts.
</objective>
```
