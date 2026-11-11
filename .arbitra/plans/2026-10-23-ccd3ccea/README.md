# Plan · 105 tasks for 126 issues

- Fix relay media timing/integrity, FFmpeg relay lifecycle, and network trust parsing defects
- Harden socket handlers, relay media parsing, fallback relay lifecycle, capacity probe and room membership mapping
- Fix WHIP/WHEP SDP negotiation, tunnel startup detection, startup log/exception handling, and the receive-transport departure race
- WHIP ingest correctness/lifecycle hardening and runtime benchmark/churn harness reliability
- Harden release, packaging, smoke, benchmark and brand tooling scripts
- Remediate server trust/identity, server lifecycle, host-session async teardown, and UI/client robustness issues (section plan)
- Resolve host recovery, OBS teardown, relay recorder, fMP4 relay player lifecycle, module-load storage, HowTo security copy, and video-stage sizing issues
- Client-side robustness: OBS configuration transaction, control channel, relay player queue, socket retries, chunk-reload recovery
- Section plan: viewer playback lifecycle, status polling, media-flow test lock, H.264 parameter sets, forwarded client IP, OBS auto-start/test-stream
- Close test-coverage gaps in probe, room creation, WHIP/WHEP, OBS rollback, proxy trust, test-control endpoints, and the Vite dev proxy

From arbitra run `run-ccd3ccea-5114-4101-9592-3624642a582d` (audit-deep).

Work through the prompts in the order below. Each one is self-contained: paste it into your coding agent (Claude Code, Codex or another), or follow it yourself. The folder says which kind of model each task suits.

Each defect is proven before it is fixed: a test that fails on the current code, then passes with the fix. Record each issue's result in `results.json`; arbitra reads it back and reports how many defects a failing test proved and how many were fixed.

## Answer these first

- **section-189067a43c5f50160f1b8635/Q-001**: Mediasoup consumers always send the router's payload types (and RTX payload types). JSEP/RFC 3264 expect the answerer to reuse the offer's payload types. Which remediation is acceptable for C-69cb8a77c1a9's payload-type half? Options: (a) answer with the consumer's actual router PTs, deviating from the offer's PT numbering but matching the wire, and verify browser acceptance; (b) a per-viewer router or pipe whose mediaCodecs preferredPayloadType values equal the offer's PTs (correct, but adds a router plus pipeToRouter per viewer); (c) reject or fail an offer whose PT for the selected codec differs from the router's. This changes WHEP viewer compatibility and per-viewer resource cost.
- **section-907fcaeb0abb75a2dbbcbaee/UQ-002**: When the mediasoup worker dies after minimum uptime, which recovery model should Nextra use? (a) Exit non-zero and rely on an external supervisor, consistent with the fatal path's comment. (b) Keep self-respawn but make it visible and controllable: non-detached, inherited stdio or a log file, and an exit code or supervisor opt-out so supervisors are not misled. (c) Choose (a) when a supervisor is declared (e.g. an env/config flag) and (b) otherwise. This changes behavior for packaged desktop users who launch without a supervisor.
- **section-84098610a3c7f7be0c63f39f/Q-001**: With autoStart false, should configureObsStream skip the housekeeping test stream that releases a stale encoder? The alternative is to keep it but require explicit user consent or report it. Skipping it may bring back the green-picture/stale-encoder problem the code documents. Keeping it broadcasts to the WHIP target without being asked.
- **section-49e0545c60d121dd3e784d86/Q-001**: Which deployment model defines trusted forwarded headers? Specifically: (a) should CF-Connecting-IP be honoured only when Nextra itself launched or is configured for cloudflared/Cloudflare (for example via tunnel mode or an explicit config flag), and ignored for any other loopback reverse proxy? (b) should X-Forwarded-For be read from the rightmost entry, skipping a configured count or list of trusted proxy hops? This changes operator/loopback classification and per-IP rate limiting, and it overlaps with C-70eb68e12178, C-a6ca149a0e84 and C-463b545aedba in other sections. Which section's task owns the lib/network.js change?
- **section-49e0545c60d121dd3e784d86/Q-002**: How should OBS setup release a held encoder without sending the host's current composition to the target broadcast room? Options: (a) send the encoder-reset test stream to a dedicated probe WHIP target or token that the server accepts but never forwards to viewers; (b) have the server reject or not fan out media for a probe-flagged session; (c) skip the reset when autoStart is false and report that an OBS restart may be needed, accepting the OBS crash risk the reset avoids; (d) switch OBS to a blank scene for the probe. This also overlaps with C-ac8b3a070c20 ('Configuration broadcasts even when autoStart is false') in another section. Which section owns the behavior change?

## Check these

The audit could not settle these 20 issues: the auditors disagreed, and the verifier could not decide from the code it was shown. Each prompt in `prompts/0-check-first` asks a strong model to decide whether the defect is real, by reading the code and running it where that helps, and to fix it if it is.

1. `C-c4cd10920c27` Duplicate CAXACAXACAXA delimiter appended to Windows stub corrupts self-extracting executable · critical
2. `C-131d81dff60a` isLocalHostname fails open on missing or unresolvable hostname values · high
3. `C-1784a6a1adc2` Synchronous URL revocation in downloadDiagnosticBundle aborts file downloads · high
4. `C-1c49a26cb0e4` Missing host authorization in connect-transport allows viewers to hijack or break host send transport · high
5. `C-d5509617e498` fMP4 parser discards ftyp on stream restart producing incomplete init segment · high
6. `C-7c526c849a6b` normalizeCloudflareIceServersPayload ignores object-shaped iceServers responses · high
7. `C-16669fbfe3c8` OBS profile write and encoder listing are gated only by a 'loopback' check, which local cloudflared tunnels may satisfy · high
8. `C-52a422ba4d2d` Stale or closed WHIP WebRtcTransport DTLS handler corrupts room state and triggers premature session teardown · high
9. `C-a06046ad25c1` Coverage gate calculates directory depth incorrectly causing double slashes and universal target misses · high
10. `C-bc74a9d8c883` Single-encoding video streams are severely throttled by index-based simulcast mapping · high
11. `C-e82bf68bcd5e` Shutdown transport IDs are cleaned up through the wrong event emitter · medium
12. `C-bd7abbaa0e86` Cross-worker media-flow file lock leaks its ticket when beforeEach times out, deadlocking every later test · medium
13. `C-50fb3d675546` Asynchronous Blob conversion bypasses relay generation isolation · medium
14. `C-824ecf31bbca` Audio capture is disabled in getDisplayMedia for non-Chromium browsers · medium
15. `C-c0da00822c45` Expanded OBS card is capped at max-height 46rem and clipped by clip-path, so rows can be cut off at phone widths · medium
16. `C-d1826a7c4342` SPS/PPS are injected before every IDR slice, splitting multi-slice keyframes into separate access units · medium
17. `C-dd67f45071b6` Hardcoded DTLS setup:passive in WHEP answer causes handshake deadlock when viewer offers passive · medium
18. `C-4723a43516b4` Configuration rollback restarts OBS stream after setup failure · medium
19. `C-9c4be8de5969` A new relay generation mid-playback is appended to the existing SourceBuffer without abort() or changeType() · medium
20. `C-cd64e0d537f1` Unchecked property access on socket.handshake in getSocketIp · medium

223 lower-severity issues were left unverified and are not planned; the run's issue board lists them.

## Order of work

1. `TASK-001` Re-anchor Ogg Opus granule accounting so audio survives past 2^31 RTP samples · 2-balanced-model
2. `TASK-002` Correct H.264 frame-integrity attribution on marker loss and bound reassembly memory · 2-balanced-model
3. `TASK-003` Stop caching truncated FU-A start fragments as SPS/PPS · 2-balanced-model
4. `TASK-004` Parse TRUST_PROXY hop counts only from digits-only values · 3-fast-model
5. `TASK-005` Harden forwarded-client-IP extraction (rightmost X-Forwarded-For only, no unproven CF-Connecting-IP, fail-closed sentinel) and trusted-LAN CIDR parsing · 2-balanced-model
6. `TASK-006` Make the capacity-probe token compare byte-length safe · 3-fast-model
7. `TASK-007` Guard FFmpegRelay lifecycle against resurrection after stop() and restart signal-terminated crashes · 1-strong-model
8. `TASK-008` Keep the declared GOP burst allowance until the burst is written and drained · 2-balanced-model · after TASK-007
9. `TASK-009` Fall back from NVENC to libx264 on runtime failure and probe NVENC with runtime options · 2-balanced-model · after TASK-007, TASK-008
10. `TASK-010` Normalize null/non-object socket payloads inside each handler's error protection · 2-balanced-model
11. `TASK-011` Accept only real binary media-chunk payloads and contain parser exceptions · 2-balanced-model · after TASK-010
12. `TASK-012` Limit each viewer to one live consumer per producer in consume · 2-balanced-model · after TASK-011
13. `TASK-013` Make the host send path race-safe: create-send-transport post-await check and produce replacement · 2-balanced-model · after TASK-012
14. `TASK-014` Make RoomMediaPipeline teardown release fallback resources registered while idle · 2-balanced-model
15. `TASK-015` Stop superseded startFallbackRelay calls from mutating or tearing down the current relay · 1-strong-model · after TASK-013, TASK-014
16. `TASK-016` Release held RTP packets after maxWaitMs without requiring another packet · 2-balanced-model · after TASK-015
17. `TASK-017` Bounds-check mdhd (and contain init parse errors) in relayMp4 · 3-fast-model
18. `TASK-018` Report short probe responses as failed instead of fast · 3-fast-model · after TASK-006
19. `TASK-019` Keep socket-to-room mappings and room membership consistent when sockets move or rooms are torn down · 2-balanced-model
20. `TASK-020` WHIP answer: preserve offered m-section order and count, reject unsupported sections with port 0 · 1-strong-model
21. `TASK-021` WHIP answer: emit negotiated a=rtcp-fb lines · 2-balanced-model · after TASK-020
22. `TASK-022` WHIP: propagate Opus sprop-stereo into producer rtpParameters · 3-fast-model · after TASK-021
23. `TASK-023` WHEP createViewerAnswer: do not allocate consumers to disabled or inactive offer sections · 2-balanced-model
24. `TASK-024` WHEP: negotiate only offered header extensions and feedback, with ids consistent with the consumer · 2-balanced-model · after TASK-023
25. `TASK-026` WHEP: correct H.264 profile-level-id compatibility matching · 2-balanced-model · after TASK-023, TASK-024
26. `TASK-025` WHEP: align answered payload types with the consumer's actual payload types · 1-strong-model · after TASK-024, TASK-026
27. `TASK-027` WHEP: answer DTLS setup role consistent with the offer and transport role · 2-balanced-model · after TASK-026, TASK-025
28. `TASK-028` Socket: re-validate viewer membership after create-recv-transport allocation · 2-balanced-model · after TASK-016
29. `TASK-029` Tunnel: detect the public URL across stdout/stderr chunk boundaries · 2-balanced-model
30. `TASK-030` Tunnel: report named tunnels active only after cloudflared registers a connection · 2-balanced-model · after TASK-029
31. `TASK-031` Startup logs: prune rotated generations together with their session · 2-balanced-model
32. `TASK-032` Startup runtime: no blocking dialog from uncaughtExceptionMonitor; accurate failure wording · 2-balanced-model · after TASK-031
33. `TASK-033` Correct WHIP DTLS role handling end to end: remote role in parseDtlsParameters and matching a=setup in createAnswer · 2-balanced-model · after TASK-022
34. `TASK-034` Serialize tcptype for TCP ICE candidates in WHIP answers · 3-fast-model · after TASK-033
35. `TASK-035` Reject SSRC-less WHIP offers before allocating a transport · 2-balanced-model · after TASK-034
36. `TASK-036` Generation-fence WHIP startup and producer commits; tear down on producer failure · 1-strong-model · after TASK-035
37. `TASK-037` Add ICE-consent liveness and an establishment timeout for WHIP sessions · 2-balanced-model · after TASK-036, TASK-004
38. `TASK-038` Scope H.264 SPS/PPS seed data to a single WHIP session · 3-fast-model · after TASK-036, TASK-037
39. `TASK-039` Require the host bearer token on WHIP DELETE · 2-balanced-model · after TASK-038
40. `TASK-040` Bound public WHIP rate-limit state and confirm proxy-aware client IP wiring · 2-balanced-model · after TASK-039
41. `TASK-041` Honor --allow-insecure-tls for benchmark metrics requests · 3-fast-model
42. `TASK-042` Fail closed on missing telemetry in benchmark and churn harnesses · 2-balanced-model · after TASK-041
43. `TASK-043` Guarantee harness cleanup on failure in benchmark and churn scripts · 2-balanced-model · after TASK-042
44. `TASK-044` Make the open-source preflight block nested .env files and scan every tracked file · 2-balanced-model
45. `TASK-045` Bound packager downloads with timeouts and handle response-stream failures · 2-balanced-model
46. `TASK-046` Stop staging unextracted cloudflared archives from macOS local, explicit and PATH candidates · 2-balanced-model · after TASK-045
47. `TASK-047` Pass packager command arguments on Windows without cmd.exe splitting or interpretation · 1-strong-model · after TASK-046
48. `TASK-048` Tear down benchmark clients on failure and validate topology across the whole window · 2-balanced-model · after TASK-043
49. `TASK-049` Give generate-social-card.js sole ownership of the social card and document script order · 3-fast-model
50. `TASK-050` Bound smoke HTTP calls including response-body reads · 2-balanced-model
51. `TASK-051` Prove the smoke target is the launched executable before testing or shutting it down · 1-strong-model · after TASK-050
52. `TASK-052` Make smoke cleanup ownership-scoped, enumeration fail-closed, and the shutdown stage assert process exit · 1-strong-model · after TASK-051
53. `TASK-053` Fail closed on tunnel/proxy requests in client classification and honour cf-connecting-ip only from the loopback tunnel peer · 1-strong-model · after TASK-040
54. `TASK-054` Emit upgrade-insecure-requests only when the local listener serves HTTPS · 2-balanced-model · after TASK-053
55. `TASK-055` Advertise reachable URLs for IPv6-only loopback listeners · 2-balanced-model · after TASK-054
56. `TASK-056` Return the remaining lifetime for cached Cloudflare TURN credentials · 3-fast-model · after TASK-055
57. `TASK-057` Make fatal-error handling effective during an in-progress graceful shutdown · 2-balanced-model · after TASK-056
58. `TASK-058` Make worker-crash recovery consistent with the supervisor model and stop hiding replacement failures · 2-balanced-model · after TASK-057
59. `TASK-059` Make the skip-to-content link move focus without changing the hash route · 3-fast-model
60. `TASK-060` Stop Modal focus effect from re-running on onClose identity changes · 3-fast-model · after TASK-059
61. `TASK-061` Enable real HTTP long-polling fallback for the client socket · 3-fast-model
62. `TASK-062` Extend diagnostic text sanitizer to cover the missed credential, URL and room-code formats · 2-balanced-model
63. `TASK-063` Guard handleStartSharing continuations against teardown and supersession without letting stale compensation act on a successor session · 1-strong-model
64. `TASK-064` Establish a live OBS control channel on Retry Auto-Configure and clear dead channels · 2-balanced-model · after TASK-063
65. `TASK-065` Guard fMP4 relay player init acknowledgements against stop() and give reset recovery bounded retry and timeout · 2-balanced-model
66. `TASK-066` Make non-quota append failures recover once per episode instead of re-erroring on every fragment · 1-strong-model · after TASK-065
67. `TASK-067` Stop relay live sync from overriding an intentional viewer pause · 2-balanced-model · after TASK-066
68. `TASK-068` Guard the module-scope localStorage read in HostView · 3-fast-model · after TASK-064
69. `TASK-069` Make reload-recovery reclaim tolerate transient errors and stop OBS when a stored OBS reclaim finally fails · 2-balanced-model · after TASK-068
70. `TASK-070` Keep a reclaimed room alive when Resume Sharing fails before media starts, and lock ingest mode during a pending resume · 1-strong-model · after TASK-069
71. `TASK-071` Serialize HostView OBS operations and invalidate in-flight OBS auto-configuration on teardown, compensating only for the session that still owns OBS · 1-strong-model · after TASK-070
72. `TASK-072` Restart the relay recorder after errors or unexpected stops on the VP8/fallback format · 2-balanced-model · after TASK-071
73. `TASK-073` Correct the HowTo Security and privacy claim about media encryption · 2-balanced-model
74. `TASK-074` Floor the height-bounded video-stage width so short or landscape viewports never collapse the stage · 2-balanced-model · after TASK-060
75. `TASK-075` Bound chunk-load reload recovery across page loads with a window-scoped persisted budget · 3-fast-model
76. `TASK-076` Keyframe-aware overflow drops and ack-after-accept in fMP4 relay player · 2-balanced-model · after TASK-067
77. `TASK-077` Make socketRequest retries safe for non-idempotent events · 2-balanced-model
78. `TASK-078` OBS transaction journaling: pending inverses and null-preserving profile snapshots · 2-balanced-model
79. `TASK-079` Sequence rollback safely: verified stream stop gates every later inverse, and a settle delay before restart · 2-balanced-model · after TASK-078
80. `TASK-080` Route the configuration deadline through finish so rollback runs before the socket closes · 2-balanced-model · after TASK-079
81. `TASK-081` Make openObsControlChannel().close() effective before the handshake completes · 2-balanced-model · after TASK-080
82. `TASK-082` Guarantee and verify housekeeping test-stream cleanup; gate it on autoStart per section-84098610a3c7f7be0c63f39f/Q-001 · 1-strong-model · after TASK-081
83. `TASK-083` Include the encoder-settings file in configuration rollback · 2-balanced-model · after TASK-082
84. `TASK-084` Do not auto-start OBS when a restart is required for the new output mode or encoder · 3-fast-model · after TASK-083
85. `TASK-085` Guard WatchView module-load localStorage access · 3-fast-model · after TASK-074, TASK-068
86. `TASK-086` Make StatusView metrics polling single-flight with a per-request timeout · 2-balanced-model
87. `TASK-087` Enforce playback-attempt ownership, ownership-safe relay subscription release, and exclusive recovery in WatchView · 1-strong-model · after TASK-085
88. `TASK-088` Bound WebRTC playback start with a deadline that cannot be blocked by video.play() · 2-balanced-model · after TASK-087
89. `TASK-089` Turn relay overflow and append/MSE errors into a visible, recoverable relay failure · 1-strong-model · after TASK-088
90. `TASK-090` Introduce a viewer-session generation so Leave Room cannot be undone by an in-flight reconnect · 2-balanced-model · after TASK-089
91. `TASK-091` Time-bound and session-own the fallback-consume-start acknowledgement without breaking the server's { ok } ack contract · 2-balanced-model · after TASK-090
92. `TASK-092` Replace the sorted-ticket media-flow lock with an exclusive file lock that never reclaims from a live owner · 2-balanced-model · after TASK-088
93. `TASK-093` Inject cached SPS/PPS once per IDR access unit, per missing parameter set, not before every IDR slice · 2-balanced-model · after TASK-002
94. `TASK-094` Resolve trusted client IP from proxy-appended hops and gate CF-Connecting-IP behind an explicit Cloudflare trust mode · 1-strong-model · after TASK-058, TASK-005
95. `TASK-095` Make the 'without auto-start' OBS test detect an unwanted StartStream · 3-fast-model · after TASK-084
96. `TASK-096` Stop OBS setup from broadcasting an unrequested test stream to the target room · 1-strong-model · after TASK-095, TASK-040
97. `TASK-097` Send a wrong token to the relay probe endpoint while a probe is armed · 3-fast-model · after TASK-018
98. `TASK-098` Replace the fixed 25 ms sleep in the disconnect-during-creation check with a deterministic completion wait · 2-balanced-model
99. `TASK-099` Assert that rejected WHIP starts leave the winner's claim and the pending-start slot intact · 2-balanced-model · after TASK-096
100. `TASK-100` Verify WHEP answer SDP structure in the route session tests, including the failed audio m-section · 2-balanced-model
101. `TASK-101` Stop the createViewerAnswer tests from requiring unoffered header extensions · 2-balanced-model · after TASK-027
102. `TASK-102` Test OBS rollback after a stale-stream stop or an encoder-reset test stream, and expose the withStream state · 2-balanced-model · after TASK-096
103. `TASK-103` Add multi-hop X-Forwarded-For chain cases to the server integration tests · 2-balanced-model · after TASK-057
104. `TASK-104` Add negative tests proving /api/test/* control endpoints are disabled without NEXTRA_SMOKE_TEST · 2-balanced-model
105. `TASK-105` Make Vite quick-tunnel hosts opt-in and forward client addresses through the dev/preview proxy · 2-balanced-model

## Model tiers

- `1-strong-model`: your strongest model (such as Claude Opus), for reasoning across files, or a fix that is easy to get subtly wrong.
- `2-balanced-model`: a balanced model (such as Claude Sonnet), for a contained change with a clear target.
- `3-fast-model`: a fast, inexpensive model (such as Claude Haiku), for a small, mechanical change.
