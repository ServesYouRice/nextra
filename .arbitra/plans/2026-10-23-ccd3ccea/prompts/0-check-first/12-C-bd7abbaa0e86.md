# Check C-bd7abbaa0e86 · Cross-worker media-flow file lock leaks its ticket when beforeEach times out, deadlocking every later test

Suggested model: your strongest model (such as Claude Opus), effort high. Why: the audit could not settle this by reading alone.

You are a careful senior engineer checking one reported defect in this repository before anyone fixes it. Several models audited the project; they disagreed about this one, and arbitra's verifier could not decide from the code it was shown. The report may be wrong, so treat it as a claim to test, not a fact.

<claim>
Cross-worker media-flow file lock leaks its ticket when beforeEach times out, deadlocking every later test (medium)

beforeEach writes a ticket file and then spins in an unbounded for(;;) loop until its ticket sorts first. The ticket path is only recorded in loopbackProxyState after the lock is acquired and the proxy is listening. The wait runs inside beforeEach, so it counts against the test timeout. When that timeout fires, Playwright abandons the hook promise instead of throwing into it, so the catch block that removes the ticket never runs. afterEach then sees loopbackProxyState === null and returns without deleting the ticket. The orphaned ticket has an older timestamp than any ticket created later. Once the current holder releases, every later media-flow test in every worker and project waits on the orphan until it times out, and each of those leaks its own ticket in turn. A worker killed mid-test (max-failures, SIGINT, crash) leaves a stale ticket the same way. The lock directory is hard-coded to cwd/test-results instead of the configured outputDir, so it is only cleaned between runs if outputDir happens to be the default.
</claim>

<steps>
1. Read the code the claim names, and what it calls, until you can say whether the claim holds.
2. Where reading cannot decide it, run the smallest check that can: an existing test, a short script, or the command the claim depends on. Ask before running anything that changes data or reaches the network.
3. If the claim does not hold, change nothing and say why, citing the lines or the output that decide it.
4. If it holds, make the smallest fix, add a test that fails without it, and run the project's checks.
</steps>

<success_criteria>
- A clear verdict, holds or does not hold, with the lines or output that decide it.
- If it holds: the fix and its test, with the project's checks passing.
</success_criteria>

When you finish, record the result in results.json (`no_change_needed` when the claim does not hold), and report the verdict, what you changed, and how you checked it.
