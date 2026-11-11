TASK-042 (lane scripts, commit e358872): the benchmark and churn harnesses no longer turn a missing resource metric into 0. Per the Q-002 default (fail closed), a missing metric is null in the summary and fails the run as "<metric> unavailable". Verify commands, lint, typecheck and npm test (523 tests) pass.

Choices the prompt left open:
- Failure wording: benchmark "event-loop p95 unavailable", "event-loop max unavailable", "media-worker CPU unavailable", "Node process CPU unavailable", "RSS growth unavailable"; churn "heap growth unavailable", "active resource growth unavailable", "rooms active after settle unavailable", "active socket growth unavailable". The existing "... exceeded" and churn limit messages are unchanged.
- rooms.active: the churn harness only uses the settled value (it is compared with a limit, not with a baseline), so only a missing settled rooms.active fails. A missing baseline rooms.active does not, because nothing reads it. VAL-058 says "baseline or settled ... rooms.active"; if the owner wants the baseline required too, it is one more field in observeChurnResources.
- A reading of 0 for the starting RSS or starting heap is treated as unavailable (growth percent needs a positive start); before it gave 0 growth. A real server never reports 0 there.
- peakHeapUsed and peakResources in the churn summary are now the largest reported value, or null when none was reported (they are informational, no limit applies).
- The shared helpers (including the churn ones) went into scripts/runtime-benchmark-model.js; cpuPercent moved there from benchmark-runtime.js so it can be unit-tested.

Prompt notes:
- The prompt's steps only name the benchmark helper evaluateResourceThresholds; the churn side needed observeChurnResources and evaluateChurnThresholds as well. Churn and benchmark are tested at harness level with fixture servers, because the defect (exit 0, pass true) only shows end to end.
- The ack p95 check stays in the script: percentile() of an empty list is still 0, so a run with zero acknowledgements is not flagged by this item (it cannot happen with --clients of at least 1).
- A run shorter than one sample interval has a single sample, so first and last are the same reading and CPU/RSS growth come out as 0 rather than null. Not changed here.
- Topology `|| 0` coercions (benchmark-runtime.js) are left alone as the constraints say; the only `|| 0` left in churn-runtime.js is the error counter.
- scripts/benchmark-runtime.js is also edited by TASK-048; expect a merge touch on the metric block and the failure checks at the end of main().

Checked the real server too: /api/metrics (test-mode server) reports mediaWorker.resourceUsage, process.cpuUsageMicroseconds, memory.rss and eventLoopDelayMs, so a benchmark against a healthy server is not made to fail by this change. The Playwright test that runs the benchmark (tests/browser/media-flow.spec.mjs) was not run.
