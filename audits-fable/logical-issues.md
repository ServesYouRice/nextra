# Logical & Implementation-Quality Issues

Revalidated against the current working tree on 2026-07-13.

Legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low

---

## L-10 🟢 `getSocketBufferedBytes` reads an Engine.IO internal

- **Severity:** Low
- **Blocker:** No
- **Location:** `lib/socket.js` (`getSocketBufferedBytes`)

**Problem.** Slow-consumer protection reads `socket.conn.writeBuffer`, which the installed Engine.IO package declares as a private field. The current implementation has the expected array shape, so the cap works today, but an Engine.IO upgrade could change it. The defensive `return 0` fallback would then disable the cap silently.

**Fix.** Add a compatibility test for the installed Engine.IO version and log once if the expected field is absent. Longer term, prefer an application-owned byte counter or a supported transport-level signal.

---

## L-11 🟢 Circular module dependencies remain in media lifecycle cleanup

- **Severity:** Low
- **Blocker:** No
- **Location:** lazy `require('./whepRoutes')` calls in `lib/rooms.js` and `lib/socket.js`; `lib/whipRoutes.js` reaches relay lifecycle functions through `lib/socket.js`.

**Problem.** Lazy `require` calls avoid load-time cycles, but ownership of room, WHIP/WHEP, and fallback cleanup is split across mutually dependent modules. It works today, but makes lifecycle changes harder to reason about and test.

**Fix.** Continue extracting an idempotent room-media lifecycle/controller module that owns WHIP/WHEP/fallback teardown and is depended on by the route and socket layers.

---

## Current assessment

No launch-blocking logical defect from the original audit remains reproducible in the current tree. The two surviving items are maintainability/upgrade-hardening work, not production blockers.
