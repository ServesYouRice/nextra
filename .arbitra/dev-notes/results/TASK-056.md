TASK-056 (lane server): cached Cloudflare TURN credential responses now advertise the remaining lifetime. server.js stores the absolute credential expiry (mint time + ttlSeconds) next to the existing cache-window end, and a cache hit returns a copy of the stored payload with ttlSeconds = max(1, floor(remaining / 1000)). The stored payload is not mutated. Verify: `node --test tests/turnCredentialCache.test.js` (new, fails before, passes after), lint, typecheck and `npm test` (729 tests) pass.

Prompt notes:
- The prompt's "seam to stub fetchCloudflareTurnCredentials" does not exist in server.js (it destructures the import at load time). The test instead starts the real server with CLOUDFLARE_TURN_API_BASE_URL (an existing config setting) pointed at a local fake endpoint that counts mints. No code was added for the seam.
- The mint rate limit (10 s per client) runs before the cache check, so the test waits 10.5 s before the cache-hit request. The cache window at ttl 120 is 60 s. The test takes about 12 s.
- The new test is a new file, tests/turnCredentialCache.test.js, not an addition to tests/serverIntegration.test.js (the TURN settings need their own env). It takes its ports from claimServerPorts().
- Not changed: lib/cloudflareTurn.js, lib/expiringTracker.js, the cache window policy, the rate limit, the origin/authorization order, and Cache-Control: no-store.
- The optional expiresAt field was not added (prompt step 3 said to prefer not changing the shape).
