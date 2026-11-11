# extra-doc-followups (lane server, from dev e22cd41)

Three documentation and copy corrections that turned up while carrying out the plan (not plan items). One commit on `lane/server`, `docs:` message. No test failed before: they are wording changes, so there was nothing to prove first.

1. Security wording (README.md, src/App.jsx). Both made the old blanket claim; both now follow the HowTo wording that TASK-073 put in src/HowToView.jsx.
   - README.md "Security and Privacy", first bullet: "WebRTC viewing, OBS WHIP ingest and WHEP playback are encrypted in transit with DTLS-SRTP. Relay media travels over the page connection and is encrypted only as far as that connection is: public links use HTTPS that ends at the tunnel provider, so relay media is not end-to-end encrypted to the host, and a local link is plain HTTP unless `LOCAL_HTTPS=true`".
   - src/App.jsx landing footer: "WebRTC media is encrypted in transit; relay media is encrypted only as far as the page connection is. Media is not stored by Nextra."
   - Checked against the code: lib/whipRoutes.js, lib/whepRoutes.js and lib/socket.js all create their transport with createWebRtcTransport (lib/mediasoup.js, mediasoup WebRtcTransport, DTLS-SRTP); lib/tunnel.js starts cloudflared with `--url <protocol>://127.0.0.1:<port>`, so the public HTTPS ends at the tunnel provider; `LOCAL_HTTPS` defaults to false (config.js), README table says the same.
   - Tests: nothing pinned the footer text (grep over tests/ for the footer and for "encrypted in transit" finds only tests/howToSecurityCopy.test.js, which reads HowToView.jsx only). No test changed.
   - Not changed: the code comment at server.js ~1498 ("Media is still encrypted via DTLS/WebRTC", about WHIP over HTTP) is accurate for the WHIP media path and is a comment, not copy.

2. README benchmark section (line ~481).
   - Code now: scripts/runtime-metrics-client.js builds the benchmark's /api/metrics requests with node:https and `rejectUnauthorized: !allowInsecureTls` per request (no process-wide setting, as its header comment says); scripts/benchmark-runtime.js passes `rejectUnauthorized: !allowInsecureTls` to the Socket.IO client and records `tlsVerificationDisabled: allowInsecureTls` in the result. So `--allow-insecure-tls` covers both, and `NODE_TLS_REJECT_UNAUTHORIZED=0` is not needed.
   - scripts/churn-runtime.js has no `--allow-insecure-tls`: its metrics call is the global `fetch` and its Socket.IO client sets no `rejectUnauthorized`, so it always verifies the certificate. The sentence now says so (use a plain `http://` URL or a certificate the machine trusts). I did not add the flag to the churn script: that is a behaviour change, not a documentation correction.
   - The last sentence said the JSON result records when "Socket.IO TLS verification" was disabled; it now says "TLS verification" (the field is `measurement.tlsVerificationDisabled`).
   - Left alone: tests/browser/media-flow.spec.mjs still sets `NODE_TLS_REJECT_UNAUTHORIZED: '0'` next to `--allow-insecure-tls` when it runs the benchmark. It is now redundant for the benchmark; harmless, and a Playwright spec, so not touched.

3. lib/h264Depacketizer.js, `opts.onKeyframe` docstring. It now says: called once per IDR NAL unit emitted, so once per slice (a multi-slice keyframe calls it several times, it is not a keyframe counter), no caller passes it, and the relay gets the per-frame keyframe flag from pushFrames. Checked: the only constructor call in lib/ (lib/socket.js ~1344) passes sps and pps only; grep finds no other `onKeyframe` in the repository; the call site is inside `_depacketize`, on each IDR NAL (type 5), reached from both push() and pushFrames(). Only the comment changed; behaviour is unchanged.

Checks (lane server): `npm run lint` clean, `npm run typecheck` clean, `npm test` 1272/1272 pass. The three touched-area test files (h264Depacketizer, howToSecurityCopy, benchmarkRuntime) 68/68 on their own.
