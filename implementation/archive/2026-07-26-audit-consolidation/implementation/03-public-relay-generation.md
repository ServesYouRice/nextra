# Packet 03 - Repair delayed public browser-relay joins

Finding: CF-03. Prerequisite: Packet 01. Use high effort and a separate diff review.

## Objective

Give every browser-relay audience transition from zero to one a fresh recorder
generation whose initialization event and first decodable chunk cannot race the
viewer subscription. Prove a host can prewarm for minutes before a tunnel viewer
joins and still deliver decoded frames.

## Read first

- relay recorder refs/effects and `startRelayRecorder` in `src/HostView.jsx`
- `startRelayPlayback` in `src/WatchView.jsx`
- relay membership, `media-init`, `media-chunk`, and `get-media-init` in `lib/socket.js`
- room relay fields in `lib/rooms.js`
- `tests/browser/media-flow.spec.mjs`, `playwright.config.mjs`
- CF-03 detail in `audits-codex/logical-issues.md`

## Required transition contract

```text
zero viewers + prewarmed generation G
  -> first viewer subscribes and listeners are ready
  -> stale cache for G cannot be selected
  -> host starts exactly one fresh generation G+1
  -> viewer receives G+1 init before G+1 media
  -> first buffered frame decodes within the bounded timeout

one-or-more viewers + another viewer
  -> do not restart/disrupt the active generation

last viewer leaves
  -> clear audience cache; prewarm may continue without fanout
```

## Plan

1. Add a generation identifier owned by the relay recorder/server contract; do
   not rely solely on the presence of a MIME string.
2. Register viewer init/chunk listeners before the request that can trigger a
   host restart. Remove the current subscribe-before-listener race.
3. Detect the zero-to-one transition on the server and/or Host using the existing
   previous-count ref. Clear stale cached init/chunk and request exactly one fresh
   recorder generation. Include generation in events/acks.
4. Accept media only for the viewer's selected generation. Init must precede
   chunks; stale events/chunks are discarded with bounded queues.
5. Preserve active-viewer playback when a second viewer joins. Preserve zero-viewer
   prewarm only if measurements justify it; do not redesign encoding policy here.
6. Add unit/contract tests for transition ordering and a Playwright case:
   public/tunnel-origin fixture, no TURN, host starts and waits, delayed viewer
   enters relay-first, decoded-frame evidence succeeds, and cleanup returns to zero.
7. Instrument generation/start counts sufficiently for deterministic assertions,
   without exposing high-cardinality production metrics.

## Invariants

- One zero-to-one transition causes at most one restart.
- A new viewer never appends old-generation chunks after new-generation init.
- Viewer cancellation/timeouts remove listeners, timers, membership, URLs, and buffers.
- Existing viewers are not restarted by later joins.
- WebRTC and OBS/fMP4 paths are unchanged.
- A test must prove decoded media, not only event receipt or `video.src` assignment.

## Acceptance criteria

- The delayed tunnel viewer test fails before and passes after the fix.
- First frame buffers/decodes inside the documented bound.
- Concurrent/second viewer does not increment recorder generation.
- Leave/rejoin creates a fresh decodable generation without leaked resources.
- Existing direct WebRTC and relay recovery tests remain green.

## Dispatch objective

```xml
<objective>
Implement an explicit browser-relay generation handshake for the zero-to-one
viewer transition. Eliminate the listener/subscribe race, prevent stale init or
chunks from crossing generations, avoid restarting for later viewers, and add a
delayed tunnel-origin Playwright test that proves decoded frames and cleanup.
</objective>
```
