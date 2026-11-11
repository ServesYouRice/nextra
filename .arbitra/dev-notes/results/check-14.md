# check 14 `C-824ecf31bbca`: Audio capture is disabled in getDisplayMedia for non-Chromium browsers

- Does not hold (no_change_needed). Lane `client`, judged at dev bfe4d26. The capture code is the same as on the audited ac1c688.
- The literal part is right. A browser HostView does not detect as Chromium gets `audio: false` and no `systemAudio`
  (src/HostView.jsx:1342-1343, 1369-1379). But no audio is lost by it:
  - Firefox 155 (Playwright build, Sept 2026) returned a video track only for every request: `audio: false`,
    `audio: true`, `audio: {channelCount: 2}`, and the full Chromium option set with `systemAudio: 'include'`. The
    same profile's `getUserMedia({audio: true})` did return an audio track. The binary has no getDisplayMedia audio
    pref.
  - Chromium 153 was the control. It returned audio plus video for each request that asked for audio, and video only
    for `audio: false`.
  - Safari was not run. Playwright's Windows WebKit 26.6 has no `navigator.mediaDevices`, so the Safari verdict rests
    on MDN's compatibility data (audio capture support in Chromium browsers only), cited from knowledge.
- Hosting is not gated on the browser's name. A non-Chromium host gets the preflight warning "Sharing can continue
  without system audio" (src/lib/hostPreflight.mjs:32-36), never a blocker. Audio is produced only when the capture
  has a track (src/HostView.jsx:1513-1521). The README says the path is untested and that `systemAudio` is
  Chromium-only (README.md:124).
- Probe: `check-14-probe.cjs.txt`, output in `check-14-probe-output.json` (both in this folder). It runs a routed https
  page with no port bound, and was run while holding the Playwright lock. Rerun it with
  `node .arbitra/dev-notes/results/check-14-probe.cjs.txt`.
- Left open, not a defect: when Firefox or Safari ship display audio, HostView will still ask them for none. Requesting
  `audio: true` from every browser would be harmless today (Firefox ignores it, as the probe shows), but that is a
  feature change, not this fix.
