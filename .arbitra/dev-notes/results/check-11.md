- [x] check 11 `C-e82bf68bcd5e` Shutdown transport IDs are cleaned up through the wrong event emitter: **fixed** (claim holds; lane `rooms`, at dev bfe4d26, commit 9c8408f on `lane/rooms`)

  - Verdict: holds, and held on the original code (ac1c688 has the same `transport.on('close')` listener, with
    mediasoup ^3.27.1). mediasoup 3.27.1 never emits `close` on a transport, only on `transport.observer`
    (`node_modules/mediasoup/node/lib/Transport.js` lines 177-179, 213-215, 253-255). A scratch probe with a real
    worker showed `close()` and `router.close()` reach only the observer's `close` (and `routerclose`). So every
    transport id the socket handlers marked stayed in the process-wide set until `stopJoinCleanup()` at shutdown.
  - Severity overstated: the ids are random UUIDs and never reused, so a stale entry changes nothing; it costs about
    0.5 KB per closed transport (measured) for the life of the process.
  - Fix (`lib/socket.js`, 3 lines and a comment): drop the id on `transport.observer` `close`; do not mark a
    transport that is already closed (after its router or WebRtcServer closed, no close event follows).
  - Test: new `tests/socketTransportShutdownIds.test.js`, real mediasoup worker and router (DirectTransports, so no
    ports), real socket.io server. 5 of its 6 tests failed on the unchanged code (`expected: 0, actual: 1` or `2`),
    all pass with the fix.
  - Existing tests changed: the fake transports in `tests/socketHostSendPath.test.js` and
    `tests/socketRecvTransportDeparture.test.js` emitted `close` on the transport, which mediasoup does not, so their
    "a closed transport leaves nothing in the ignore list" assertions passed only with the wrong listener. They now
    emit through an `observer` like mediasoup's; assertions unchanged. With that fixture and the old `lib/socket.js`,
    9 of their 17 tests fail.
  - Checks: lint and typecheck pass; `npm test` 999/1000. The one failure was `tests/portResolver.test.js`
    "findAvailablePort skips occupied and reserved ports" (`ERR_SOCKET_BAD_PORT` 65536: its port-0 listener got a port at the
    top of the range and the probe walked past 65535). Not related; it passed 3/3 on its own. For the owner: the test, or
    `findAvailablePort`'s missing upper bound, can fail like this whenever the OS hands out 65534 or 65535.
  - Note: while this item ran, someone ran an npm install in the main checkout (about 19:32-19:35). For a minute
    `node_modules/mediasoup` held only `worker/`, and the first run of the new test failed with "Cannot find module
    'mediasoup'". Reran after the install finished.
