# TASK-018 (lane libmisc)

Blocked, nothing committed. The fix and two new tests are in the working tree of `C:\Users\V\nextra-lanes\libmisc` (branch `lane/libmisc`, base 5aa81f6).

- Existing test `a download that is over before the ramp-up means the link needs no limit` uses 10 x 1,000,000 bytes (10,000,000), which is below PROBE_BYTES (10,485,760). Under the fix it returns `failed` ("short response"). The test was not edited.
- Owner decision needed: change that fixture to a full PROBE_BYTES body (keeps 'fast'), or accept the new behaviour and change the test's expectation.
- Caller: server.js line 133. A `failed` result retries up to RELAY_PROBE_ATTEMPTS and logs a warning; `fast` logs "faster than any relay bitrate". Both leave kbps null, so the relay bitrate is the same.
