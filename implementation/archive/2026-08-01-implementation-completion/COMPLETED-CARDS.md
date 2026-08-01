# Completed implementation cards

Archived: 2026-08-01.

This is the completion record for implementation cards T01–T16. These cards are
not active instructions. Use `../../KANBAN.md` for current task
scope, status, and standing product decisions.

## T01 — Reproducible dependencies

Regenerated and validated the dependency graph on Node 20, aligned CI setup-node
pins, and retained clean-install, inventory, lint, typecheck, unit, build,
packaging, OSS, and production-audit gates. Evidence: Node 20 clean install and
141-test release preparation passed.

## T02 — Clean build and truthful readiness

Made integration/release checks independent of a stale ignored `dist/`; production
readiness now reports named HTTP, Socket.IO, mediasoup, SPA, and required-WHIP
components while `/healthz` remains liveness. Evidence: isolated SPA readiness
tests and Node 20 release preparation with 142 tests passed.

## T03 — Delayed H.264 relay generation

Added a recorder/server generation contract: zero-to-one relay demand selects one
fresh generation, later viewers reuse it, stale chunks cannot cross generations,
and last-viewer cleanup clears bounded queues/listeners/timers/buffers/URLs.
Evidence: ordering checks, the 159-test Node 20 suite, and delayed two-viewer
decoded-frame/leave/rejoin Chromium coverage passed.

## T04 — Truthful restart and reclaim states

Distinguished recoverable same-process reconnect/reclaim from terminal room end
after process replacement, worker-fatal restart, missing room, or invalid reclaim.
Host and viewer teardown is idempotent and recovery wording no longer promises
cross-process survival. Evidence: transition/recovery tests, lint, typecheck, and
the 143-test Node 20 suite passed.

## T05 — Operator, LAN, and WHIP boundary

Centralized client classification and constant-time operator authorization before
room allocation, sensitive metrics, TURN minting, and WHIP work. Loopback Host/OBS
remains supported; forwarded spoofing, public host authority, secret leakage, and
over-capacity pending starts are denied. Evidence: focused operator/network/WHIP/
WHEP checks, lint, typecheck, and the 151-test Node 20 suite passed.

## T06 — Contained backend correctness

Marked viewer receive transports for conservative bandwidth, replaced synchronous
room passphrase hashing with bounded asynchronous reservations, and reused the
constant-time comparator while narrowing WebSocket CSP endpoints. Evidence:
focused transport/room/socket/WHIP/server checks, lint, typecheck, the 159-test
Node 20 suite, coverage thresholds, and four-case Chromium gate passed.

## T07 — Authoritative AV1 capability

WebRTC AV1 support now comes from loaded receive RTP capabilities; MSE checks stay
on relay playback and WebGL is only an OBS encoder preference hint. OBS setup uses
bounded set-and-verify candidates with complete H.264 rollback. Evidence: focused
WebRTC/OBS capability tests, lint, typecheck, and the 146-test Node 20 suite passed.

## T08 — UI correctness, accessibility, and support truth

Added state-backed room codes, truthful Watch/quality copy, labelled and stateful
join/fps controls, route titles/focus/announcement, tested support claims, and
representative keyboard/reflow coverage. Evidence: 24-case desktop/mobile Chrome
E2E, the 166-test suite, lint, typecheck, coverage, and build passed.

## T09 — Relay security and bounded operations

Applied the trusted-LAN plaintext relay policy, bounded long-lived collections,
made unexpected rejections supervisor-fatal, suppressed absent-host metrics work,
and stopped all Status polling while hidden with one immediate refresh/interval on
resume. Evidence: focused security/cleanup/visibility checks and the 166-test suite
passed.

## T10 — Open-source release gate

CI runs release preparation and retained desktop/mobile Chrome paths. Windows CI
and tagged builds package with caxa, create a SHA-256 checksum, replace the real
mediasoup worker, prove decoded frames and graceful cleanup, and publish unsigned
artifacts without external credentials. Signing, capacity/churn, clean-VM, NAT/TURN,
and hardware A/V sync checks remain optional operator validation. Evidence:
3 workflow tests, 169-test release preparation, 24-case E2E, checksum verification,
artifact build, and packaged worker-recovery/decoded-frame smoke passed.

## T11 — Small polish and extraction

Implemented the actionable low-priority items in independently testable seams:

- protected rooms request a labelled, focused passphrase as an informational
  second step while retaining the entered room code;
- known capture, timeout, transport, and abort failures show a useful next action
  with technical detail retained separately;
- fullscreen exposes pressed state and a tested exit path;
- restricted Status copy describes the local UI instead of a nonexistent token UI;
- the duplicate 400 px CSS rules are one block with retained viewport assertions;
- shared byte formatting, room metric payloads, fMP4 eviction, and media-debug URL
  parsing have behavior tests around the former call-site differences;
- the existing Host/viewer session-controller seam names relay, transport, media,
  queue, listener, timer, and resource ownership; idempotent controller cleanup and
  retained reconnect/rejoin paths cover it, so no broader lifecycle rewrite was made;
- OBS live-region markup was intentionally unchanged because no retained
  assistive-technology test fails, matching the card’s stop condition.

Evidence: 7 focused utility/player/payload tests, lint, typecheck, the 175-test
unit/integration suite, coverage, build, packaging evaluation, OSS checks, both
production audits, all 26 desktop/mobile Chrome E2E cases, artifact build and
SHA-256 verification, plus packaged worker-recovery/decoded-frame/shutdown smoke
passed.

## T12 — Measured real-media capacity and headroom

Made runtime capacity results scenario-labelled and machine-specific, required
live WebRTC producers/consumers or active H.264 relay viewers/pipelines/forwarded
bytes, and reported explicit signalling, event-loop, CPU, and memory headroom.
Documented repeatable direct and relay target-host commands without turning one
machine's result into a portable limit. The retained decoded-frame E2E also runs a
short labelled WebRTC measurement and requires a live producer/consumer plus
headroom output. Evidence: 4 focused benchmark/churn tests, the live-media E2E,
lint, typecheck, and the serial 180-test unit/integration suite passed; the first
parallel suite run had 3 process-startup timeouts under contention and was not
counted as a pass.

## T13 — Path-specific Host preflight

Added a pure Browser/OBS preflight model and ran it before room allocation.
Unavailable capture, WHIP, AV1 TURN/encoder/public-media, and WebSocket conditions
now block only paths that require them; system-audio and tunnel availability stay
actionable, non-blocking notices. Evidence: 5 helper tests, the zero-room blocked
capture browser check, the retained decoded-frame/rejoin browser flow, lint, and
typecheck passed.

## T14 — Redacted diagnostic bundle

Added an always-available Host download backed by a strict safe-field allowlist
for version/runtime identity, readiness, configuration flags, topology counts,
utilization, and current errors, with a second text-redaction layer and no stored
history. Room lists/codes, public or capability URLs, headers, passphrases, and
all token/credential fields are structurally excluded. Evidence: 2 exact bundle/
download tests, desktop and mobile Chrome download flows, lint, typecheck, and the
serial 187-test unit/integration suite passed.

## T15 — Truthful room-link lifetime and viewer copy-link

Added process-bound lifetime copy to Host and joined Viewer surfaces, generated a
canonical viewer link from only the current origin/path and normalized room code,
kept protected-room passphrases out of it, and retired the Viewer copy action when
the room ends. Evidence: focused room-link unit coverage, the protected-room copy/
explicit-stop browser flow, lint, typecheck, and the production build passed.

## T16 — Release distribution due diligence

Aligned the tagged Windows workflow with the repository's version tags and made it
publish or refresh a GitHub Release using the built-in repository token. Release
notes now identify the executable as unsigned, state the tested browser scope, and
point to the tagged GPL-3.0 corresponding source. The OSS preflight fails closed
when either production lockfile contains missing or unreviewed dependency-license
metadata, and the notices name the reviewed license set. No signing credential,
account setup, dependency, or manual release upload was added. The public 2.0.1
release description was narrowed to the evidenced unsigned/checksum/source and
support claims without changing its assets. Evidence: 7 focused preflight/workflow
tests, the production OSS check, lint, and the post-edit GitHub release read passed.

## Final cross-card evidence

The complete release-preparation gate and all 31 desktop/mobile Chrome E2E cases
passed on 2026-08-01.
