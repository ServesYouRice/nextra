- [x] check 10 `C-bc74a9d8c883` Single-encoding video streams are severely throttled by index-based simulcast mapping: **no_change_needed** (the claim does not hold; lane `socket`, at dev 1be0088)

  - **Why the claim fails:** it assumes the host's video sender can end up with one encoding. In Nextra it never
    does.
    - The only video `produce()` call (`src/HostView.jsx:1500-1504`) always passes `getSimulcastEncodings()`,
      which is `[r0, r1, r2]`.
    - mediasoup-client 3.24.5 passes them on in that order as `sendEncodings`. Each of its handlers sets
      `rid = r${idx}` and calls `addTransceiver(track, { sendEncodings: encodings })`, with no reordering:
      `Chrome111.js:240-265`, `Firefox120.js:254-268`, `Safari12.js:241-266`.
    - mediasoup-client's own `setMaxSpatialLayer` (`Chrome111.js:459-468`) also maps encodings by index.
  - **Browser probe** (`check-10-probe.cjs.txt`, output in `check-10-probe-output.json`):
    - What it ran: the real app (vite build in the scratchpad), the real `server.js` with `NEXTRA_SMOKE_TEST=1` and
      ports from `claimServerPorts()`, and the real mediasoup-client, in Playwright Chromium 153 and Firefox 155. I
      held the Playwright lock while it ran.
    - How: it hooks `addTransceiver`, starts sharing a stubbed 1280x720 capture, switches the live profile, and reads
      `sender.getParameters().encodings` after each step.
    - Result: both browsers kept 3 encodings in order `r0, r1, r2`. After each change every encoding held its own
      rid's target, so nothing was capped at the r0 share:

      | profile | [0] r0 | [1] r1 | [2] r2 |
      |---|---|---|---|
      | 1440p/60 (at start) | 2520000 | 8400000 | 21000000 |
      | 1080p/30 | 960000 | 3200000 | 8000000 |
      | 4K/60 | 4320000 | 14400000 | 36000000 |

    - My first run read the wrong transceiver. mediasoup-client opens throwaway transceivers to probe capabilities
      when the Device loads, for example Firefox's `[{rid:'r0',maxBitrate:100000},{rid:'r1',maxBitrate:500000}]`.
      The probe now counts only transceivers whose track is live.
  - **Even in the hypothetical single-encoding case**, `applyProducerBitrateProfile` would not cause the cap.
    - A browser that cannot simulcast trims `sendEncodings` from the tail (webrtc-pc `addTransceiver`, maxN). An
      answer that rejects simulcast keeps only the first encoding. Either way the lone encoding is the requested r0,
      already at `scaleResolutionDownBy: 4` and the r0 cap from `produce()` itself.
    - `check-10-unit.cjs.txt` runs the unchanged function on such a sender: `{scaleResolutionDownBy:4,maxBitrate:2520000}`
      goes in and comes out unchanged.
    - mediasoup would also have registered three rid streams for a single rid-less stream, so the real breakage would
      be in `produce()`, not here. No supported browser takes this path.
  - **Original code:** the defect was not real there either. `applyProducerBitrateProfile`, `getSimulcastEncodings`
    and the `encodings:` argument of `produce()` are identical at ac1c688. They have not changed since 4fa0eef
    (2026-03-26), which added them together. ac1c688's lockfile has the same mediasoup-client 3.24.5, and the unit
    check gives the same output on ac1c688's `HostView.jsx`.
  - **Seen in passing, not examined:** a 5-second Chromium `outbound-rtp` sample right after the switch to 4K showed
    `qualityLimitationReason: 'bandwidth'`, with r0 and r1 encoding and r2 not yet encoding. That looks like the
    send-side bandwidth estimate still ramping on loopback. Steady state was not measured. Firefox encoded no frames
    in the probe, probably loopback ICE, which getParameters does not depend on.
  - No file changed and nothing was committed. lint, typecheck and `npm test` were not rerun, since the tree is
    unchanged from 1be0088.
