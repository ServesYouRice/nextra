# T07 — Authoritative AV1 capability

Depends on T01. The OBS audio-offset measurement is D03/T10, not this card.
Findings: CF-13, CF-14, CF-15 (code contract only; CF-15 measurement is T10).

<goal>
Use WebRTC/OBS capabilities for AV1 decisions instead of MP4 or WebGL proxies.
</goal>

<read>
`src/WatchView.jsx`, `src/lib/watchPlaybackMode.mjs`, mediasoup device loading,
`src/HostView.jsx`, `src/lib/obsWebSocket.js`, and related tests.
</read>

<do>
1. After the mediasoup device loads, derive viewer AV1 support from compatible
   `video/AV1` receive RTP capabilities. Use MSE/MP4 checks only for fMP4 relay.
2. Base warnings on room codec plus the relevant receive path and say which
   capability is missing. Test before/after device load and H.264/AV1 combinations.
3. Treat WebGL GPU detection only as an OBS encoder preference hint. For masked or
   unknown GPUs, try the bounded cross-vendor candidates through the existing
   set-and-verify transaction.
4. Let OBS verification accept a working encoder or roll back completely to a
   clear H.264 route. Test masked GPU, missing plugin, rejection, and rollback.
</do>

<accept>
MP4 support cannot falsely approve WebRTC AV1; WebGL cannot falsely block an OBS
encoder; failed AV1 setup leaves no partial settings and offers H.264 safely.
</accept>

<checks>
Run focused watch-mode, capability, and OBS WebSocket tests, then `npm test`.
</checks>

<stop>
Do not change the 1500 ms audio offset from source inspection or model judgment;
that contract needs the D03 measurement. Block if capability inspection requires
a loaded mediasoup device that no existing test harness can provide.
</stop>
