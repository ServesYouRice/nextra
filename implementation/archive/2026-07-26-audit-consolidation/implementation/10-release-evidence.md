# Packet 10 - Test depth and exact-artifact release evidence

Findings: CF-07, CF-19, CF-25. Prerequisite: all P0 code packets.

## Objective

Turn the supported release contract into retained, reproducible evidence for the
exact signed artifact. Automate what can be automated and leave credential,
legal, provider, and hardware approvals visibly open until owners complete them.

## A. Risk-based automated coverage

Read all test scripts/workflows plus `REMAINING-WORK.md`, benchmark/churn docs,
and packaged smoke/recovery scripts.

1. Keep Packet 03's delayed relay decoded-frame test as a required gate.
2. Add focused transition tests for Host/Watch restart, reconnect, passphrase
   prompt, relay generation, and terminal cleanup. Prefer pure extracted decisions
   over brittle full-component snapshots.
3. Expand targeted coverage to room admission/auth, token checks, and extracted
   lifecycle modules with realistic per-domain thresholds. Rename/report it as
   targeted coverage; do not imply repository-wide coverage.
4. Add Chromium/Firefox/WebKit non-capture route tests and tested mobile viewports.
   Keep capture/codec cases only where the runner actually supports them.
5. Extend packaged Windows evidence: kill/replace the packaged mediasoup worker,
   short decoded-frame media flow, child cleanup, shutdown, and no stale extraction process.
6. Align pinned `actions/setup-node` revisions or document a tested compatibility reason.

## B. Target-host and topology evidence

For the intended minimum/recommended host hardware, retain three passing runs of:

- 1080p/1440p/4K and 30/60 fps supported combinations;
- direct WebRTC and browser/OBS relay viewer counts up to declared limits;
- CPU/GPU/RAM, event-loop p95/max, outbound bitrate, drops, time-to-first-frame;
- 30-60 minute live churn with real OBS/FFmpeg/GPU and resource return to baseline;
- LAN, public UDP, Quick Tunnel relay, strict NAT/TURN, Cloudflare TURN mint,
  ICE restart, tunnel URL churn, H.264/AV1, OBS reconnect, and named tunnel.

Record hardware, OS/driver, Node/npm, dependency lock hash, OBS/FFmpeg/cloudflared,
network topology, raw outputs, thresholds, pass/fail, and owner/date. Publish the
measured support envelope; do not raise defaults from a single favorable run.

## C. Exact artifact and external approvals

1. Build from the reviewed lock on clean Windows CI.
2. Sign/timestamp with protected credentials; regenerate checksum after signing.
3. Generate SBOM/notices/source reference from the exact graph.
4. Download the published artifact to a clean Windows VM and verify signature,
   publisher chain, checksum, start, host/view flow, update/rollback, and uninstall/cleanup.
5. Obtain qualified GPL/third-party/privacy/terms approval and record owner/date.
6. Publish a durable release containing executable, checksum, SBOM, source tag,
   support envelope, known limitations, release notes, and rollback steps.
7. Retain prior signed artifacts. Do not build an auto-updater without a separate
   signature/consent threat model.

## Trigger-gated decisions

- Keep caxa for this release if exact-artifact tests pass. Migrate only on its
  documented security/platform trigger and full parity proof.
- Keep single replica/in-memory rooms. Do not add state infrastructure here.

## Acceptance criteria

- A fresh clone completes the complete gate on supported Linux/Windows.
- The exact signed downloadable artifact, not an unsigned precursor, passes smoke/media/recovery.
- Browser/mobile/accessibility claims match retained results or are narrowed.
- Capacity and RAM guidance come from measured runs.
- Every external approval has a named owner/date/artifact hash; open items remain blockers.

## Dispatch objective

```xml
<objective>
Build a risk-based automated and manual release-evidence chain for the exact
artifact: lifecycle/relay/auth/browser/packaged tests, target-host and topology
matrices, signed clean-machine validation, SBOM/legal records, publication, and
rollback. Automate only verifiable steps and leave unavailable external approvals
open with named requirements; never fabricate a pass.
</objective>
```
