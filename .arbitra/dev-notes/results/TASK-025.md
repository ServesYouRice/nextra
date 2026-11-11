TASK-025 (lane whep, commit f320256 on lane/whep): the WHEP answer now declares the payload types the mediasoup consumer sends (RTX apt included) instead of renumbering them to the offer's. Only lib/whep.js and tests/whep.test.js changed. 17 tests failed before the fix (7 new, 10 adapted existing ones). lint, typecheck and npm test (929 tests) pass.

Decision recorded: section-189067a43c5f50160f1b8635/Q-001 = option (a), from dev-notes/answers.md (owner, October 24): answer with the consumer's actual payload types and check that browsers accept the answer.

- buildActiveSection: m-line, rtpmap, fmtp and rtcp-fb use consumer.rtpParameters.codecs as they are (payload type, parameters, apt). findOfferPt is still used, only to find the offer codec a consumer codec matches, so the rtcp-fb the offer lists under its own payload type is written under the consumer's. An offer numbered like the router gets a byte-for-byte unchanged answer (pinned by a test). TASK-024 extension handling and TASK-026 H.264 matching are untouched.
- Tests: new describe 'WHEP answer payload types follow the consumer' in tests/whep.test.js. Mock consumers (router H.264 102 + RTX 103 apt 102, opus 110) against offers numbered 96/97/111, and a collision case (the offer uses 102/103 for VP8). A second group builds the consumers with mediasoup's public ortc module ('mediasoup/ortc': generateRouterRtpCapabilities from config.MEDIA_CODECS, getProducerRtpParametersMapping, getConsumableRtpParameters, canConsume, getConsumerRtpParameters, as Transport.produce/consume do), with the codec sets and numbering of real Chromium 153 and Firefox 155 recvonly offers. VAL-034 is checked by assertAnswerUsesConsumerPayloadTypes (m-line, rtpmap, fmtp, rtcp-fb and RTX apt equal the consumer's payload types).

Existing assertions changed (VAL-042; each one expected the offer's numbering in the answer, the defect itself):
- 'answer matcher:' rows of 'table of offer vs router profile-level-id' (16 generated tests): they asserted rtpmap:96 (the offer's) for a match and rtpmap:102 (the consumer's) otherwise. The answer now always says 102, so the row shows whether the offer entry matched through feedback: the offer gets 'a=rtcp-fb:96 nack pli', the consumer codec nack pli, and the row asserts 'a=rtcp-fb:102 nack pli' exactly when it matches. 8 match rows failed before the fix.
- 'negotiates every offered extension whose id equals the router id, with consistent ids': answerFeedback(sections[1], 111) -> 110 (the audio consumer sends opus as 110; failed before).
- 'negotiates no extension for a Chrome-like offer ...': answerFeedback(sections[1], 111) -> 110 (still passed with 111, but would have checked nothing).
- 'keeps the answered payload types and codecs when extensions and feedback are filtered': audio m-line and rtpmap 111 -> 110 (failed before).

Browser check (owner's condition), lock held, own server and build (vite into the scratchpad, server.js with NEXTRA_SMOKE_TEST=1, NEXTRA_TEST_DIST_DIR, WHEP_ENABLED=true, ports from claimServerPorts), lib/whep.js before and after (the old file loaded through a -r preload). Host page through the normal UI with a canvas plus an oscillator track; VP8 is the host's default codec, H.264 was forced by hiding VP8 from the host page's offers. Viewer pages POST a recvonly offer to /whep/watch/<room>. Output: scratchpad whep-TASK-025-browser-check.txt.
- Accepted: Chromium 153 and Firefox 155 applied every answer without error (setRemoteDescription resolved, POST 201).
- Chromium playback is the same before and after, in every case. It plays when the payload type on the wire names the same codec in Chromium's own offer, and only then:
  - offer renumbered like the router: plays (VP8 100, opus 110);
  - H.264 host: plays (router 102 is H.264 42001f in Chromium's offer);
  - VP8 host (router 100 is VP9 profile 2 in Chromium's offer) and opus (router 110 is telephone-event/48000 there): nothing decoded.
- Firefox: ICE to the server's 127.0.0.1 candidate failed in this environment, even for an offer renumbered like the router (loopback prefs set), so there is no real-server media result for it. A two-peer test in one page (scratchpad whep-TASK-025-pt-experiment.txt) checked the same thing without the server, the sender really sending the router's numbers. Both browsers decode nothing when the answer's numbers differ from their offer's, whether the answer names the numbers on the wire (option a) or the offer's (old code). Chromium decodes H.264 sent as 102 because its offer has H.264 at 102.

What this means (for the owner, not changed here): browsers receive only on the payload types of their own offer, whatever the answer says. Option (a) makes the SDP match the wire and changes nothing for playback in Chromium or Firefox. Nothing that worked before stops working, and nothing that failed starts working. With the router's numbers (mediasoup's dynamic list from 100: VP8 100/101, H.264 42e01f 102/103, opus 110), a room hosted from a browser (VP8 + opus) cannot be watched over WHEP in Chromium or Firefox. An OBS H.264 room plays video in Chromium only because the numbers happen to coincide. Fixing playback needs the payload types to agree:
- option (b): a router per viewer numbering;
- option (c): reject mismatched offers with a clear 4xx instead of a silent black stream;
- pinning router preferredPayloadType values in config.MEDIA_CODECS (it can match one browser at most, VP8 96 / opus 111 for Chromium; mediasoup always assigns the RTX numbers itself, from 100 up, so RTX would still differ).

Prompt corrections:
- Source locations (lib/whep.js 345-362, 526-528) are stale after TASK-023/024/026; the code is in buildActiveSection.
- Verify suggests the Playwright media-flow suite as the browser check. That suite has no WHEP test and playwright.config.mjs starts the server with WHEP_ENABLED=false, so it cannot check WHEP; the check above was run instead (not committed, scripts in the scratchpad: whep-TASK-025-browser-check.js.txt, whep-TASK-025-pt-experiment.js.txt).
- "ask before running" node --test: not needed in a lane.

Environment note: around 19:32 the main checkout's node_modules was partly deleted (everything from a to mediasoup) and reinstalled by about 19:43, not by this lane. Tests here ran after it was back.

Left open, outside this item:
- Browser playback with mismatched payload types (above): owner decision on (b)/(c)/router numbering.
- Router RTX codecs still pass buildViewerRtpCapabilities without an apt check (TASK-026 note), so a consumer can carry an RTX the viewer offered only for another codec; the answer now declares it under its real number.
