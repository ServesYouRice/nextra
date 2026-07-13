# Performance & Scalability Issues

Revalidated against the current working tree on 2026-07-13.

Nextra targets one desktop process with conservative defaults: 10 rooms, 10 direct viewers per room, and at most 2 fallback pipelines. The remaining items are capacity questions that require measurement, not demonstrated launch blockers.

Legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low

---

## P-1 🟡 The supported single-worker capacity is not measured

- **Severity:** Medium at scale
- **Blocker:** No for the intended desktop posture
- **Location:** `lib/mediasoup.js` creates one worker and one router

**Problem.** All WebRTC rooms share one mediasoup worker. The repository has no load evidence showing which combinations of the current 10-room and 10-viewer limits fit within acceptable CPU, latency, and packet-loss bounds.

**Fix.** Establish a supported load envelope using the existing runtime/event-loop metrics. Add room-affine worker/router pooling only if those measurements show the single worker is the limiting resource.

---

## P-2 🟡 Relay media processing shares the signaling event loop

- **Severity:** Medium, measurement-dependent
- **Blocker:** No
- **Location:** RTP delivery and H.264 depacketization in `lib/socket.js`; parser/fanout callbacks in the same Node process

**Problem.** Each active OBS fallback pipeline delivers RTP packets to JavaScript, depacketizes H.264, feeds FFmpeg, parses fMP4 output, and fans fragments out from the same event loop that handles signaling. The new `MAX_FALLBACK_PIPELINES=2` cap bounds the number of simultaneous pipelines, but no benchmark demonstrates the signaling-latency margin at 1080p, 1440p, or 4K.

**Fix.** Measure event-loop delay and signaling latency under the two-pipeline worst case. Move depacketization/parsing/fanout to workers or a relay process only if the measured threshold is exceeded.

---

## P-7 🟢 The first fallback relay waits for an NVENC capability probe

- **Severity:** Low
- **Blocker:** No
- **Location:** `probeNvenc` in `lib/ffmpegRelay.js`

**Problem.** The first fallback relay runs a real one-frame FFmpeg/NVENC encode probe. The result is cached, but a hung or unusually slow FFmpeg can delay the first relay by up to the five-second probe timeout.

**Fix.** Start the cached probe during server startup, or expose the probe state in readiness/diagnostics, so the first viewer does not pay the cold-start cost.

---

## Current priority

Measure the supported load envelope first. P-1 and P-2 should lead to architecture work only when measurements justify it; P-7 is a small cold-start optimization.
