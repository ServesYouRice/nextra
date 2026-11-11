TASK-084 (lane obs): with autoStart, a setup that needs an OBS restart for the new output mode or encoder no longer sends StartStream. The result carries restartRequired (true, or false when no restart is needed). The warning text is unchanged.

Notes:
- The encoder-reset test stream (Q-001) still runs before the mode/encoder check, as before. It is a test stream that clears a stale encoder, not the auto-start, so the "no StartStream" rule is read as covering the auto-start only. The reset StartStream is still sent when OBS is idle at the start.
- An existing test pinned the defect: 'a failed auto-start writes the previous encoder settings file back before it says OBS was restored (VAL-118)' used AV1 over an H.264 profile, so the new restart gate skipped the auto-start it tests. Changed as little as keeps its intent: testStreamObs takes an optional encoderId (default unchanged), and that test passes 'obs_nvenc_av1_tex', so no restart is needed and the refused auto-start is still reached. Assertions unchanged.
- Checks: node --test tests/obsWebSocket.test.js tests/obsWebSocketWire.test.js 70/70; npm run lint and npm run typecheck clean; npm test 1282/1282.
