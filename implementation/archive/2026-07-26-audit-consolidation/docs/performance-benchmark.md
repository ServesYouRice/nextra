# Runtime capacity benchmark

This procedure turns the conservative room/viewer limits into a host-specific, reproducible measurement. It does not synthesize media: establish the real media topology first, then run the signaling and metrics sampler against it.

## Acceptance thresholds

For a 10-minute steady-state run after a 2-minute warm-up:

- local signaling acknowledgement p95 must remain at or below 100 ms, with zero timeouts;
- event-loop delay p95 must remain at or below 50 ms and observed max at or below 200 ms;
- mediasoup worker CPU must remain below 80% of one core;
- total Node CPU must remain below 100% of one core;
- RSS must not grow by more than 20% from the first steady-state sample;
- no mediasoup worker death, fallback restart-cap exhaustion, or unexpected viewer disconnect is acceptable.

These are the default interactive-service thresholds in the harness. Change them explicitly on the command line only when the deployment has a documented service-level objective.

## Procedure

1. Start Nextra on the target host with production settings and leave admission limits at their defaults.
2. Create the topology being certified with real browsers/OBS. For P-1, step through room and direct-viewer combinations up to the intended limit. For P-2, run two simultaneous H.264 OBS fallback pipelines at each supported resolution/profile and attach relay viewers.
3. Wait two minutes for encoder, JIT, and media buffers to settle.
4. Run the sampler from the same LAN (use the local host for the baseline):

   ```powershell
   npm run benchmark:runtime -- --url=http://127.0.0.1:3000 --duration-ms=600000 --clients=10
   ```

   For the P-2 gate, make the topology assertion explicit so an accidentally idle relay cannot produce a passing result:

   ```powershell
   npm run benchmark:runtime -- --url=http://127.0.0.1:3000 --duration-ms=600000 --clients=10 --require-rooms=2 --require-fallback-pipelines=2
   ```

5. Save the JSON output with the host CPU/GPU, OS, Node/FFmpeg versions, stream resolution/frame rate/bitrate, room count, and viewer topology.
6. Repeat each topology three times. The supported envelope is the largest topology for which all three runs pass. Do not raise defaults from a single run.

Set `METRICS_TOKEN` in the harness environment when sampling a deliberately remote metrics endpoint. The benchmark endpoint should otherwise remain local. The harness uses `get-rtp-capabilities` acknowledgements, so it exercises the real Socket.IO request/response path without mutating rooms.

## Architecture decision

N-17 remains closed as “no worker pool yet” while the default topology passes and worker CPU stays below threshold. Introduce room-affine workers/routers only when worker CPU breaches first or worker failure isolation becomes a stated requirement.

N-18 remains closed as “keep relay work in-process” while two fallback pipelines meet acknowledgement and event-loop thresholds. Move depacketization/parsing/fanout only when those thresholds fail and profiling attributes the failure to relay JavaScript work.
