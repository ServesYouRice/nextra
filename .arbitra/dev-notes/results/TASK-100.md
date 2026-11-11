TASK-100 (lane libmisc): the WHEP route session tests now parse the answer SDP. Only tests/whepRoutesSession.test.js changed (116 lines added, no line removed or edited); no production file. lint, typecheck and npm test (994 tests) pass.

- Helpers: splitSdp (session lines and { mline, lines } sections, split on CRLF only), parseMline, attributeValues, directionLines, effectiveSetup (a section's own a=setup, else the session-level one).
- Success test (VAL-138): two sections in offer order, video then audio, non-zero ports, mids 0 and 1, exactly one a=sendonly each, a=ssrc:11111111 and a=ssrc:22222222, one 'a=group:BUNDLE 0 1', every a=setup 'passive' and every section has one.
- Partial-failure test (VAL-139): reads the body; two sections; video sendonly, mid 0, SSRC 11111111, passive; audio port 0, mid 1, a=inactive, no a=ssrc, no a=sendonly; 'a=group:BUNDLE 0'.
- The existing assertions (v=0, a=sendonly, status, registry, cleanup) are untouched.

No test could fail on the current code, because the defect was the missing assertions: lib/whep.js already answers a failed audio leg correctly (TASK-023 and, for a failed consume, the version before it). Proof that the new assertions bite is in results.json: seven temporary mutants of lib/whep.js pass the old test file 9 of 9 and fail the new one.

No todo case: neither C-ba70cd023811 (setup) nor C-b0c456cadccc (order/omission) shows up on the current code, so nothing was split out.

Prompt corrections:
- The prompt expects setup or order assertions may fail because of other sections' defects; on the dev lane they do not.
- 'port 0 and/or a=inactive' is asserted as both, because that is what the answer now carries (TASK-023 note). If a later item answers a rejected section with only one of them, the assertion in the partial test needs to follow.
- The assertions avoid payload types, rtcp-fb and extmap lines, so TASK-025 (payload types, whep lane) should not touch them.
