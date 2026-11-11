- [x] check 13 `C-50fb3d675546` Asynchronous Blob conversion bypasses relay generation isolation: **no_change_needed** (claim does not hold; lane `watch`, at dev bfe4d26)

  - What is true in the claim: in `src/WatchView.jsx` (unchanged since ac1c688, the quoted line numbers still
    match), `onChunk` checks `payload.generation !== selectedGeneration` at 478 and then, for a Blob, starts
    `data.arrayBuffer().then(enqueueChunk)` at 484-486. `enqueueChunk` (438-474) re-checks neither the generation
    nor `relayCleanupDone`, and `onMediaInit` (501-506) clears the queue and moves `selectedGeneration`. A Blob read
    still pending when a new `media-init` arrives would therefore push old-generation bytes into the new queue, and
    cleanup could not stop it.
  - Why that is not a defect: viewers never receive a Blob, so the asynchronous branch never runs.
    - The client never sets `binaryType` (`src/lib/socketOptions.mjs`, `src/context/SocketContext.jsx`).
      engine.io-client 6.6.6's browser default is `"arraybuffer"` (`build/esm/globals.js:21`, swapped in for
      `globals.node.js` by its `browser` field; the shipped `dist` bundle has ``ye=`arraybuffer` `` and no
      `"blob"`). `transports/websocket.js:29` sets `ws.binaryType` to it, and engine.io-parser's
      `decodePacket.browser.js` `mapBinary` returns an ArrayBuffer for `"arraybuffer"` on every transport
      (WebSocket frames, base64 long-polling, WebTransport).
    - The server forwards `{ generation, chunk }` with `chunk` from `toBinaryChunk()` (`lib/socket.js:304-309`,
      always a Node Buffer), which arrives as an ArrayBuffer.
    - With an ArrayBuffer, `onChunk` takes the synchronous branch (490-491). `enqueueChunk` then runs in the same
      task as the generation check, so no `media-init` can come between them, and nothing is left running for
      cleanup to cancel.
  - Check: the scratch browser check `watch-check13-run.mjs` with `watch-check13-page/`, in the lane's scratchpad,
    run while holding the Playwright lock, on its own port (not 3210).
    - Vite bundles a page that imports `io` from socket.io-client and the app's own `createSocketOptions()`. A real
      socket.io 4.8.4 server emits `media-chunk` `{generation, chunk: Buffer}` the way `lib/socket.js` does. The
      page records the chunk type in `onChunk`'s own terms.
    - Headless Chromium, Firefox and WebKit, each with the app's options (websocket first, tryAllTransports),
      websocket only, and polling only: 27 of 27 chunks were `[object ArrayBuffer]`, `instanceof Blob` false,
      engine `binaryType` `arraybuffer` (`rows=27 blobRows=0 errors=0`; output in
      `watch-check13-browser-output.txt`).
  - Original code: `git diff ac1c688 HEAD -- src/WatchView.jsx` is empty, the client at ac1c688 also set no
    `binaryType`, and `package.json` and `package-lock.json` are unchanged (socket.io-client 4.8.4,
    engine.io-client 6.6.6). So the defect was not real on the original code either.
  - For TASK-087 to 091, optional: the Blob branch in `onChunk` is dead code with this client. When those tasks
    rework relay playback they can drop it, or keep it and re-check `payload.generation === selectedGeneration`
    and `!relayCleanupDone` inside the `.then`, so that it stays safe if `binaryType` is ever set to `"blob"`.
    This is a tidy-up, not a fix.
  - Environment note: around 19:32-19:35 the main checkout's `node_modules` (linked into the lanes) was briefly
    incomplete: 135 entries, no `engine.io`, `engine.io-client` or `.bin`. The first run of the check failed with
    `Cannot find module 'engine.io'`. It was restored (329 entries) by 19:34:55 by someone else; this item installed
    nothing.
