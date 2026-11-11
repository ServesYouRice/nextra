TASK-013 (lane socket): create-send-transport and produce are now race-safe in lib/socket.js. Verify commands pass; lint, typecheck and npm test (510 tests) pass.

Prompt corrections:
- tests/socketHostSendPath.test.js is listed under read_first but did not exist; it was created (10 tests, 8 fail on the unchanged code, the 2 "keep true" tests pass before and after).
- The verify line says to ask before running `node --test tests/socketHostSendPath.test.js`; the brief tells the lane agent to run the item's files, so it was run.
- "the socket is disconnected" needs socket.connected, not only findRoomByHost: a host that disconnects keeps its room during the reconnect grace, so findRoomByHost(socket.id) still returns the room. The produce check follows the prompt (hostTransport identity and findRoomByHost only); a produce that finishes on the still-current transport after a disconnect is kept, because a plain (non-reload) reclaim keeps the host's media.
- create-send-transport attaches its transport state handlers before the stale check, so the close event clears the transport from the ignored-transport list (checked by the tests through getIgnoredTransportCount).
- The pre-await close of producers and transport was moved into a small helper, closeHostSendPath(room), reused for the raced transport; behaviour of the non-overlapping call is unchanged.
- A refused stale produce is not counted as published (no activeProducerIds entry, no new-producer); producersCreated still counts it, since mediasoup did create it.
