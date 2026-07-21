# Performance Issues

Context: single Node process + single mediasoup worker + up to `MAX_FALLBACK_PIPELINES` (2) FFmpeg children. Event-loop delay is instrumented twice (global + socket-scoped), fanout paths have byte-budget backpressure, and a benchmark/churn harness exists. The remaining risks are mostly "measured envelope not yet proven on target hardware" (tracked in `REMAINING-WORK.md` §2) plus the specific items below.

---

## P-1 · Browser-relay fanout is O(viewers) buffer copies on the event loop

- **Severity:** Medium (by design; needs the documented envelope evidence)
- **Location:** `lib/socket.js:2008-2047` (`media-chunk` → `emitToRelayViewers`), per-viewer `emit` of up to 4 MiB chunks
- **Problem:** Each WebM chunk from the host is emitted individually to every relay viewer after a per-viewer `getSocketBufferedBytes` scan (which itself iterates the engine.io write buffer array per viewer per chunk). At 45 Mbps relay bitrate × N viewers this is the dominant event-loop cost. Caps exist (send-buffer kick at 16 MiB), but the CPU cost of buffer scans + emits scales linearly with viewers × chunk rate.
- **Why it matters:** Event-loop stalls degrade *all* rooms (signaling acks, RTP-adjacent timers). The repo's own docs require benchmark evidence before raising limits — that evidence is still outstanding.
- **Fix:** No code change until benchmarks breach thresholds (matching `REMAINING-WORK.md` §2 discipline). If they do: move the buffered-bytes check to a cheap counter (engine.io exposes `writeBufferSize`-ish accounting via `socket.conn.bytesWritten` alternatives), emit to the Socket.IO room (`io.to(relayRoom)`) letting the adapter serialize once instead of per-viewer emits (the per-viewer slow-consumer kick can run on a timer instead of per chunk).
- **Blocker:** No (limits are conservative: 10 viewers/room, 10 rooms).

## P-2 · Viewer transports start with host-grade initial bitrate

- **Severity:** Medium
- **Location:** `lib/socket.js:1544` / `lib/mediasoup.js:72` — see `logical-issues.md` **L-5**.
- **Impact:** Early-connection burst toward WAN viewers; congestion-control convergence pain exactly at the "first impression" moment.
- **Fix:** One-line `{ purpose: 'viewer' }`.

## P-3 · `scryptSync` on room creation blocks the loop

- See `logical-issues.md` **L-7**. ~50–100 ms stall per passphrase-protected room creation, felt by every active stream.

## P-4 · Status page and host metrics push overlapping data on two channels

- **Severity:** Low
- **Location:** `lib/socket.js:2257-2261` (5 s `room-metrics` broadcast per room) + `src/StatusView.jsx` (5 s `/api/metrics` poll) + `src/HostView.jsx:962-978` (one-shot `get-room-metrics`)
- **Problem:** Three code paths assemble nearly the same payload (see L-13). Cost is trivial at current limits; the maintenance cost is the real issue. The 5 s broadcast also runs while zero hosts are connected to receive it (`emitAllHostsMetrics` iterates rooms regardless).
- **Fix:** Skip the broadcast when a room's host socket is absent; consolidate payload builders.
- **Blocker:** No.

## P-5 · fMP4/relay memory ceilings are sane but worst-case sums deserve one line of arithmetic

- **Severity:** Informational
- **Ceilings found:** FFmpeg stdin backpressure 16 MiB (`ffmpegRelay.js:24`), pre-start buffer 12 MiB (`:431`), fallback bootstrap 32 MiB (`socket.js:773`), per-viewer socket send buffer 16 MiB (`RELAY_SOCKET_MAX_BUFFERED_BYTES`), viewer-side queues 24 MiB (WatchView) / 16 MiB (fmp4 player), Socket.IO message cap 8 MiB.
- **Worst case (server):** 10 rooms × (16 + 12 + 32) MiB pipeline buffers is impossible (2-pipeline cap ⇒ ≤ ~120 MiB), plus 100 viewers × 16 MiB send buffers ≈ 1.6 GiB *theoretical* if every viewer stalls simultaneously just under the kick threshold. In practice the kick fires and frees; still, the documented service host should have ≥ 4 GiB headroom.
- **Fix:** Add the worst-case table to `docs/performance-benchmark.md` so operators size RAM deliberately.
- **Blocker:** No.

## P-6 · Client: HostView is a 2,000-line component with ~40 state atoms

- **Severity:** Low (maintainability > runtime)
- **Location:** `src/HostView.jsx`
- **Problem:** Every socket `room-metrics` (5 s cadence) triggers up to 8 `setState` calls; React 18+ batches them, so runtime cost is fine. The real cost is comprehension: session lifecycle, OBS config, TURN modal, relay recorder, and share panel all share one closure. The lint failures (L-2) live here for a reason.
- **Fix:** When next touched, extract the OBS-config panel + BYOK modal (own state), and the relay-recorder engine (already close to standalone) into hooks/components. No urgency.
- **Blocker:** No.

## P-7 · StatusView polling in hidden tabs

- See `ui-issues.md` **U-7**.

## P-8 · Positive observations (no action)

- Event-loop delay histograms exported at both `/api/metrics` and OpenMetrics; churn suite watches `process.getActiveResourcesInfo()` for handle leaks.
- Shared WebRtcServer removes the ~100-port ceiling on concurrent transports.
- NVENC probe is warmed at startup off the hot path; encoder choice cached per relay.
- Hashed static assets served with `immutable` cache headers; HTML no-store; gzip via compression().
- Client bundle is code-split per view (largest chunk 245 KB / 77 KB gzip — acceptable for a media app; mediasoup-client dominates and is lazy-loaded only when needed).
- Relay recorder on the host restarts only on parameter change; viewer churn does not restart the encoder.
