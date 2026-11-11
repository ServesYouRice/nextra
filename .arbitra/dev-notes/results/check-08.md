- [x] check 08 `C-52a422ba4d2d` Stale or closed WHIP WebRtcTransport DTLS handler corrupts room state and triggers premature session teardown: **no_change_needed** (claim does not hold; lane `lifecycle`, at dev c7489d0; nothing committed)

  - What is true in the claim: in `lib/whipRoutes.js` the POST handler's `transport.on('dtlsstatechange')` listener
    (421-535 now; 410-524 at ac1c688, the same code) checks generation and transport identity only in the
    `connected` branch (424). The `failed`/`closed` branch (516) has no such check. If it ran for a transport that
    is no longer the room's, it would set `whipReconnecting`, emit host metrics and start a grace timer that
    closes whatever session is current when it expires.
  - Why that does not happen: mediasoup never delivers a DTLS state change for a transport the server has closed.
    - `Transport.close()` removes the transport's channel subscription first, synchronously
      (`node_modules/mediasoup/node/lib/Transport.js:147`; `routerClosed()` :188 and `listenServerClosed()` :224
      do the same). `WebRtcTransport.close()` sets `dtlsState` to `'closed'` without emitting anything
      (`WebRtcTransport.js:117-128`).
    - `dtlsstatechange` comes only from the worker-notification handler (`WebRtcTransport.js:220-230`), which the
      Channel calls by handler id in a `setImmediate` (`Channel.js:304-311`). A notification still queued when the
      transport closes finds no listener.
    - Every path that drops `room.whipTransport` closes it: `closeWhipSession` (117-122, run by the replacing POST
      at 335 and by DELETE at 616), `cancelPendingStart` (269-271), the superseded check (396-399), the POST
      `catch` (573-576), the 400 for a missing fingerprint (412) and the `lib/roomLifecycle.js` fallback (25-31).
      So the only open transport with this listener is the room's current one, and for that one the grace
      path is what is meant to happen (OBS lost or closed DTLS).
  - Check: scratch probe `check-08-probe.cjs.txt` in this folder. It uses a real mediasoup 3.27.1 worker, router and
    UDP WebRtcTransports on 127.0.0.1 (port range 47000-47999), and the real WHIP router on a real HTTP server.
    It delivers DTLS states through mediasoup's own `Channel.processNotification`, as the worker would, and uses a
    150 ms grace timeout. I ran it on the lane (output `check-08-probe-output-dev-c7489d0.json`). I also ran it
    with ac1c688's `lib/whipRoutes.js`, `whip.js`, `rooms.js`, `roomMediaPipeline.js`, `sessionRegistry.js` and
    `roomLifecycle.js` written over the lane (output `check-08-probe-output-ac1c688.json`), then restored them
    with `git checkout -- lib/`. Both runs gave the same results:
    - A closed WebRtcTransport has 0 channel listeners (1 before the close), `dtlsState` is `'closed'`, and the
      only event is `observer:close`.
    - Control: a `closed` delivered to the current transport reaches the handler (reconnecting, grace timer, 1
      host-metrics call, session closed after the grace period). So the probe sees the branch when it runs.
    - Replacing POST, then `closed` and `failed` delivered to the replaced transport: nothing happens (no events,
      no timer, 0 metrics calls). The new session and its transport are still current after the grace period.
    - DELETE, then the same deliveries: nothing happens, and the session stays closed instead of becoming
      "reconnecting".
    - A `closed` notification already queued when `closeWhipSession` runs reaches nothing.
    - A client abort while `transport.connect()` is pending, with the listener already attached: no timer and no
      reconnecting state.
    - Only under the claim's premise (`close()` patched to emit `dtlsstatechange` `closed` first) does the
      replacement get a grace timer and close when it expires. mediasoup 3.27.1 does not emit that.
  - Severity: none as reported; the trigger never happens.
  - TASK-036 (whip lane): its step 7 adds a generation and transport check to this branch and the grace-timer
    callback. That stays a harmless safeguard, not a fix for something that can happen now. Its tests should not
    model a closed transport as emitting `dtlsstatechange` `'closed'`; mediasoup does not do that (the same
    fixture lesson as check 11). The aborted-startup run also shows `room.whipTransport` left pointing at the
    closed transport after `cancelPendingStart`. That is TASK-036's step 3 (`C-0114aaa7ba9b`), not this claim, so
    I left it alone.
  - Checks on the unchanged lane: `node --test tests/whipRoutes.test.js` 7/7; `npm run lint` and
    `npm run typecheck` pass; `npm test` 1080/1080.
