# Performance and Scalability Issues

## P-1 - Browser relay fanout scales on the main event loop

- **Severity:** Medium
- **Location:** `lib/socket.js:506-588`, `lib/socket.js:2008-2047`
- **Description:** Every high-bitrate relay chunk is inspected and emitted once per relay viewer from the Node event loop. Runtime counters also multiply bytes by recipients. Slow-consumer caps prevent unbounded queues but do not remove serialization/copy and event-loop cost.
- **Why it matters for production:** At 1440p/4K bitrates, a small increase in relay viewers can consume substantial CPU and memory bandwidth, increasing signaling acknowledgements and jitter for unrelated rooms.
- **Recommended fix:** First run the required target-host matrix and profile serialization/copy costs. If thresholds fail, isolate relay fanout by room in workers/processes or use a transport designed for byte-stream fanout; preserve per-viewer backpressure and generation semantics.
- **Blocker before production:** No code blocker at the default ten-viewer limit, but target-host capacity evidence is a launch blocker.
- **Related risks/dependencies:** L-1, MAX_VIEWERS_PER_ROOM, relay buffer cap, performance benchmark.

## P-2 - Public browser relay prewarm consumes encoder and loopback bandwidth with no viewers

- **Severity:** Medium
- **Location:** `src/HostView.jsx:498-505`, `src/HostView.jsx:1032-1047`; `lib/socket.js:2008-2047`
- **Description:** When a public share URL exists without TURN, Host starts a high-bitrate MediaRecorder even at zero relay viewers and continuously sends chunks to the server. The server caches the first chunk and drops later chunks until demand.
- **Why it matters for production:** A 4K host pays continuous browser encoding, memory allocation, and Socket.IO/loopback transfer cost even if every viewer uses direct WebRTC or no viewer joins. It also contributes to the broken generation behavior in L-1.
- **Recommended fix:** Redesign prewarm around a bounded fresh initialization/keyframe artifact, or start/restart only on first actual relay demand with an explicit preparing state. Measure time-to-first-frame and CPU for both strategies.
- **Blocker before production:** No as an isolated optimization; L-1 makes the same area a blocker.
- **Related risks/dependencies:** MediaRecorder keyframe behavior, cached init compatibility, public tunnel latency.

## P-3 - Viewer transport starts with an 8 Mbps host estimate

- **Severity:** Medium
- **Location:** `lib/mediasoup.js:65-78`; `lib/socket.js:1523-1573`
- **Description:** The Socket.IO receive-transport call omits `purpose: 'viewer'`, selecting 8 Mbps instead of the designed 600 kbps viewer estimate.
- **Why it matters for production:** Initial congestion bursts and layer overshoot are most harmful at join time, exactly when remote viewers have no established bandwidth estimate.
- **Recommended fix:** Pass the viewer purpose and test the selected initial bitrate. Validate startup quality on constrained links before tuning the 600 kbps value.
- **Blocker before production:** No.
- **Related risks/dependencies:** L-3, simulcast/BWE behavior.

## P-4 - Protected room creation uses synchronous scrypt

- **Severity:** Medium
- **Location:** `lib/rooms.js:115-120`
- **Description:** `scryptSync` runs on the shared Node event loop for every protected room creation.
- **Why it matters for production:** It stalls all signaling and relay work during hashing and creates avoidable tail latency.
- **Recommended fix:** Use asynchronous scrypt behind an atomic room-capacity reservation and measure p95 acknowledgement latency under concurrent protected-room creation.
- **Blocker before production:** No under current caps.
- **Related risks/dependencies:** L-4, S-1 host authorization.

## P-5 - Status polling performs work while hidden and overlaps push metrics

- **Severity:** Low
- **Location:** `src/StatusView.jsx:40-87`; `lib/socket.js:423-474`, `lib/socket.js:2233-2248`
- **Description:** Status fetches `/api/metrics` every five seconds even in a background tab, while hosts already receive five-second `room-metrics` pushes. `/api/metrics` samples mediasoup worker usage and builds aggregate structures each time.
- **Why it matters for production:** One dashboard is cheap, but unattended tabs and multiple operators create needless worker calls and event-loop allocations on a desktop-sized server.
- **Recommended fix:** Pause or slow polling when `document.hidden`, add jitter, and expose a manual refresh. Consider one operator metrics channel if the dashboard becomes a supported remote tool.
- **Blocker before production:** No.
- **Related risks/dependencies:** Metrics authorization, operator UX.

## P-6 - Two event-loop monitors and broad per-room metrics duplicate overhead

- **Severity:** Low
- **Location:** `server.js:14-18`; `lib/socket.js:89-101`, `lib/socket.js:423-474`
- **Description:** Server and Socket modules create separate `monitorEventLoopDelay` histograms, and the socket layer rebuilds/pushes room summaries to every host on a fixed interval.
- **Why it matters for production:** The overhead is small but redundant in a process already handling media relay and signaling.
- **Recommended fix:** Own one event-loop monitor in the process metrics service and share snapshots. Emit room metrics on meaningful state changes plus a slower heartbeat unless profiling justifies five-second updates.
- **Blocker before production:** No.
- **Related risks/dependencies:** Observability design, benchmark sampling.

## P-7 - Capacity is bounded by a single Node process and one mediasoup worker

- **Severity:** Medium
- **Location:** `server.js`, `lib/mediasoup.js`, `docs/service-deployment.md`
- **Description:** All rooms share one Node event loop, one in-memory registry, one mediasoup worker, and at most the configured fallback pipelines. A worker failure or event-loop stall affects every room.
- **Why it matters for production:** Raising room/viewer limits without measurement increases a single failure domain; horizontal replicas cannot share sessions or media affinity.
- **Recommended fix:** Keep the documented one-replica limit and publish measured supported envelopes. Introduce room-affine workers/processes only after target-host profiling demonstrates a need; multi-instance hosting requires an explicit state/routing design, not merely another replica.
- **Blocker before production:** Target capacity evidence is required; architectural expansion is not.
- **Related risks/dependencies:** A-1, external benchmark/churn matrix.

## P-8 - Client and server monoliths increase performance-regression risk

- **Severity:** Low
- **Location:** `src/HostView.jsx`, `src/WatchView.jsx`, `lib/socket.js`
- **Description:** Rendering state, timers, media operations, metrics, and protocol events are coupled in very large modules. Dependency changes can recreate recorders/transports or listeners in ways that are difficult to see in review.
- **Why it matters for production:** Performance regressions often come from lifecycle churn rather than a single slow loop; L-1 is an example of an implicit generation contract split across modules.
- **Recommended fix:** Introduce measured state-machine boundaries and lifecycle tests before splitting code. Track recorder starts, transport counts, listeners, active resources, and queue high-water marks in regression tests.
- **Blocker before production:** No.
- **Related risks/dependencies:** L-10, T-4, T-6.
