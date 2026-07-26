# T10 — Exact-artifact release evidence

Depends on T01–T09 and decisions D01–D05. Repository automation (step A) may
proceed; steps B and C stay Blocked until a named owner supplies evidence.
Findings: CF-07, CF-19, CF-25, and the CF-15 offset measurement.

<goal>
Certify the exact signed download against the scope claimed in `README.md`.
</goal>

<read>
`.github/workflows/ci.yml`, `.github/workflows/release.yml`,
`scripts/smoke-packaged.ps1`, `scripts/benchmark-runtime.js`,
`scripts/churn-runtime.js`, and the support/limits sections of `README.md`.
</read>

<do>
A. Repository automation — do this in-repo.
1. Require delayed-relay decoded frames; restart/reclaim/admission/auth transitions;
   Chromium/Firefox/WebKit non-capture routes; tested mobile viewports; and aligned
   workflow actions. Keep codec/capture cases only on capable runners.
2. Extend packaged Windows smoke to replace the mediasoup worker, prove a short
   decoded-frame flow, close child processes, and leave no stale extraction process.
3. Keep `caxa` while these gates pass. Do not add an updater or migrate packaging.

B. Target host — the operator runs these on release hardware; never simulate them.
- Run `npm run benchmark:runtime` after 2 minutes warm-up for 10 minutes per real
  1080p/1440p/4K topology, including two rooms and two fallback pipelines; repeat
  each three times. Require ack p95 ≤100 ms, event-loop p95 ≤50 ms/max ≤200 ms,
  mediasoup CPU <80% of one core, Node CPU <100% of one core, RSS growth ≤20%,
  zero timeouts, worker deaths, restart-cap exhaustion, or unexpected disconnects.
- Run `npm run churn:runtime -- --duration-ms=1800000 --concurrency=4` for 30–60
  minutes, three times, while cycling real OBS/FFmpeg, relay generations, and
  disconnect/reconnect. Rooms/sockets return to baseline, active-resource growth
  ≤8, heap growth ≤25%, and no cycle/sample fails.
- Test LAN, public UDP, Quick Tunnel H.264 relay, strict NAT/TURN, ICE restart,
  tunnel churn, H.264/AV1, and OBS reconnect. Record hardware, OS/drivers, runtime
  versions, lock hash, topology, raw JSON, thresholds, owner, and date.

C. External owners — needs D03 and D04 people, credentials, and hardware.
1. Measure OBS fallback A/V sync at 0/500/1000/1500 ms on release hardware; use
   the smallest passing offset, align config/comments/tests, and retain evidence.
2. Build clean Windows, sign/timestamp with protected credentials, regenerate the
   checksum, produce SBOM/notices/source tag, then download to a clean VM.
3. Verify signature chain, checksum, start, Host/view flow, recovery, rollback,
   and cleanup. Obtain legal approval. Publish artifact, checksum, SBOM, support
   envelope, limitations, release notes, and rollback; retain the prior release.
</do>

<accept>
Every claimed platform/topology has retained exact-artifact evidence. Every
external approval names owner/date/artifact hash. Anything unavailable stays open.
</accept>

<checks>
For step A run `npm run release:prep`, `npm run test:e2e`, and the packaged
Windows smoke. Steps B and C are recorded evidence, not repository checks.
</checks>

<stop>
Never write a measured number you did not observe, and never mark B or C Done from
CI results. Finish step A, then keep this card Blocked with the missing owner or
hardware named.
</stop>
