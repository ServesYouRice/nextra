# Logical & Implementation-Quality Issues

Revalidated against commit `2ba6c09` on 2026-07-14.

Legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low

---

## L-10 🟢 Relay backpressure reads an Engine.IO private field

**Remediated with a compatibility guard.** The assumption is now covered against a real socket from the installed Engine.IO package. Missing or changed `writeBuffer` state emits a process-wide one-time warning instead of silently disabling protection. The implementation still observes this private field because Engine.IO exposes no supported per-socket queued-byte signal; the test and warning make that remaining upgrade dependency explicit.

- **Severity:** Low
- **Blocker:** No
- **Location:** `lib/socket.js` (`getSocketBufferedBytes`)

**Problem.** Slow-consumer protection reads `socket.conn.writeBuffer`. The installed Engine.IO version currently exposes the expected array shape, so the cap works today, but this is not a public compatibility contract. If a future upgrade changes the field, the defensive `return 0` path silently disables the protection.

**Fix.** Add a compatibility test for the installed Engine.IO version and log once when the expected field is absent. Longer term, prefer an application-owned byte counter or a supported transport signal.

---

## L-11 🟢 Media-lifecycle module ownership remains cyclic

**Remediated.** Protocol-specific WHIP/WHEP cleanup is registered with a shared room-lifecycle owner, and the WHIP route receives fallback operations through an explicit controller dependency. Room and Socket.IO teardown no longer lazily import route modules, and route modules no longer import Socket.IO, removing the lifecycle cycles while preserving protocol lookup-map cleanup.

- **Severity:** Low
- **Blocker:** No
- **Location:** lazy `require('./whepRoutes')` in `lib/rooms.js`; `lib/whipRoutes.js` reaches fallback lifecycle functions through `lib/socket.js`

**Problem.** `RoomMediaPipeline` now owns fallback startup generations, transports, consumers, FFmpeg, timers, and idempotent reverse-order cleanup. That materially improves lifecycle ownership. Room, WHIP/WHEP, and fallback cleanup still cross module boundaries through lazy/cyclic imports, making further changes harder to reason about and integration-test.

**Fix.** Continue extracting explicit lifecycle/controller dependencies so route and socket layers depend on a shared owner rather than each other.

---

## Current assessment

Both retained low-severity items are remediated. The Engine.IO field remains a documented, test-covered upgrade dependency until a supported queued-byte signal exists. No launch-blocking logical defect remains reproducible. The previously proposed WebM-init “race” is handled as a soft wait by `WatchView`, and recorder restart on a live quality change is intentional behavior rather than a logic defect. Those items are not retained as findings.
