TASK-040 (lane server, commit on lane/server): the public WHIP rate limiter is now an exported factory in lib/whipRoutes.js (createClientRateLimiter) that holds at most 10000 clients, sweeps expired entries once per window, evicts the oldest entry at the cap, deletes and re-inserts a key whose window reset, and buckets IPv6 clients by /64. The router's default getClientIp is proxy-aware (TRUST_PROXY hop count; CF-Connecting-IP only under TRUST_CLOUDFLARE_CONNECTING_IP), like the WHEP and socket fallbacks. Both issues fixed; 8 of 41 tests failed before. Full npm test 1294/1294, lint and typecheck clean.

VAL-055: server.js already passes getClientIp: getRequestClientIp to the public createWhipRouter, so no server.js change.

Prompt corrections and choices:
- lib/expiringTracker.js keeps one expiry time per key, no counter, so it cannot do a per-key count in a window; an extracted limiter in whipRoutes.js was used, as the prompt's step 1 allows.
- The cap is a named constant (MAX_TRACKED_RATE_LIMIT_CLIENTS = 10000), not a config key, so no config default changed. createWhipRouter takes an undocumented options.maxTrackedClients for tests, in the same way as its createWebRtcTransport option.
- Q-006 asks whether IPv6 should be bucketed by /64; it has no default. Decided yes: without it one /64 gives an attacker 2^64 addresses, each with a fresh budget, and the cap alone would only evict them. README row for PUBLIC_WHIP_RATE_LIMIT_MAX edited to say so (README.md is outside the prompt's files).
- The prompt's constraint about forwarded-IP trust is kept: lib/network.js and lib/whepRoutes.js are untouched; the WHIP fallback reuses getTrustedForwardedClientIp and resolveTrustedHopCount.
- Pruning happens on the next attempt by any address, not on a timer: a quiet server keeps at most 10000 small entries until then.
- At the cap an attacker with 10000+ distinct /64s could push a limited address out and start it afresh; that is inherent in a bound and costs the attacker that many addresses.
- Merge notes for the driver: my tests are a self-contained block at the end of tests/whipRoutes.test.js (with its own require of the new exports); lib/whipRoutes.js changes are the import lines, a block before createWhipRouter, the limiter/getClientIp lines in createWhipRouter and the module.exports block.
