# Long-running churn / leak suite

This procedure exercises the destroy path as hard as the create path. Over a long
run it repeatedly creates and tears down rooms, host/viewer sockets, and mediasoup
send/recv transports, samples `/api/metrics` throughout, and fails if resource
usage does not return to a stable baseline after the churn settles. It targets
REMAINING-WORK.md T-07.

The harness (`scripts/churn-runtime.js`, `npm run churn:runtime`) drives the
signalling/room/transport churn that a plain Node runtime can exercise
deterministically. Media-driven churn — OBS reconnect, fallback pipeline
start/stop, and playback-generation replacement under live media — needs a real
media runtime and remains target-host gated; run it against a live topology
alongside this suite when certifying a host.

## What it measures

`/api/metrics` exposes `process.resources.total` and a `process.resources.byType`
breakdown from Node's stable `process.getActiveResourcesInfo()`, alongside
`process.memory` (heap/RSS), `rooms.active`, and `sockets.counters.activeSockets`.
The harness records a baseline after warm-up, churns for the configured duration,
waits `--settle-ms` for the server to reclaim resources, then compares a settled
sample against the baseline.

## Acceptance thresholds

After the settle window, all of the following must hold (defaults; override on the
command line only against a documented objective):

- rooms still active returns to baseline (`--max-room-residual=0`);
- Socket.IO connections return to the connected-pool baseline (`--max-socket-growth=0`);
- active libuv resources grow by no more than `--max-resource-growth=8` handles
  from baseline (covers leaked timers, sockets, and child processes);
- heap grows by no more than `--max-heap-growth-percent=25%` from baseline;
- at least one churn cycle completed.
- no churn cycle or metrics sample failed.

Heap comparison is noisier than handle/room/socket comparison because the harness
cannot force a server-side GC over HTTP. Keep the run long, keep `--settle-ms`
generous, and treat a repeated multi-run heap climb — not a single sample — as the
leak signal. Handle, room, and socket residuals are the hard leak gates.

## Procedure

1. Start a dedicated Nextra test instance on the target host with production
   media/admission limits, but raise the per-IP create/join abuse throttles so the
   local harness itself is not rejected. These two overrides affect request rate,
   not concurrent room/viewer capacity:

   ```powershell
   $env:CREATE_ROOM_RATE_LIMIT_MAX='100000'
   $env:JOIN_RATE_LIMIT_MAX='100000'
   npm start
   ```
2. If certifying media churn as well, bring up a live OBS/browser topology and,
   during the run, cycle OBS reconnects, fallback start/stop, and playback
   generations by hand or with the media test rig.
3. Run the harness from the same LAN (use the local host for the baseline):

   ```powershell
   npm run churn:runtime -- --url=http://127.0.0.1:3000 --duration-ms=1800000 --concurrency=4
   ```

   For a 30–60 minute soak, set `--duration-ms` to 1800000–3600000.

4. Save the JSON output with host CPU/GPU, OS, Node/FFmpeg versions, and the
   topology cycled during the run.
5. Repeat three times. The suite passes only if all three runs pass; a heap or
   handle count that climbs monotonically across the three runs is a leak even if
   any single run is under threshold.

Set `METRICS_TOKEN` in the harness environment when sampling a deliberately remote
metrics endpoint. The endpoint should otherwise remain local.

## Architecture decision

T-07 stays open until the procedure has been run on the target host and its JSON
evidence retained. Repository support — the runnable harness, the active-resource
metrics it asserts against, and this procedure — is complete.
