# T10 — Exact-artifact release evidence

Depends on T01–T09 and decisions D03–D05. Repository automation may proceed, but
external items remain Blocked until a named owner supplies evidence.

<goal>
Certify the exact signed download against the scope claimed in `README.md`.
</goal>

<automate>
1. Require delayed-relay decoded frames; restart/reclaim/admission/auth transitions;
   Chromium/Firefox/WebKit non-capture routes; tested mobile viewports; and aligned
   workflow actions. Keep codec/capture cases only on capable runners.
2. Extend packaged Windows smoke to replace the mediasoup worker, prove a short
   decoded-frame flow, close child processes, and leave no stale extraction process.
3. Keep `caxa` while these gates pass. Do not add an updater or migrate packaging.
</automate>

<target-host>
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
</target-host>

<external>
1. Measure OBS fallback A/V sync at 0/500/1000/1500 ms on release hardware; use
   the smallest passing offset, align config/comments/tests, and retain evidence.
2. Build clean Windows, sign/timestamp with protected credentials, regenerate the
   checksum, produce SBOM/notices/source tag, then download to a clean VM.
3. Verify signature chain, checksum, start, Host/view flow, recovery, rollback,
   and cleanup. Obtain legal approval. Publish artifact, checksum, SBOM, support
   envelope, limitations, release notes, and rollback; retain the prior release.
</external>

<accept>
Every claimed platform/topology has retained exact-artifact evidence. Every
external approval names owner/date/artifact hash. Anything unavailable stays open.
</accept>
