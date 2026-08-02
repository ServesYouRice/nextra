# Packet 11 - Triggered maintainability and polish backlog

Findings: CF-23 and CF-24. Prerequisite: P0/P1 behavior is green and protected by tests.

## Objective

Address low-risk UX and ownership debt in small behavioral batches. This packet
is not permission for a broad HostView/WatchView/socket rewrite.

## Batch 1 - Small UX fixes

- On an expected passphrase-required response, preserve the room code, show
  informational rather than generic failure tone, reveal/focus the labelled
  passphrase field, and keep anti-enumeration behavior.
- Add a small mapper for known `getDisplayMedia`, timeout, transport, and abort
  errors; show friendly action plus separately available technical detail.
- Track `fullscreenchange` and expose Enter/Exit plus pressed state, or remove the
  redundant custom button after confirming native controls are sufficient.
- Correct Status denied copy: in-app dashboard is local-only unless a real secure
  operator-token UI exists; do not tell users to use an unavailable token flow.
- Consolidate the duplicate 400 px CSS blocks and add representative viewport assertions.
- Change OBS status live-region markup only if Packet 08's manual AT evidence reproduces a miss.

Each item should have a focused test and may be a separate commit.

## Batch 2 - Safe deduplication

After behavioral coverage exists:

- extract one shared `formatBytes` with tests for B/KB/MB/GB;
- extract one room-metrics payload builder and test both push and request paths;
- remove the identical fMP4 buffer eviction function while preserving call sites;
- simplify the identical `parseUrlHostParts` branch;
- consolidate share-base resolution only if forwarded-header/security tests cover all callers.

Do not mix deduplication with functional remediation.

## Batch 3 - Incremental lifecycle ownership

Use the transition fixtures from Packets 03 and 05:

1. Extract relay generation/recorder ownership first.
2. Extract Host and Watch reconnect/terminal decision functions next.
3. Split server socket domains only one seam at a time: admission/auth, WebRTC
   transports, browser relay, OBS fallback, media control, metrics.
4. For every extraction, name the owner of timers/listeners/resources and prove
   idempotent enter/exit plus no behavior change.
5. Consider shared runtime Socket.IO schemas/protocol version only before clients
   and servers can deploy independently; avoid adding a schema stack prematurely.

## Post-blocker product candidates

Suitable only as separate product proposals: host preflight, stable named-tunnel
onboarding, redacted diagnostic bundle, measured capacity/headroom, viewer copy-link,
and clearer room/link lifetime. Keep PWA, recording, chat/reactions, multiple
presenters, E2EE, accounts, database/Redis, multi-replica, and packager migration
trigger-gated outside this remediation.

## Acceptance criteria

- Each batch is independently reviewable and behavior-tested.
- No abstraction is introduced for a one-time operation.
- Timer/listener/resource ownership becomes clearer and leak tests stay green.
- No product-scope item is smuggled into a refactor or polish commit.
- Full release and browser gates remain green after every batch.

## Dispatch objective

```xml
<objective>
Execute only one named batch/item from this deferred packet. Preserve behavior,
add a focused regression, and avoid adjacent cleanup. For lifecycle extraction,
move one ownership seam at a time and prove timer/listener/resource cleanup. Stop
if the requested item lacks the prerequisite tests or product decision.
</objective>
```
