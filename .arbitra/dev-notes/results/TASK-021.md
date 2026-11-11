TASK-021 (lane whip, branch lane/whip): the WHIP answer now carries a=rtcp-fb for each accepted codec. Changed files: lib/whip.js, tests/whip.test.js. 8 new tests (7 failed before the fix, 1 no-feedback guard passed before and after). Full npm test 513/513; lint and typecheck pass.

How "offered and supported" is defined (Q-002 default kept: producer configuration unchanged):
- Offered = a=rtcp-fb lines for the accepted payload type plus a=rtcp-fb:* lines of the same section. The parser now keeps '*' entries (payloadType '*'); before, its pattern only matched digits.
- Supported = the rtcpFeedback list toMediasoupRtpParameters hands to transport.produce(): the payload type's own offered feedback, plus for video the forced nack, nack pli, ccm fir. It is now built by one helper (producerRtcpFeedback) used by both the producer parameters and the answer. Its output was compared with the old code on 28 offers: identical. A '*' wildcard still does not add to the producer's feedback.
- Answer = offered AND supported, once each, in the producer's order, written after a=rtpmap and before a=fmtp (fmtp unchanged).

Consequences worth knowing:
- The forced video feedback (nack, nack pli, ccm fir) is answered only when the offer lists it for that payload type or with '*'.
- Wildcard feedback the producer is not configured for is not answered (video: transport-cc, goog-remb; audio: anything, since the audio producer carries only per-payload-type offered feedback). Answering it would claim feedback mediasoup will not act on (for example transport-cc only starts the transport-wide CC server when the producer lists it). Accepting those would need the producer configuration to change, which the prompt rules out.
- RTX payload types are never in the answer (only the accepted codec's payload type is), so no a=rtcp-fb lands on them; this is tested with an offer that has feedback on an RTX payload type.

Prompt notes: "VAL-030 and VAL-042 tests" are not existing tests; VAL-030 is covered by the new tests, VAL-042 by the full suite. Step 1 ("parse per PT, including '*', if not already parsed") was needed only for '*'; per-PT entries were already parsed.
