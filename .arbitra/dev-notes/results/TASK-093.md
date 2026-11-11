TASK-093 (lane depack): the depacketizer now injects the cached SPS/PPS once per keyframe access unit, before its first IDR slice, and only the sets that unit does not carry in band. Verify commands, lint, typecheck and npm test (748 tests) pass.

Prompt notes:
- The access unit key is (SSRC, RTP timestamp), reset after a marker packet. pushFrames calls push(), so both paths share the one tracking; packets pushFrames skips after dropping an oversized frame never reach push(), and the next timestamp resets the unit.
- VAL-145, cited by the prompt, is a stale id (the coordinator pointed to VAL-160); the new tests cover VAL-160 through push() and pushFrames().
- Step 4 asks to inject each missing set whenever it is cached. With only a PPS cached and no SPS anywhere, the PPS is injected alone ([8, 5]); with only an SPS cached, [7, 5].
- "Log or count": a count only, exposed as the getter idrsMissingParameterSets (one per keyframe access unit left without an SPS or a PPS); nothing is logged. lib/socket.js was not changed to report it.
- Existing tests changed, as the prompt allows: the [7, 8, 5, 7, 8, 5] expectation became [7, 8, 5, 5], and the IDR in 'SPS/PPS are cached and injected before each IDR' got timestamp 3000.
- push() used to return before reading the header when a packet had no payload. It now reads the header first, so such a packet still moves the access-unit tracking (a marker on it closes the unit). Its output is unchanged (empty).
- onKeyframe is still called once per IDR NAL, not once per access unit.
