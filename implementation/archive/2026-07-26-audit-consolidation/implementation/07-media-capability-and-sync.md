# Packet 07 - Authoritative media capability and A/V sync

Findings: CF-13, CF-14, CF-15. Prerequisite: Packet 01. Contains a mandatory human/environment gate.

## A. Viewer AV1 capability

Read `src/WatchView.jsx`, `src/lib/watchPlaybackMode.mjs`, mediasoup device loading,
and related tests.

Plan:

1. Stop using `MediaSource.isTypeSupported(video/mp4; av01...)` as the WebRTC test.
2. Load the mediasoup device, then inspect its receive RTP capabilities for a
   compatible `video/AV1` codec. Keep MSE capability checks only on fMP4 paths.
3. Derive the warning from room codec plus WebRTC receive capability and make the
   diagnostic say which capability is missing.
4. Test AV1 room/capability combinations, H.264 rooms, and the timing before/after device load.

## B. OBS AV1 selection authority

Read GPU detection/AV1 UI in `src/HostView.jsx`, encoder candidate verification in
`src/lib/obsWebSocket.js`, and OBS tests.

Plan:

1. Treat WebGL renderer detection as a preference hint, not a hard UI disable.
2. For unknown/masked GPU, supply the bounded known cross-vendor AV1 candidate set
   to the existing set-and-verify OBS transaction (or use an authoritative OBS
   encoder enumeration API only if verified against supported OBS versions).
3. Keep TURN/public-media prerequisites. Let OBS verification accept a real encoder
   or return a clear fallback-to-H.264 result without leaving partial settings.
4. Test masked renderer + available OBS encoder, detected GPU + missing plugin,
   all candidates rejected, rollback, and H.264 fallback.

## C. OBS fallback audio-offset decision

Do not change the 1500 ms default from source inspection alone.

Read `config.js`, `.env.example`, keyframe/audio start in `lib/socket.js`,
`lib/ffmpegRelay.js`, `tests/ffmpegRelay.test.js`, and `REMAINING-WORK.md`.

Run a repeatable real OBS matrix on target hardware:

| Variable | Required samples |
| --- | --- |
| Encoder | NVENC if available; libx264 fallback |
| Audio | desktop/media source with visible clap/flash marker |
| Offset | 0, 500, 1000, 1500 ms |
| Join | relay prewarmed and viewer joins late |
| Duration | startup plus steady state and one relay restart |

Record source and viewer timestamps from captured evidence. Choose the smallest
fixed offset whose median and worst-case lip-sync meet the documented tolerance.
If keyframe anchoring plus measured startup backlog already accounts for skew,
set default 0; otherwise retain/change the measured value and correct all comments.

After the decision:

1. Make `config.js`, `.env.example`, relay comments, and operator docs agree.
2. Add a default-config-to-FFmpeg-args test and restart/backlog assertions.
3. Record hardware, OBS/FFmpeg versions, encoder, sample count, result, and approver.

## Acceptance criteria

- WebRTC AV1 warning is based on RTP receive capability.
- Masked WebGL cannot falsely block an OBS encoder that verification accepts.
- Failed AV1 setup rolls back and gives a safe H.264 route.
- The audio default is supported by retained real-session evidence and one coherent contract.
- No model guesses or changes the audio offset without that evidence.

## Dispatch objective

```xml
<objective>
Use authoritative media capabilities: derive viewer AV1 support from mediasoup/
WebRTC receive RTP codecs and make OBS encoder verification authoritative over
WebGL hints. Add focused combination/rollback tests. For the audio-offset
contradiction, prepare/run the specified real OBS matrix and stop without a code
change if that environment or evidence is unavailable.
</objective>
```
