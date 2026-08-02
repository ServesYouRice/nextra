# Packet 09 - LAN confidentiality, housekeeping, and operator guidance

Findings: CF-10, CF-21, CF-22. Prerequisites: Packets 01, 02, and 04.

## Objective

Close bounded operational leaks/polling waste and document the exact security and
degradation contract. Do not redesign relay fanout or the deployment architecture.

## A. LAN relay confidentiality policy

Read HTTP/HTTPS defaults, browser/fMP4 relay paths, Host/How-To/README security
claims, and service deployment docs.

Record one policy:

- trusted-home-LAN profile may allow HTTP relay with an explicit plaintext-hop warning;
- untrusted/shared-LAN profile requires local TLS/reverse proxy, or refuses relay
  from an insecure non-loopback origin unless explicitly acknowledged.

Implement only the minimum UI/config gate needed by the chosen supported profile.
Do not describe DTLS WebRTC encryption as covering Socket.IO relay payloads.

## B. Bounded cleanup and polling

1. Sweep `cloudflareTurnMintByIp` entries after their rate window in an existing
   cleanup interval; clear it on global shutdown.
2. Clear `ignoredTransportIds` during global/socket cleanup and test worker-death
   paths. Preserve the normal observer-driven delete behavior.
3. Pause Status polling while `document.hidden`; on visible, refresh immediately
   and restart one interval. Abort in-flight requests and avoid duplicate timers.
4. Skip fixed host metrics pushes when no host socket can receive them. Do not
   merge all metrics services until profiling/tests justify it.
5. Add fake-clock/cleanup tests for bounded map/set size and visibility transitions.

## C. Operator diagnostics and docs

1. Log a one-line startup notice when quick-tunnel `--no-tls-verify` is active,
   explicitly saying it affects the same-machine origin hop.
2. Add alert examples: readiness non-200, worker restart, relay restart/drop trend,
   event-loop p95 threshold derived from benchmarks, tunnel error, and disk/log state.
3. Add systemd/NSSM log rotation/retention guidance and redaction rules.
4. Warn reverse proxies not to log live WHIP/WHEP capability response headers/paths.
5. Clarify that session-scoped OBS/TURN browser storage is opt-in and where each
   credential is sent. Keep secrets out of example logs.

## Acceptance criteria

- Long-lived rate-limit/ignored-transport collections are bounded and cleared.
- Hidden Status tabs issue no periodic requests and resume exactly once.
- Metrics pushes do not run useless per-room work for absent hosts.
- LAN relay security text distinguishes WebRTC from Socket.IO relay transport.
- Tunnel TLS-bypass notice and alert/log guidance are precise and non-alarmist.

## Dispatch objective

```xml
<objective>
Implement bounded cleanup for the TURN-mint map and ignored transport IDs, pause
and correctly resume hidden-tab Status polling, skip host metrics pushes with no
receiver, and update operator guidance for LAN relay confidentiality, local
quick-tunnel TLS bypass, alerts, log rotation, capability URLs, and credential
storage. Preserve the single-node architecture and avoid metrics/fanout redesign.
</objective>
```
