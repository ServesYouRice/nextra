# Performance & Scalability Issues

Findings on media-pipeline throughput, SFU scaling, and client render cost. Severity legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low.

**Framing.** Nextra targets "one host, a handful-to-dozens of viewers, on the host's own machine." Within that envelope it performs well and includes real backpressure/backoff engineering. The findings below matter mostly at the upper end of the configured limits (`MAX_ACTIVE_ROOMS=100`, `MAX_VIEWERS_PER_ROOM=20`) or on modest hardware.

---

## P-1 🟠 Single mediasoup worker & router for the entire process

- **Severity:** High (at scale) / acceptable (small deployments)
- **Blocker:** No (but caps real capacity well below configured limits)
- **Location:** `lib/mediasoup.js:48-70` — one `createWorker()`, one `createRouter()`; a shared `WebRtcServer` multiplexes ports (`:21-46`).

**Problem.** mediasoup workers are single-threaded C++ subprocesses; one worker uses **one CPU core**. Nextra creates exactly one worker and one router for the whole server, yet `config.MAX_ACTIVE_ROOMS` defaults to **100** and `MAX_VIEWERS_PER_ROOM` to 20 — i.e. the config invites up to ~2000 consumers routed through a single core. The shared `WebRtcServer` (`mediasoup.js:37`) correctly solves the *port-exhaustion* limit, but not the *CPU* limit.

**Why it matters.** Under real load the single worker saturates one core and adds latency/jitter to every room long before the configured room/viewer caps are reached. The published limits overstate practical capacity.

**Fix.** Scale workers to `os.cpus().length` and distribute routers/rooms across them (standard mediasoup pattern: a pool of workers, pick least-loaded per room; use `pipeToRouter` only if cross-router consumption is needed — here rooms are independent, so per-room router assignment is clean). At minimum, lower the default `MAX_ACTIVE_ROOMS` to reflect single-worker reality and document the CPU-bound ceiling.

**Related.** The worker-death auto-restart (`server.js:1049`) restarts the *whole process*; with a worker pool, a single worker death could be isolated to its rooms instead of a full restart.

---

## P-2 🟠 H.264 depacketizing + relay orchestration run on the Node main thread at up to ~45 Mbps/room

- **Severity:** High (per active OBS relay)
- **Blocker:** No
- **Location:** `lib/socket.js:732-766` (per-RTP-packet `videoConsumer.on('rtp', …)` → `H264Depacketizer.push`), `lib/h264Depacketizer.js`, FFmpeg feed `ffmpegRelay.writeVideo` (`:410`).

**Problem.** For each H.264 OBS relay, every RTP packet is delivered to the **JS event loop** via a DirectTransport consumer and depacketized in JavaScript on the main thread, then written to FFmpeg stdin. `RELAY_VIDEO_BITS_PER_SECOND` defaults to 45 Mbps (`config.js:294`) and quality tiers go to 4K. Multiple concurrent OBS relays therefore contend for the single main thread that *also* runs all Socket.IO signaling, the relay chunk fan-out (`emitToRelayViewers`), and metrics broadcasting.

**Why it matters.** Main-thread saturation degrades signaling latency (join, consume, reconnect) for *all* rooms, not just the relaying ones. The depacketizer is careful (bounded, drops frames until FFmpeg is ready) but the CPU cost is unavoidable on the main thread.

**Fix.** Move per-room relay depacketizing/muxing to Worker threads (or child processes) so media crunching doesn't block signaling. Cap the number of concurrent FFmpeg relays explicitly (there's `MAX_FALLBACK_VIEWERS` but no cap on concurrent *relay pipelines*). Measure with realistic multi-room OBS load.

---

## P-3 🟡 Relay chunk fan-out is synchronous per-viewer emits on the hot path

- **Severity:** Medium (mitigated)
- **Blocker:** No
- **Location:** `lib/socket.js:514-559` (`emitToRelayViewers` / `emitToFallbackViewers` loop and `socket.emit` per viewer), driven by `media-chunk` handler `:1849-1888` and relay `fragment` events `:954-974`.

**Problem.** Each media chunk/fragment is emitted to every relay/fallback viewer in a synchronous loop on the event loop, calling `getSocketBufferedBytes` (which walks each socket's write buffer, `:501-512`) per viewer per chunk. At 20 relay viewers × multiple chunks/sec × buffer-walk, this is O(viewers × bufferlen) work on the main thread for every chunk.

**Mitigations already present (credit).** A per-socket buffered-bytes cap kicks slow WebM viewers and skips slow fMP4 viewers (`:526,554`), oversized chunks are dropped (`:1860`), and there is a global send-buffer ceiling. These bound worst-case memory well.

**Fix.** Consider Socket.IO **rooms broadcast** (`io.to(getRelayAudienceRoom(code)).emit(...)`) instead of manual per-socket loops for the common case, falling back to per-socket only when applying the backpressure check; or sample the buffer check (every Nth chunk) rather than every chunk. Measure first — this is likely fine at ≤20 viewers.

---

## P-4 🟡 Frame-rate detection can add up to 3s of startup latency to the fallback relay

- **Severity:** Medium
- **Blocker:** No
- **Location:** `lib/socket.js:792-810` — when the host didn't supply a frame rate, the relay samples RTP timestamps for up to 3000 ms before starting FFmpeg.

**Problem.** If `room.frameRate` isn't a valid 1–120 value, startup blocks up to 3 s collecting ≥20 frame timestamps before FFmpeg starts, delaying first video for fallback viewers. The host normally *does* send `frameRate` (`HostView.jsx:1017` passes it to `create-room`), so this is the uncommon path — but any client that omits it eats the delay.

**Fix.** Start FFmpeg immediately with a sane default (30) and correct the rate on the fly if detection later disagrees, or shorten the sampling window. Since the host reliably provides fps, ensure that value is always forwarded and treat detection as a rare fallback.

---

## P-5 🟡 Metrics are broadcast to all hosts every 5s and recomputed by scanning all rooms

- **Severity:** Medium (low)
- **Blocker:** No
- **Location:** `lib/socket.js:2098-2102` (`metricsBroadcastInterval` every `METRICS_BROADCAST_INTERVAL_MS`=5000), `emitAllHostsMetrics:450-462` (iterates all rooms, prunes stale metric maps, emits per host), plus `/api/metrics` recomputes `getAllRoomStats()` on each poll (`server.js:706`), and `StatusView` polls every 5s (`StatusView.jsx:4`).

**Problem.** Every 5 s the server rebuilds per-room stats for all rooms and emits to each host; `getRoomStats` (`rooms.js:257`) itself reduces over `viewerTransports` per room. At 100 rooms this is a periodic O(rooms × transports) sweep plus N socket emits, regardless of whether anything changed. The Status page adds an HTTP recompute every 5 s per open dashboard.

**Fix.** Emit metrics on change (event-driven, already partially done via `emitHostMetrics` on join/leave/produce) and drop or lengthen the blanket 5 s broadcast; cache `getAllRoomStats()` for the poll window. Minor at small scale.

---

## P-6 🟢 Large client view components re-render broadly; some derived values recomputed every render

- **Severity:** Low
- **Blocker:** No
- **Location:** `src/HostView.jsx` (~40 `useState` hooks in one component), `src/WatchView.jsx` (~25 state hooks); derived values like `getSimulcastEncodings`, bandwidth strings, and URL builders computed inline each render.

**Problem.** `HostView` and `WatchView` are single giant components holding dozens of state atoms; any state change (viewer count tick, metrics update every 5 s, relay count) re-renders the entire subtree. Most derived values are cheap, and `useCallback`/`useRef` are used well for the media lifecycle, so this is not a runtime hazard — but the render surface is large and the components are hard to reason about (see `nice-to-haves.md` architecture section).

**Fix.** Primarily a maintainability concern; splitting into subcomponents (settings panel, room-links, metrics bar, OBS panel) would also localize re-renders. `React.memo` the metrics/viewer-count displays so the 5 s tick doesn't re-render the settings form.

---

## P-7 🟢 `probeNvenc` runs a real FFmpeg encode probe; cached, but adds first-relay latency

- **Severity:** Low
- **Blocker:** No
- **Location:** `lib/ffmpegRelay.js:33-54` — spawns FFmpeg to encode one NVENC frame (5 s timeout), cached in `_nvencProbe`.

**Problem.** The first fallback relay start pays a one-time NVENC probe (spawn + encode + up to 5 s timeout on failure) before choosing the encoder. Cached thereafter (good). On a machine without NVENC the probe waits for the process to fail/timeout, delaying the first relay.

**Fix.** Acceptable; consider kicking off the probe at server startup (fire-and-forget) so the result is warm before the first viewer needs it.

---

## Summary & priorities

| # | Issue | Severity | Notes |
|---|---|---|---|
| P-1 | Single mediasoup worker (one core) vs 100-room config | 🟠 High | Real capacity ≪ configured limits. |
| P-2 | Main-thread H.264 depacketize/relay at up to 45 Mbps/room | 🟠 High | Degrades signaling for all rooms. |
| P-3 | Per-viewer synchronous relay fan-out + buffer walk | 🟡 Medium | Mitigated by caps; fine at ≤20. |
| P-4 | Up to 3s fps-detection startup delay (uncommon path) | 🟡 Medium | Host usually supplies fps. |
| P-5 | Blanket 5s metrics recompute + broadcast | 🟡 Medium | Prefer event-driven. |
| P-6 | Giant client components re-render broadly | 🟢 Low | Maintainability > perf. |
| P-7 | First-relay NVENC probe latency | 🟢 Low | Warm it at startup. |

**Before scaling beyond a few concurrent rooms:** implement a mediasoup **worker pool** (P-1) and move relay media processing **off the main thread** (P-2). Until then, lower the default room cap to match single-worker reality and document the CPU-bound ceiling.
