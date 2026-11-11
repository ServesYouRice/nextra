- [x] check 20 `C-cd64e0d537f1` Unchecked property access on socket.handshake in getSocketIp: **no_change_needed** (claim does not hold; lane `socket`, at dev bfe4d26)

  - What is true in the claim: `lib/socket.js:275`, `return normalizeIp(socket.handshake.address || 'unknown')`,
    has no optional chaining, while lines 264-269 use it. It would throw a TypeError if `handshake` were missing.
  - Why that is not a defect. Nextra never passes `getSocketIp` a socket without `handshake`:
    - socket.io always builds `handshake` in the Socket constructor, before middleware or `connection` handlers
      run: `node_modules/socket.io/dist/socket.js:121` (4.8.4) sets `this.handshake = this.buildHandshake(auth)`,
      with `address: this.conn.remoteAddress`. The optional chaining on lines 264-269 is defensive style. It does
      not show that `handshake` can be absent.
    - The running server does not use `getSocketIp` at all. `server.js:1597` passes
      `getClientIp: getSocketHandshakeIp`, and `lib/socket.js:1797-1799` falls back to `getSocketIp` only when no
      `getClientIp` is given. That happens only in tests that call `registerSocketHandlers` directly.
    - If a hand-made socket did lack `handshake`, both call sites (`create-room` at 1843, `join-room` at 2021) are
      inside `try`/`catch`. The handler answers `Internal error`. The process does not crash.
  - Check: the scratch script `socket-check-20-handshake.js.txt`, in the lane's scratchpad.
    - Real socket.io server, default resolver, one websocket client and one polling client: `handshake` was present,
      with address `127.0.0.1`, in `io.use()` middleware and in `connection`. `join-room` `{code:'ABCDEF'}` answered
      `Room not found.`, so the IP lookup ran without throwing.
    - Hand-made socket without `handshake`, default resolver: reply `{success:false, error:'Internal error'}`, log
      `join-room error: Cannot read properties of undefined (reading 'address')`.
    - The same socket with a resolver that never reads `handshake`: `Room not found.` So the throw does come from
      line 275, and it is contained.
    - Existing tests on the default resolver: `node --test tests/socketTransportRecovery.test.js
      tests/socketRelayBootstrap.test.js`, 10 pass.
  - Original code: `getSocketIp` is byte-identical at ac1c688 (lines 263-276, the line numbers the claim cites).
    `server.js` there also passes `getSocketHandshakeIp` (line 1568, since 30ef97f). The same script, run on an
    archive of ac1c688, gave the same output. So the defect was not real on the original code either.
  - For TASK-094, optional: when it adds the hop count to `getSocketIp`, the last line could return
    `normalizeIp(peerAddress || 'unknown')`. That matches the guarded lines above and reuses the address already
    computed. It is a one-line tidy-up, not a fix.
  - No file changed and nothing was committed. lint, typecheck and `npm test` were not rerun, since the tree is
    unchanged from bfe4d26.
