# Remaining Work

Updated: 2026-07-18.

This file contains only work that could not be completed from the repository and
local deterministic test environment. The repository-local audit backlog is
complete: browser decoded-frame/lifecycle CI, wire-level OBS protocol tests, real
mediasoup subprocess replacement, atomic session admission, lifecycle ownership,
fallback overflow recovery, tunnel supervision, and a runnable churn gate are in
place.

## 1. External release approvals

### Trusted Windows signing and clean-machine release validation

The tagged workflow requires `SIGNING_PFX_BASE64` and
`SIGNING_PFX_PASSWORD`, signs and timestamps the packaged executable, verifies
Authenticode, regenerates its checksum, and smoke-tests that exact artifact. A
repository owner must still:

- install trusted publisher signing credentials as GitHub secrets;
- run a tagged release;
- verify the publisher chain and timestamp on a clean Windows machine; and
- confirm the downloaded signed artifact passes the packaged smoke suite.

This cannot be completed locally because the trusted private certificate and
release authority are intentionally external to the repository.

### Distribution legal review

`LICENSE`, `THIRD_PARTY_NOTICES.md`, `SOURCE.md`, the packaged CycloneDX SBOM,
and automated open-source preflight are present. A qualified reviewer must approve
the final notices, corresponding-source process, dependency posture, and public
release wording.

## 2. Target-host and real-topology evidence

### Supported load envelope and event-loop decision

Run `npm run benchmark:runtime` using the matrix in
`docs/performance-benchmark.md` on the intended production hardware. Retain three
passing JSON results for the required 1080p, 1440p, and 4K topologies, including two
rooms and two active fallback pipelines.

Only introduce room-affine mediasoup workers or move relay parsing/fanout to worker
threads if those measurements breach the documented worker CPU, acknowledgement,
or event-loop thresholds and profiling attributes the breach to that component.

### Long-running live-media churn

The short real-server churn integration gate and the configurable 30–60 minute
harness are implemented. On the target host, run the procedure in
`docs/churn-suite.md` three times while also cycling:

- OBS disconnect/reconnect;
- real FFmpeg fallback start, stop, death, and replacement;
- concurrent fallback-start demand; and
- browser playback-generation replacement.

Retain the JSON evidence and host/runtime inventory. Local CI intentionally does
not claim that a short signaling/transport test proves hours-long GPU, FFmpeg, OBS,
browser, or driver stability.

### External network/media topology matrix

The local Chromium gate proves deterministic browser capture, direct WebRTC decoded
frames, viewer leave/rejoin, reload recovery, capture end, stop/unmount races, and
zero-room cleanup. The real mediasoup subprocess recovery gate proves process
replacement and restored readiness. The following still require controlled external
networks or applications:

- public direct WebRTC with production announced addresses;
- H.264 OBS/WHIP plus fMP4 fallback through the supported tunnel;
- AV1 behavior when direct media is unavailable;
- TURN/server-reflexive candidate reachability across strict NAT;
- ICE restart while the client network actually changes;
- an authorized Cloudflare TURN credential mint against the real provider; and
- the wire-level fake OBS scenarios against a supported OBS Studio release,
  especially disconnect during rollback.

## 3. Evidence- or product-triggered decisions

These are not launch defects and should not be implemented without their trigger.

- **Packaging migration:** keep the verified `caxa` Windows path until a reevaluation
  trigger in `docs/packaging-evaluation.md` occurs. A Node SEA replacement must
  first prove mediasoup/native loading, assets, child processes, signing, writable
  paths, and update behavior.
- **Multi-instance/container service:** the supported contract remains a supervised
  single replica with ephemeral sessions. External state, sticky routing, container
  networking, TURN, GPU/FFmpeg ownership, and persistence require an explicit hosted
  or “server on a box” product target.
- **Relay timestamp fidelity:** raw H.264 input currently uses a frame rate measured
  from RTP timestamps and a bounded startup-backlog correction. If field evidence
  shows A/V drift under variable source cadence or dropped frames, carry real RTP
  presentation timing through a timestamp-capable encoder input instead of assuming
  constant frame cadence.

## 4. Optional product work

No defect requires these features. They remain product choices that need scope and
acceptance criteria before implementation:

- formal WCAG AA, cross-browser, responsive, keyboard-only, and screen-reader audit;
- opt-in recording from muxed relay output;
- multiple presenters/screens per room;
- chat and reactions;
- viewer-selectable quality/latency preferences; and
- internationalized copy.

## Release condition

A public production claim still requires sections 1 and 2 to be completed. Section
3 is conditional on its stated evidence/product trigger; section 4 is optional.
