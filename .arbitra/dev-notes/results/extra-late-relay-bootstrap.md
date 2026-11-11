extra-late-relay-bootstrap (not a plan item; found while carrying out run-ccd3ccea's plan, reported by TASK-089): lane/server, from dev 80da94f. Commit: ceab946.

Verdict
- The defect as reported (a late viewer's bootstrap holds more than 240 chunks, so the client queue overflows) is NOT real. lib/socket.js buildRelayBootstrap concatenates the whole bootstrap into one Buffer (because socket.io-parser drops a packet with more than 10 binary attachments), so it enters the browser queue as one chunk. Shown by two tests that pass on the unchanged code: a socket-level test with 300 recorder chunks, and a browser test where a late relay viewer joins after the generation passed 300 chunks and plays.
- A real defect sits at the same place, in bytes. The server keeps the bootstrap up to 24 MB, the client queue's whole byte limit. The client counted the bootstrap against that limit until its append ended, together with the live chunks that arrive in the meantime. A late viewer whose bootstrap was within about one live slice of 24 MB failed at once with "Relay playback fell behind". Proven by a test that failed on the unchanged code.
- The MP4 bootstrap (init segment + current GOP) left the init segment out of the ceiling, so it could reach ceiling + init size. Proven by a test that failed on the unchanged code (25165825 bytes, marked complete).

What the brief got wrong
- "Incomplete bootstrap -> the late viewer gets a fresh recorder generation": no such path. With bootstrapComplete false, WatchView throws "Relay playback has been active too long for a safe late join. Rejoin after the current relay viewers leave." A relay-first viewer then falls back to WebRTC. A fresh generation starts only when the relay audience goes from 0 to 1 (HostView's membership effect), which is what 'delayed relay-first viewers select one fresh recorder generation...' tests: the second viewer keeps the first viewer's generation.
- The proposed fix (bound the server bootstrap by 240 chunks too) would have refused every late viewer past 72 s who plays today. It was not made. The new browser test fails if that bound is ever added.

Fix (counting the snapshot apart from the live limits; the server never sends more than the client takes)
- src/lib/relayAppendQueue.mjs: exports RELAY_QUEUE_MAX_CHUNKS (240) and RELAY_QUEUE_MAX_BYTES (24 MB), unchanged values. prepend() counts the bootstrap apart from the live limits until each of its chunks is appended. The live chunks that arrive meanwhile therefore get the full 240 / 24 MB allowance, and past it they still fail visibly as before. A bootstrap above the limits fails at once (it used to slip through until the next enqueue). prepend returns true/false. Peak memory for a late viewer during its start is now up to bootstrap + live (48 MB at most) instead of 24 MB.
- src/WatchView.jsx: only lines 31-34. The two local constants are replaced by those imports, aliased to the old names, so nothing else in the file changed.
- lib/socket.js:
  - MAX_RELAY_BOOTSTRAP_BYTES has a comment tying it to RELAY_QUEUE_MAX_BYTES.
  - The MP4 GOP bound includes the init segment. A keyframe fragment that does not fit with the init segment marks the bootstrap incomplete with an empty GOP.
  - buildRelayBootstrap sends nothing for an incomplete bootstrap, which WatchView refuses anyway. MP4 used to send init + a stale partial GOP.
  - The ceiling stays 24 MB. The client and server limits are tied together by tests: the socket test fills a WebM bootstrap to exactly RELAY_QUEUE_MAX_BYTES (complete) and one byte more (incomplete), and a unit test checks that WatchView takes its limits from relayAppendQueue.mjs.
- Why not "a bootstrap that starts at a later keyframe cluster": it would lift the WebM late-join limit itself (see below), but it needs a server-side WebM/EBML cluster parser, and keyframe intervals on the VP8 recorder (videoKeyFrameIntervalDuration is set only for MP4 today). That is a feature, not the cause of this defect.

Tests (new)
- tests/socketRelayBootstrap.test.js runs the real server with the real client queue (relayAppendQueue.mjs and its exported limits) on what a late viewer receives:
  - 'a late relay viewer starts from a bootstrap of more recorder chunks than the browser queue holds': passed before (shows the reported defect is not real).
  - 'a late relay viewer whose bootstrap is near the byte ceiling keeps the live chunks that arrive while it is appended': failed before with ['Relay playback fell behind and must be restarted.'].
  - "the server keeps a WebM relay bootstrap up to the browser queue's ceiling and no further": the tie; passed before (both 24 MB).
  - "a late MP4 relay viewer's bootstrap, init segment included, stays within the browser queue's ceiling": failed before (bytes 25165825, complete true).
  - The startRelayRoom helper now also returns room and fromHost() (it calls the server's own handler, for chunks above the test server's 1 MB Socket.IO limit). No existing assertion changed.
- tests/relayAppendQueue.test.js; all four failed before:
  - 'a bootstrap in front is counted apart from the live limits, which still apply in full while it is appended';
  - 'once its bootstrap is appended, a queue has the same live limits as any other';
  - 'a bootstrap larger than the byte ceiling ends relay playback at once';
  - 'WatchView sizes its relay queue with the limits exported next to the queue'.
- tests/browser/media-flow.spec.mjs: 'a relay viewer who joins after the generation passed 240 recorder chunks plays from its bootstrap'.
  - A test-only MediaRecorder subclass (splitHostRelayChunks) hands each 300 ms VP8 slice to HostView as 25 chunks, with the same bytes and order. That gets more than 300 chunks in about 4 s instead of 72 s.
  - The host holds its chunks while the late viewer starts and releases them in order once it plays (the third item under "For the owner" says why).
  - It passed before and after. It shows the reported defect is not real, and it guards against a chunk bound being added.

Proof files (shared scratchpad)
- server-extra-bootstrap-before-unit.txt: unchanged code, 25 tests, 6 failed as listed above. The socket tests ran as a temporary copy, tests/zz-before-socketRelayBootstrap.test.js, made by server-extra-bootstrap-before-copy.cjs. It is identical except that the limits are the literals 240 / 24 MB, WatchView's values at 80da94f, because the unchanged relayAppendQueue.mjs exports none. The copy was deleted after the run.
- server-extra-bootstrap-before-e2e.txt: the first version of the browser test (no hold) on unchanged source, 1 passed.
- server-extra-bootstrap-before-e2e-final.txt: the final test on the 80da94f lib/socket.js, WatchView.jsx and relayAppendQueue.mjs, written over the lane's files and restored afterwards, 3/3 passed.
- server-extra-bootstrap-probe.cjs: the probe (300 chunks -> bootstrapChunks.length 1).
- server-extra-bootstrap-after-unit.txt: socketRelayBootstrap + relayAppendQueue + socketMediaChunk, 32/32.
- server-extra-bootstrap-after-repeat.txt: the final browser test with --repeat-each=20, 20/20.
- server-extra-bootstrap-after-media-flow.txt: the whole media-flow spec (run-e2e.cjs on the lane's ports, --workers=1), 22/22.
- server-extra-bootstrap-diag-repeat.txt: the test without the hold plus a frame probe, --repeat-each=20. The one failure had 25 chunks between the two acknowledgements; the 19 passes had 0.
- server-extra-bootstrap-npmtest.txt: npm test 1482/1482. npm run lint and npm run typecheck were clean.

For the owner (not changed here)
- Late VP8 relay joins are refused once a generation passes 24 MB, by design. That is about 5-24 s at the 8-36 Mbps relay tiers, longer for a static screen. There is no path that gives such a viewer a fresh generation. In a long VP8 stream (a Firefox host, or after relay-mp4-failed), every late relay viewer is refused; relay-first viewers fall back to WebRTC. MP4 hosts are not affected (init + current GOP).
- The server's slow-consumer cap (RELAY_SOCKET_MAX_BUFFERED_BYTES, 16 MB) is below the 24 MB bootstrap ceiling. The bootstrap goes out in the start acknowledgement, so it sits in the viewer's send buffer when the first live chunk is checked against the cap 300 ms later. Expected on Linux/macOS servers: Node counts an unfinished write in full, so a late viewer whose bootstrap is above about 16 MB, on a link that cannot take it in about 300 ms, is dropped with "Relay connection is too slow". This could not be shown on this Windows machine. On loopback the kernel accepts a single 24 MB write at once, even with the reader paused (server-extra-bootstrap-loopback*.cjs), so the server sees nothing buffered. The same treatment as the client (allow the bootstrap on top of the cap until the buffer first drains) would fix it.
- A real defect, seen in a browser run (not fixed: it is in WatchView, which TASK-090 is editing).
  - What happens: WatchView drops the live chunks that arrive between the relay-consume-start acknowledgement and the get-media-init answer, because selectedGeneration is still null. For a late WebM viewer that leaves a hole between the bootstrap and the live stream. The viewer plays the bootstrap, then fails with "The browser could not read the relay stream".
  - Evidence: the first full media-flow run failed on the new test this way. A frame probe over 20 repeats (server-extra-bootstrap-diag-repeat.txt) gave 1 failure, and it had 25 chunks (one whole recorder slice) between the two acknowledgements; the 19 passes had none.
  - How often: about one round trip in 300 ms per late join, so rare on a LAN and frequent through a tunnel, which is where relay-first viewers are.
  - Possible fix: the start acknowledgement carries room.mediaGeneration and WatchView selects it as soon as the acknowledgement arrives.
  - The new browser test avoids this by holding the host's chunks during the late viewer's start.
