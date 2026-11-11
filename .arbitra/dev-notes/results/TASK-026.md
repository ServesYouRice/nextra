TASK-026 (lane whep): WHEP now matches H.264 on the parsed profile in both places. lib/whep.js and tests/whep.test.js only. 46 new tests failed before the fix. lint, typecheck and npm test (793 tests) pass.

- New helpers in lib/whep.js, exported: parseH264ProfileLevelId (undefined and '' are 42e01f; exactly six hex digits; profile from profile_idc plus the profile-iop bit pattern table; returns { profile, level }), isSameH264Profile (both parse, same profile, level ignored) and isH264Compatible (same profile and same packetization-mode, absent = 0). findOfferPt and buildViewerRtpCapabilities both call isH264Compatible; the slice(0, 2) comparisons are gone.
- buildViewerRtpCapabilities hands mediasoup the viewer's own H.264 parameters: profile-level-id (lower-cased, 42e01f when absent), packetization-mode and level-asymmetry-allowed (only when the viewer listed it), one entry per distinct parameter set. rtcpFeedback is computed per entry from that entry's own payload types plus the wildcard (with one parameter set it is the same union as before).

Two decisions the prompt left open:
- packetization-mode and level-asymmetry-allowed are written as numbers. The prompt only says "carry the viewer's"; the parsed fmtp holds strings, but mediasoup's matchCodecs compares `capability['packetization-mode'] || 0` with `!==` against the producer's codec parameters, which lib/whip.js stores with Number(). With '1' instead of 1 the real ortc.canConsume returns false (checked), so a string would have rejected every H.264 viewer.
- parseH264ProfileLevelId also rejects a level_idc mediasoup's h264-profile-level-id does not know (anything other than 1, 1.1, 1b, 1.2, 1.3, 2, 2.1, 2.2, 3, 3.1, 3.2, 4, 4.1, 4.2, 5, 5.1, 5.2), as mediasoup does, so WHEP admission equals what consume() accepts. Level otherwise never decides a match. Consequence worth knowing: a browser that offers a level above 5.2 (for example 64003c, level 6) has that entry ignored, exactly as mediasoup would ignore it; its other entries still match.

Prompt corrections:
- VAL-145 is a stale id (a forwarded-header assertion of another item); the assertion for this item is VAL-147, and VAL-035 (42001f default) is superseded by it. Worked to VAL-147.
- The prompt's source quotes (lib/whep.js 309-310, 514-515) are stale after TASK-023/024; the code is in findOfferPt and in the matchedViewerCodecs filter of buildViewerRtpCapabilities (renamed from `matched` by TASK-024).
- "ask before running" the node --test command: not needed in a lane; run as the brief says.

Edits to existing tests: none. tests/whep.test.js gained only a wider require of ../lib/whep, a require of ../config, and the new describe block at the end.

Left open, outside this item:
- Router RTX codecs pass through buildViewerRtpCapabilities without an apt check (unchanged).
- A viewer offer that lists a router H.264 profile only at a level mediasoup cannot parse (above 5.2) gets no H.264 capability; that mirrors mediasoup.
