# Reconciliation verification log

Date: 2026-07-22  
Current revision: `d3597253db8562ac2d80bcfc626d51397e05a85b`  
Branch: `agent/production-readiness-audit`

## Revision comparison

`git diff 500e04b..HEAD -- package.json package-lock.json config.js server.js lib src tests .github`
reported no application, configuration, test, or workflow changes. The only
files added since the shared audit base are the two audit folders. This makes
the current source a valid basis for reconciling both reports.

## Commands run

| Check | Result | Interpretation |
| --- | --- | --- |
| Parse `package-lock.json` with `JSON.parse` | Fail at line 2403 | Lockfile corruption is confirmed. |
| `npm run lint` | Pass | Fable L-2 is not reproducible in the installed tree. |
| `npm run typecheck` | Pass | Narrow lifecycle check only. |
| `npm test` | 141/141 pass | Uses an existing ignored `dist/` and stale dependencies. |
| `npm ls eslint eslint-plugin-react-hooks mediasoup vite --depth=0` | Fail with invalid packages | Installed ESLint 9.39.3, hooks plugin 7.0.1, and mediasoup 3.19.17 do not satisfy the manifest. |
| `npm run evaluate:packaging` | Fail while parsing lockfile | Packaging evaluation cannot start. |
| `npm run audit:prod` | Fail with `ENOLOCK` | Production advisory verification is unavailable. |

The local Node version was 22.14.0. The project supports Node `>=20.19.0`, but
the repaired release graph still needs clean Node 20 CI and Windows validation.

## Source-level confirmations

- `package.json` runs unit/integration tests before `vite build`; the real-server
  integration test expects the SPA shell, while `dist/` is ignored.
- A prewarmed browser `MediaRecorder` emits `media-init` only on recorder start.
  A late tunnel viewer always waits for a new live `media-init`, but the
  zero-to-one viewer transition does not restart the recorder.
- `create-room` has capacity and per-IP throttles but no local/operator
  authorization. The known public tunnel origin can therefore allocate rooms.
- the main public app mounts WHIP and its POST handler has no admission rate
  limit before room/token parsing.
- a replacement process cannot reclaim an in-memory room; Host only logs failed
  reclaim and keeps stale streaming state.
- `/readyz` does not include `dist/index.html` or enabled WHIP state in its HTTP status.
- Socket.IO viewer receive transports omit `purpose: 'viewer'`.
- room creation still calls `crypto.scryptSync`.
- the AV1 viewer warning checks MP4/MSE support before the mediasoup device is loaded.
- `FALLBACK_AUDIO_OFFSET_MS` defaults to 1500 ms while the relay start comments
  say keyframe anchoring normally requires zero fixed offset. This is a real
  contract contradiction, but live measurements are required before choosing a value.

## Verification limitations

No lockfile regeneration, dependency installation, browser automation, OBS
session, public tunnel, TURN topology, signed packaging, or destructive clean
checkout manipulation was performed. Findings requiring those environments
remain explicitly marked as evidence or decision tasks rather than silently
treated as fixed.
