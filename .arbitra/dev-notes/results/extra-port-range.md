extra-port-range (lane depack, not a plan issue; found while running the test suite): fixed, commit 6dfecad on lane/depack (based on dev 9561a22).

Defect: `findAvailablePort` (lib/portResolver.js) incremented its candidate with no upper bound. Near 65535 it handed 65536 to `net.Server#listen`, which throws `RangeError [ERR_SOCKET_BAD_PORT]` (the promise in `canListenOnPort` rejects with it) instead of the function's own "Could not find an available port starting at ..." error.

Proof (failed before the fix; output in the scratchpad file depack-extra-port-range-before.txt):
- `findAvailablePort ends with its own error when every port up to 65535 is reserved` (preferred 65533, reserved 65533-65535): got "options.port should be >= 0 and < 65536. Received type number (65536)".
- `findAvailablePort ends with its own error when the last port is occupied` (preferred 65535; the test binds 65535 itself, or finds it already taken): same ERR_SOCKET_BAD_PORT message.
- `findAvailablePort rejects a preferred port above 65535 as invalid`: got ERR_SOCKET_BAD_PORT, expected "Invalid preferred port: 65536".
Both end-of-range tests also record every port passed to `net.Server#listen` and assert none is above 65535. All three pass after the fix.

Fix: `MAX_PORT = 65535`; the candidate loop stops at it, so running out of range falls through to the function's own error (no wrap-around to low ports: that would return a port the caller did not ask to search near); a preferred port above 65535 is now rejected as "Invalid preferred port", like 0 or a non-number.

Existing test changed: `findAvailablePort skips occupied and reserved ports` took its listener from port 0 (Windows hands out 49152-65535). When that port was 65534 or 65535 (or 65533 with 65535 taken) the test had no free candidate above it: before the fix that was the ERR_SOCKET_BAD_PORT failure, after the fix it would be the function's own error, which is the correct behaviour but still fails the test. Changed only how the listener is obtained (`listenWithRoomAbove(100)`: draw port 0 again until at least 100 ports are left above it; rejected listeners stay open during the draw so the OS cannot return the same port, and are closed afterwards). Its assertions and the rest of the body are unchanged. The chance of 50 draws all landing in the top 100 is negligible.

Callers: the only one is `startWhipHttpServer` in server.js (preferredPort `config.WHIP_HTTP_PORT`, reserved `[config.PORT]`, maxAttempts 25), inside a try/catch that turns any error into a WHIP "error" runtime state. config.js already validates WHIP_HTTP_PORT and PORT as 1-65535, so the new "Invalid preferred port" for >65535 is unreachable from it, and the new error for running out of range is handled by the same catch as the old RangeError (only the message text differs). Nothing relied on the old behaviour; server.js is unchanged.

Checks: tests/portResolver.test.js run 10 times in a row, 5/5 each time. `npm run lint` and `npm run typecheck` clean. `npm test`: 1090 tests, 1090 pass, 0 fail.

Files: lib/portResolver.js, tests/portResolver.test.js (both CRLF, kept).
