# Open questions the plan export left out

Not blocking: each says what to assume if unanswered. The owner's answers in answers.md override any of these.

## section-03922085d60db4bdcd8f9389/Q-001 (high)

Forwarded-header trust model: when TRUST_X_FORWARDED_HEADERS is on and the peer is loopback, is it acceptable to use the rightmost X-Forwarded-For entry (the hop appended by the trusted local proxy) and use CF-Connecting-IP only when X-Forwarded-For is absent? The alternative is to honor CF-Connecting-IP only with explicit cloudflared-tunnel provenance, such as a new config flag. Default if unanswered: rightmost X-Forwarded-For, CF-Connecting-IP as fallback, and '' (untrusted) when the chosen value is not a valid IP.

## section-03922085d60db4bdcd8f9389/Q-002 (medium)

What default limits should bound H.264 reassembly? Proposed: 8 MiB per reassembled FU-A NAL, 16 MiB per access unit, and a fragment/packet count cap so empty fragments cannot grow arrays. Each limit should be overridable through constructor options. Real 4K high-bitrate keyframes must stay well under the defaults.

## section-03922085d60db4bdcd8f9389/Q-003 (low)

Malformed TRUSTED_LAN_CIDRS entries (empty prefix, '/0', non-numeric prefix) need a handling policy. Default: they fail closed at match time and never match. Alternatively, should validateConfig reject them at startup? Startup rejection is deferred unless requested, because it changes boot behavior.

## section-03922085d60db4bdcd8f9389/Q-004 (medium)

Should an NVENC runtime failure demote only the affected relay to libx264, or also the process-wide probe cache? Should the fallback restart consume FALLBACK_RESTART_CAP budget? Default: demote per relay only (session-limit exhaustion is transient), and do not count the single encoder-switch restart against the budget.

## section-03922085d60db4bdcd8f9389/Q-005 (low)

In pushFrames, a sequence gap of more than one packet can occur at a timestamp transition while the previous frame is still unterminated. In that case the lost packets cannot be attributed. Is it acceptable to flag both the pending frame and the new frame as not intact? Default: yes, because over-reporting damage only delays decoding until the next keyframe.

## section-4714b4f637d92ebf9425925d/Q-001 (medium)

When one viewer calls consume twice for the same producerId, should the server close the earlier consumer and return the new one, or reject the second request? Planned default: close and replace. A client whose first consume ack was lost (socketRequest retries) can then recover, and the count still stays at one consumer per producer per viewer.

## section-4714b4f637d92ebf9425925d/Q-002 (medium)

When the host calls produce again for a kind that already has a live producer, should the server close the previous producer (viewers then receive producer-closed and re-consume) or reject the new produce? Planned default: close the previous producer and keep the new one. This matches the existing create-send-transport behaviour, which closes old producers before replacing them.

## section-4714b4f637d92ebf9425925d/Q-003 (medium)

Should RoomMediaPipeline.own()/setTimer() reject registration while the pipeline is idle (close the resource immediately and throw), or keep accepting it and only guarantee that teardown closes it? Planned default: keep accepting it and guarantee closeFallback()/close() drain all fallback resources. Rejection happens only if a search of lib/socket.js shows no legitimate idle-time registrations.

## section-4714b4f637d92ebf9425925d/Q-004 (medium)

When joinRoom/commitRoom moves a socket that currently hosts a different live room, what should happen to that other room's host role? Planned default: the lib functions remove only prior viewer membership and keep mappings consistent. They do not destroy or transfer another room's host role, because the socket.js handlers already reject host sockets switching rooms.

## section-4714b4f637d92ebf9425925d/Q-005 (low)

Which binary forms should media-chunk accept? Planned default: Buffer, ArrayBuffer and ArrayBufferView (normalized to Buffer). Every other value, including objects with byteLength/size properties, is dropped. socket.io delivers browser Blob/ArrayBuffer payloads to Node as Buffer, so current clients should be unaffected.

## section-4714b4f637d92ebf9425925d/Q-006 (low)

The planning constraint 'audit_mode_is_read_only' is read as applying to the audit and planning phase, not to the later implementation the workflow goal ('Resolve accepted issues') asks for. If it is meant to forbid source changes entirely, every task should be executed as a report-only task.

## section-4714b4f637d92ebf9425925d/Q-007 (low)

C-a9f26790d388 also mentions that create-recv-transport stores a transport for a socket that left mid-await. This overlaps C-a6d7a1b075f4, which another section plans. If that section is dropped, should TASK-013 be extended to cover the receive path?

## section-189067a43c5f50160f1b8635/Q-002 (medium)

When a WHIP offer omits some feedback that the producer is configured with (requiredFb: nack, nack pli, ccm fir), should the producer's rtcpFeedback be narrowed to the negotiated set, or kept forced as today? Default used by TASK-021: keep producer configuration unchanged and only emit the offered-and-supported intersection in the answer.

## section-189067a43c5f50160f1b8635/Q-003 (medium)

What should count as named-tunnel readiness: a cloudflared 'Registered tunnel connection' log line, an HTTP probe of SHARE_BASE_URL, or both? Default used by TASK-030: the log line, with the existing timeoutMs deadline kept armed.

## section-189067a43c5f50160f1b8635/Q-004 (low)

Is there an existing signal (for example in server.js, which was omitted from context) marking that startup completed, so the failure dialog can distinguish a startup failure from a runtime crash? Default used by TASK-032: wording that does not claim a startup failure unless such a signal exists.

## section-189067a43c5f50160f1b8635/Q-005 (low)

For rejected m-sections in WHIP/WHEP answers, should a=mid be echoed while the mid is excluded from a=group:BUNDLE, per RFC 8843? Default used by TASK-020/TASK-023: echo a=mid when offered, emit port 0 with a=inactive, and exclude the mid from BUNDLE.

## section-f0767a79379636e542689295/Q-001 (medium)

Should SSRC-less WHIP offers be supported (parse a=extmap for urn:ietf:params:rtp-hdrext:sdes:mid, set rtpParameters.mid and headerExtensions, and echo the extmap in the answer) or rejected with a 4xx before transport creation? The recommended default is to reject. OBS declares a=ssrc, and full support would also require answer extmap changes that overlap the answer-generation work of other sections.

## section-f0767a79379636e542689295/Q-002 (medium)

When a resource metric (worker CPU, process CPU, RSS, event-loop delay, heap, libuv resources, socket/room counts) is absent, should the harness fail closed (recommended default: report null and add an explicit '<metric> unavailable' failure) or only report it as unavailable without failing? Some deployments may lack mediaWorker.resourceUsage.

## section-f0767a79379636e542689295/Q-003 (medium)

For DELETE authorization, should a missing or invalid token return 403 (consistent with the existing POST) or 401 with WWW-Authenticate (RFC 9725 style)? Are any supported WHIP clients known to omit Authorization on DELETE? The recommended default is 403 to match POST. OBS sends the bearer token on DELETE.

## section-f0767a79379636e542689295/Q-004 (low)

For offers with a=setup:passive, the faithful remote role is 'server', but the answer still emits a=setup:passive. That answer contradiction is owned by C-ba70cd023811 in another section. Should TASK-033 map passive to 'server' now (recommended default, a faithful role mapping) and leave the answer line to that section?

## section-f0767a79379636e542689295/Q-005 (low)

What timeouts should ICE-disconnect teardown and initial ICE/DTLS establishment use? The recommended default reuses config.WHIP_GRACE_TIMEOUT_MS for both, unless config.js already defines a WHIP establishment/ICE timeout. Should a new config key be introduced?

## section-f0767a79379636e542689295/Q-006 (medium)

For public WHIP rate limiting, what hard cap on tracked addresses should apply (recommended default: a named constant or config value of about 10000, with expired-entry sweeping)? Should IPv6 addresses be bucketed by /64 prefix? Does server.js already pass a trusted-proxy-aware getClientIp to createWhipRouter for the public endpoint?

## section-f0767a79379636e542689295/Q-007 (low)

Should the benchmark metrics client use an undici Agent dispatcher (only if undici is already a direct dependency) or node:http/https with rejectUnauthorized? The recommended default is node:https, which avoids a new dependency.

## section-f0767a79379636e542689295/Q-008 (low)

C-d19a51311c21 (another section) also addresses benchmark socket/ack-loop cleanup on error. Whichever change lands second must reconcile rather than duplicate. Does the joined plan order these, or should TASK-043 verify and only add the missing parts?

## section-a9280f1cb8fa879913f0582c/Q-001 (medium)

Is scripts/smoke-packaged.ps1 still invoked by any CI or release workflow, or is it retired per the T22 note in smoke-packaged.js? Should the ownership, cleanup and shutdown fixes be mirrored into it? Default: mirror the fixes only if a workflow or doc still references it; otherwise leave it unchanged and record that it is retired.

## section-a9280f1cb8fa879913f0582c/Q-002 (medium)

The media-worker recovery path replaces the server process. Per other-section issue C-d0ab9d3f522a it starts a detached child and the original exits, so on POSIX the replacement is reparented and its ancestry no longer reaches the spawned child. Is a smoke-only server endpoint that echoes a per-run nonce (passed via env) acceptable for proving ownership? Default: no server change. Prove ownership harness-side: require the port to be free before launch, verify the pre-recovery metrics PID is a descendant of the child, and adopt the post-recovery PID only when the port was continuously owned and its command line matches the same caxa build-identifier directory.

## section-a9280f1cb8fa879913f0582c/Q-003 (medium)

On macOS, should CLOUDFLARED_PATH, local and PATH candidates (a) accept only the pinned .tgz archive and extract it through the verified path, rejecting bare Mach-O binaries, or (b) be checked against a new pinned extracted-binary digest added to cloudflared-manifest.json? Default: (a), with no manifest schema change. A bare binary passed explicitly via CLOUDFLARED_PATH fails with a clear error; implicit local and PATH candidates are skipped with a log line and fall through to the verified download.

## section-a9280f1cb8fa879913f0582c/Q-004 (low)

Must every sample in the benchmark's measured window satisfy the required topology, or is a warm-up period or minimum fraction allowed? Default: every sample collected after the existing startup discard must satisfy the room, producer, consumer, relay-viewer and fallback-pipeline minimums. relayBytesForwarded stays a whole-window delta.

## section-a9280f1cb8fa879913f0582c/Q-005 (low)

Should generate-icons.ps1 stop writing nextra-social-card.png entirely, or should it invoke generate-social-card.js after producing nextra-primary-logo.png? Default: remove the social-card write and its New-ComposedLogo -UseBackground call from generate-icons.ps1, and document the required order (icons first, then social card) in both script headers.

## section-a9280f1cb8fa879913f0582c/Q-006 (low)

Besides .env.example, should other template names such as .env.sample or .env.template be allowed at any depth by the preflight env rule? Default: allow only .env.example at any depth, after confirming that no other tracked template would newly fail.

## section-907fcaeb0abb75a2dbbcbaee/UQ-001 (medium)

Should a loopback-peer request whose Host header names neither a local host nor a known share origin also be denied loopback-operator status? That would be a broader fail-closed rule than the targeted Cloudflare-evidence rule. It could break operators who browse the machine's own hostname when that name resolves to a loopback address such as 127.0.1.1, and same-host reverse proxies for custom domains that do not set X-Forwarded-For. Planned default: apply only the targeted rule (known-share host match in any scheme, plus Cloudflare evidence headers) and document that other same-host proxies must forward client IPs or use OPERATOR_TOKEN.

## section-907fcaeb0abb75a2dbbcbaee/UQ-003 (low)

What are the exact room-code alphabet and length (lib/rooms.js)? The diagnostic sanitizer needs them to redact bare room codes in contextual positions without over-redacting identifiers such as encoder names. The executor resolves this by reading lib/rooms.js.

## section-907fcaeb0abb75a2dbbcbaee/UQ-004 (medium)

Is the installed socket.io-client at version 4.8 or later, so that tryAllTransports is available? If not, should the fallback be achieved by polling-first ordering (default upgrade path) or by upgrading the dependency? Dependency upgrades are out of scope without approval.

## section-907fcaeb0abb75a2dbbcbaee/UQ-005 (low)

Should upgrade-insecure-requests be emitted per request when a request is externally HTTPS (tunnel / trusted TLS proxy) while the local listener is plain HTTP? Planned default: tie the directive to LOCAL_HTTPS and !ALLOW_INSECURE_TRUSTED_LAN_RELAY, matching the existing HSTS condition. Same-origin HTTPS tunnel pages do not need the directive.

## section-aa6945a2a9cfd7a199000015/Q-001 (medium)

The constraint 'audit_mode_is_read_only' applies to this planning run. Is a separate write-enabled execution phase authorized to apply these tasks, or should the plan be delivered as recommendations only?

## section-aa6945a2a9cfd7a199000015/Q-002 (medium)

What error shape does socketRequest (src/lib/mediasoupClient.js) produce for timeouts and disconnects, compared with a server rejection of 'reclaim-host'? In particular, does the server set terminal: true on room-gone or invalid-token rejections? This determines how TASK-069 classifies reclaim failures.

## section-aa6945a2a9cfd7a199000015/Q-003 (medium)

During a pending browser-room resume, should changing ingest mode be locked (the plan's default), or should it offer an explicit 'discard recovered room and create a new one' action?

## section-aa6945a2a9cfd7a199000015/Q-004 (low)

When a viewer resumes after an intentional pause on the relay player, should playback jump to the live edge (the plan's default, matching the live product) or continue from the paused position?

## section-aa6945a2a9cfd7a199000015/Q-005 (low)

What minimum video-stage width is acceptable on short or landscape viewports? Is a page scrollbar acceptable there instead of shrinking the stage?

## section-aa6945a2a9cfd7a199000015/Q-006 (low)

Does the server serve the LAN/local link over plain HTTP by default, or does lib/https.js enable HTTPS? The answer sets the exact wording of the corrected HowTo security section.

## section-aa6945a2a9cfd7a199000015/Q-007 (medium)

Several other-section issues overlap this section's files or behavior: C-9f1c5549a0b8 (pending sharing operations after teardown), C-3c20059705e3 (control channel close before handshake), C-646efd072238 (retry auto-configure), C-6669f71b004a (module-load localStorage read), C-bc451ddd2eaa, C-d20f555bcf10 and C-009d5a411943 (relay player failure handling). Which section owns any shared helper, such as a session guard or a safe storage accessor?

## section-aa6945a2a9cfd7a199000015/Q-008 (low)

Should the bounds for reset-recovery retries and repeated append recoveries reuse the existing requestCurrentInit retry constants and the init timeout, or are dedicated limits preferred?

## section-84098610a3c7f7be0c63f39f/Q-002 (medium)

Can the server's encoder-settings write endpoint return the previous file contents or accept a restore/undo request? Without that, the client cannot roll back the encoder file and can only correct the failure message.

## section-84098610a3c7f7be0c63f39f/Q-003 (medium)

When OBS needs a restart (mode or encoder changed) and autoStart is true, which outcome is intended? Option A: skip StartStream and return success with a restart-required flag. Option B: return success false. The default planned here is A, with an explicit restartRequired field.

## section-84098610a3c7f7be0c63f39f/Q-004 (medium)

Does the server treat create-room, join-room, reclaim-host and leave-room idempotently, for example with a client request ID? The answer decides whether to drop timeout retries for them or add an idempotency key.

## section-49e0545c60d121dd3e784d86/Q-003 (medium)

When a reconnect-triggered join completes after the user pressed Leave Room, should the client send a compensating leave-room? The server keeps a single socket-to-room mapping (see C-c40f97d49a6b), so a compensating leave could remove a newer join. Proposed default: send it only when no newer join has started since the leave.

## section-49e0545c60d121dd3e784d86/Q-004 (low)

Which timeout values should be used? Proposed defaults: 10s for the fallback-consume-start ack, 15s per metrics request (greater than the 5s poll interval), and 40s as the overall deadline for Try WebRTC and automatic recovery attempts (matching handleWatch).

## section-49e0545c60d121dd3e784d86/Q-005 (medium)

After relay playback has started, should a relay generation failure (queue overflow, SourceBuffer or MediaSource error) restart relay playback automatically once, or return to the Watch Stream overlay with the specific error? Proposed default: return to the overlay without auto-restart.

## section-49e0545c60d121dd3e784d86/Q-006 (low)

Should a QuotaExceededError on appendBuffer evict buffered media behind the playhead and retry the same chunk, or fail the relay generation? Proposed default: evict ranges older than currentTime minus 10s, retry once, then fail the generation.

## section-955d4948143d2e807b437925/Q-1 (medium)

Several corrected tests (WHEP extmap subset, WHEP answer structure and setup, XFF chain handling) may fail until other sections fix the production code (C-b5febf64d2e0, C-69cb8a77c1a9, C-b0c456cadccc, C-ba70cd023811, C-70eb68e12178, C-993924baa102). Should such tests land as node:test todo cases that name the owning issue, or be held until those fixes merge? Default in this plan: land them as todo with the issue ID, and remove the todo once the fix lands.

## section-955d4948143d2e807b437925/Q-2 (medium)

Suppose OBS was streaming healthily to its previous target (outputActive true, outputReconnecting false), setup stopped it, and setup then failed. Should rollback restart that stream? The existing transaction unit test expects StopStream to be undone with StartStream. Default in this plan: pin only the stale/reconnecting case and the encoder-reset test-stream case (both must end not streaming), and leave the healthy-live rollback behaviour unpinned.

## section-955d4948143d2e807b437925/Q-3 (medium)

Should the destructive /api/test/* endpoints also be refused when NODE_ENV or APP_ENV is 'production' even if NEXTRA_SMOKE_TEST=1 is set? Default in this plan: always assert 404 when the flag is unset. Add the production-plus-flag negative case only if the server code already gates on environment, or if the owner confirms that policy.

## section-955d4948143d2e807b437925/Q-4 (medium)

Should Cloudflare quick-tunnel hosts stay available for 'npm run dev' as an explicit opt-in environment variable? If so, what should it be called? Default in this plan: an opt-in env flag (proposed name VITE_ALLOW_QUICK_TUNNEL=true), with SHARE_BASE_URL and EXTRA_ALLOWED_ORIGINS unchanged.

## section-955d4948143d2e807b437925/Q-5 (medium)

With TRUST_X_FORWARDED_HEADERS=true and a loopback peer, how many proxy hops are trusted? Should the client address be the rightmost (proxy-appended) X-Forwarded-For entry? Default in this plan: one trusted hop, so the rightmost entry is the client. This is consistent with the cloudflared/loopback deployment and with other-section issue C-463b545aedba.

## revision-1.1/revision-1.1/PC-005-CF-FALLBACK/Q-001 (medium)

A loopback-proxied request may carry forwarding evidence (for example, CF-Connecting-IP with no X-Forwarded-For, or an invalid rightmost X-Forwarded-For) without a usable trusted client IP. TASK-005 returns the 'unknown' sentinel, which classifies as 'remote'. All such requests then share one per-IP rate-limit and connection bucket. Is that acceptable, or should these requests be rejected outright (for example, 400 or a socket disconnect)? Default if unanswered: return 'unknown' and accept the shared bucket.

## revision-1.3/revision-TASK-033/Q-001 (low)

For WHIP offers with a=setup:passive (not sent by OBS, which uses actpass), should the server answer a=setup:active and act as DTLS client (TASK-033's planned behavior, which keeps such clients working), or reject passive offers with a 4xx? Planned default: answer active. The earlier default in section-f0767a79379636e542689295/Q-004 assumed another section fixed the WHIP answer line, and that assumption does not hold.

## revision-1.4/section-a9280f1cb8fa879913f0582c/Q-EXIT-001 (medium)

During media-worker recovery on the real packaged executable, does the launched caxa stub exit when the original server hands over to its detached replacement? If so, with which exit code, and does this differ between Windows and macOS? Default if unanswered: tolerate either outcome. Treat a code-0 exit without a signal after kill-media-worker is accepted as an expected handover. Treat any other code or a signal as an unexpected failure. Recovery passes only when a replacement PID is adopted. Record the observed behaviour in the approval-gated packaged runs.

## revision-1.5/TASK-063/Q-001 (medium)

Should the server's host-stopped (and optionally create-room) handling accept an explicit room code plus host token, so that a client can stop a specific stale room even after a successor room exists on the same socket? The default if unanswered: no server change. The client serializes room requests per socket and emits unscoped host-stopped only when no successor operation exists. A room orphaned by a post-timeout late acknowledgement is left to the existing server-side room lifecycle and escalated.

## revision-1.6/TASK-071/Q-001 (medium)

HostView now serializes OBS operations within one page, so a new Start sharing may wait up to the configure connect and transaction timeouts (plus any rollback) for a previous in-flight configure. Is that wait acceptable with a visible 'waiting for previous OBS setup' status? Separately, must OBS control also be serialized across multiple tabs or windows, for example with a BroadcastChannel or Web Locks? Recommended default: accept the bounded in-page wait and leave cross-tab control out of scope, documented as a known limitation.

## revision-1.7/TASK-079/Q-001 (medium)

If a settings-restoration inverse (e.g. SetVideoSettings or SetStreamServiceSettings) is rejected during rollback, should the final StartStream inverse still be dispatched, restarting a previously live stream on partially restored settings? Default: keep the current behaviour (still dispatch it, subject to the stop gate and settle delay) and report the rejected step in the failures.

## revision-1.8/revision-49e0545c/Q-SUBSCRIPTION-TOKENS (medium)

Should relay-consume-start/stop and fallback-consume-start/stop gain an attempt-scoped token, so that the server rejects stops from non-owning attempts? This would change lib/socket.js, which these tasks do not own. Default: no protocol change. TASK-087 and TASK-091 enforce ownership with a client-side per-connection subscription ledger that relies on socket.io's in-order delivery within one connection.

## revision-1.8/revision-49e0545c/Q-DUPLICATE-START (medium)

Does the server accept a relay-consume-start or fallback-consume-start from a socket that already holds that subscription, either keeping it or replacing it, or does it reject the request? The ledger design assumes the latest start on a connection owns the subscription. Default: assume it is accepted; TASK-087 and TASK-091 escalate if the server rejects it.

## revision-1.11/section-84098610a3c7f7be0c63f39f/Q-075-STORAGE (low)

When sessionStorage is unavailable (blocked or throwing), should chunk-load recovery skip automatic reload (recommended default: fail closed, so the error reaches the app's error handling), or keep one in-memory reload per page load, which can loop forever on a persistent failure?
