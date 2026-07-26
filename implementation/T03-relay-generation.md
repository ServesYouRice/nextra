# T03 — Delayed H.264 relay generation

Depends on T01. This is a concurrency-sensitive card; use a stronger review if
the ownership point remains ambiguous after reading the named files.

<goal>
A first relay viewer joining minutes after host prewarm receives a fresh,
decodable generation without disrupting viewers already watching.
</goal>

<read>
`src/HostView.jsx`, `src/WatchView.jsx`, `lib/socket.js`, `lib/rooms.js`,
`tests/browser/media-flow.spec.mjs`, and relay unit tests.
</read>

<contract>
- Zero to one viewers: listeners ready → one fresh generation → init before media.
- Another viewer: reuse the active generation; do not restart it.
- Last viewer leaves: clear audience cache; no stale generation may be selected.
</contract>

<do>
1. Add one generation ID owned by the recorder/server relay contract.
2. Register viewer listeners before the request that can trigger a restart.
3. On zero-to-one, clear stale cache and start exactly one new generation.
4. Accept init/chunks only for the selected generation; bound and clean queues,
   listeners, timers, membership, buffers, and object URLs on every exit.
5. Add ordering/concurrency tests and a delayed relay-first Playwright case that
   proves a decoded frame, leave/rejoin, and zero-resource cleanup.
</do>

<accept>
One zero-to-one transition produces one restart; later joins produce none; stale
chunks never cross generations; direct WebRTC and existing relay recovery pass.
</accept>

<checks>
Run focused relay tests, `npm test`, and `npm run test:e2e`.
</checks>
