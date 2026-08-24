# Implementation task queue

Updated: 2026-08-24.

This file contains only work that is ready to delegate. Historical cards,
completed work, deferred ideas, and audit transcripts are intentionally absent.
Each card has one self-contained executor prompt under `tasks/`; that prompt is
the implementation contract.

## Executor rules

- Work only on the task explicitly assigned to you. Do not select another card.
- Read the assigned task file, then only the repository files it names.
- Stay within its file scope and escalation conditions.
- Do not edit this queue or another task prompt.
- Run the task's checks in the stated order and return its exact report format.
- T27, T29, and T42 are behavior fixes: their named regressions must fail before
  production source is edited. Every other card is assertion-only; an unexpected
  failure is a finding to report, not an expectation to weaken.

## Ready

| Card | Goal | Change type | Owned implementation files | Prompt |
| --- | --- | --- | --- | --- |
| T27 | Regenerate cached TLS credentials that do not exactly match the configured endpoint | Behavior fix | `lib/https.js`, `tests/https.test.js` | `tasks/T27.md` |
| T28 | Table-test the OBS encoder selection branches | Tests only | `tests/obsOutputModel.test.js` | `tasks/T28.md` |
| T29 | Reject fMP4 boxes whose declared size is smaller than their header | Behavior fix | `lib/fmp4Parser.js`, `tests/fmp4Parser.test.js` | `tasks/T29.md` |
| T30 | Cover multi-frame Opus packets and multi-segment Ogg lacing | Tests only | `tests/oggOpusMuxer.test.js` | `tasks/T30.md` |
| T31 | Pin ICE candidate ordering for loopback, LAN, and public media binds | Tests only | `tests/mediasoupTransport.test.js` | `tasks/T31.md` |
| T32 | Cover the two browser media denial paths | Tests only | `tests/browser/media-flow.spec.mjs` | `tasks/T32.md` |
| T36 | Cover shared WebRTC server candidate ordering and fallback | Tests only | `tests/mediasoupSharedServer.test.js` | `tasks/T36.md` |
| T37 | Cover WHEP CORS, availability, and room passphrase admission | Tests only | `tests/whepRoutesAdmission.test.js` | `tasks/T37.md` |
| T38 | Cover WHEP rate, room, and global capacity limits | Tests only | `tests/whepRoutesLimits.test.js` | `tasks/T38.md` |
| T39 | Cover WHEP transport allocation, success, and failure cleanup | Tests only | `tests/whepRoutesSession.test.js` | `tasks/T39.md` |
| T40 | Cover WHEP connection and disconnect lifecycle timers | Tests only | `tests/whepRoutesLifecycle.test.js` | `tasks/T40.md` |
| T41 | Cover WHEP DELETE and unsupported PATCH contracts | Tests only | `tests/whepRoutesMethods.test.js` | `tasks/T41.md` |
| T42 | Replace an existing WHEP ICE-disconnect reaper before scheduling another | Behavior fix | `lib/whepRoutes.js`, `tests/whepRoutesIceDisconnect.test.js` | `tasks/T42.md` |

All thirteen cards own distinct test files. The three behavior cards also edit
different production modules, so no two cards have overlapping write ownership.
