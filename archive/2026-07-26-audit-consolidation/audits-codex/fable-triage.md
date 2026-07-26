# Fable finding triage

Status meanings:

- **Confirmed**: current source or a safe command directly demonstrates it.
- **Confirmed duplicate**: valid, already represented by a canonical Codex finding.
- **Reclassified**: the observation is real but its asserted impact or fix is not proven.
- **Conditional/evidence**: act only for the stated support contract or after measurement.
- **No action**: false positive, accepted design, or unsupported speculation.

## Logical findings

| Fable ID | Status | Merged disposition |
| --- | --- | --- |
| L-1 | Confirmed duplicate | `CF-01`. Invalid lockfile blocks clean install, audit, packaging evaluation, CI, and release. |
| L-2 | Reclassified | Current `npm run lint` passes. The installed ESLint and hooks plugin are manifest-invalid, so lint must be rerun after `npm ci`; do not plan fixes for six historical messages until then. Covered by `CF-01`. |
| L-3 | Confirmed duplicate | `CF-02`. `release:prep` tests before build while the integration test expects `dist/index.html`. |
| L-4 | Reclassified, decision required | `CF-15`. The 1500 ms default conflicts with keyframe-anchor comments, but neither audit measured live lip-sync. Test 0/500/1000/1500 ms before changing behavior. |
| L-5 | Confirmed duplicate | `CF-11`. Viewer receive transports omit the conservative viewer purpose. |
| L-6 | Confirmed duplicate | `CF-05`. Host has no terminal restart/reclaim-failure state. |
| L-7 | Confirmed duplicate | `CF-12`. `scryptSync` blocks the shared event loop. |
| L-8 | Confirmed | `CF-16`. Waiting copy promises auto-start, while `new-producer` only reveals the Watch button. Prefer truthful copy unless autoplay is separately designed and tested. |
| L-9 | Confirmed duplicate | `CF-16`. Diagnostics recommend 720p, but 1080p is the lowest profile. |
| L-10 | No action as a defect | README explicitly says Windows media-key/`xdotool` are the supported defaults and `nut-js` is optional and unsupported. Revisit only if macOS hosting becomes supported. |
| L-11 | Confirmed, low priority | `CF-21`. Sweep the TURN-mint IP map and clear ignored transport IDs during global cleanup. |
| L-12 | Confirmed duplicate | `CF-20`. Centralize constant-time bearer-token comparison. |
| L-13 | Confirmed, deferred | `CF-23`. Duplication exists; refactor only behind behavioral tests after blockers. |
| L-14 | No action | A destroyed room-code collision plus credential coincidence is not a practical reconnect race; the actual failure path already resets to rejoin. |
| L-15 | No action without a failing case | The zero-delay cleanup is an intentional StrictMode compromise. Add a regression test if this lifecycle is changed; do not refactor speculatively. |

## UI findings

| Fable ID | Status | Merged disposition |
| --- | --- | --- |
| U-1 | Confirmed duplicate | `CF-16`, truthful wait/play behavior. |
| U-2 | Confirmed duplicate | `CF-05`, terminal Host restart state. |
| U-3 | Confirmed polish | `CF-24`. Preserve anti-enumeration behavior; make the expected second step informational and focus the field. |
| U-4 | Confirmed duplicate | `CF-16`, fix advice or add a measured tier later. |
| U-5 | Confirmed | `CF-16`. Render a state-backed joined room code rather than a ref. Also re-evaluate lint after clean install. |
| U-6 | Confirmed support gap | `CF-18`. The product says viewers can use any modern browser without retained Safari/iOS evidence. Test, narrow claims, and add capability-specific guidance. |
| U-7 | Confirmed | `CF-21`. Pause Status polling while hidden and refresh on visibility. |
| U-8 | Confirmed | `CF-24`. Consolidate duplicate 400 px media queries. |
| U-9 | Confirmed polish | `CF-24`. Track fullscreen state or remove the redundant custom control. |
| U-10 | Confirmed polish | `CF-24`. Map known capture/media failures; retain technical details separately. |
| U-11 | Evidence first | A persistent live region may help, but the claimed screen-reader miss was not tested. Include it in the accessibility pass before changing markup. |
| U-12 | Confirmed evidence gap | `CF-17`/`CF-18`. Core semantics can be fixed now; WCAG and broad support claims require retained manual and automated evidence. |

Fable missed three concrete accessibility defects found by Codex: the primary
room-code input has no accessible name, route changes do not update title or
focus/announcement, and live frame-rate buttons expose no selected state.

## Security findings

| Fable ID | Status | Merged disposition |
| --- | --- | --- |
| S-1 | Confirmed duplicate | `CF-20`, constant-time bearer comparison. |
| S-2 | Confirmed hardening | `CF-20`. Narrow WebSocket CSP to same-origin plus supported loopback OBS endpoints, with integration coverage. |
| S-3 | Accepted protocol design | Capability-URL teardown is standard and IDs are high entropy. Document proxy response-header/path logging; do not invent an incompatible auth scheme without client analysis. |
| S-4 | No current action | Host reflection affects attacker-controlled responses to the attacker and there is no default shared cache. Revisit with a supported caching proxy. |
| S-5 | Accepted design | Session-scoped, opt-in storage is intentional; a privacy/help clarification is sufficient. |
| S-6 | Split | Host media-chunk trust is a documented threat-model choice; the TURN-mint map cleanup is actionable under `CF-21`. |
| S-7 | Reclassified | `--no-tls-verify` affects the same-machine quick-tunnel origin hop, not public TLS. Add a startup notice (`CF-22`); do not call it a transport vulnerability. |
| S-8 | Split | Lockfile is `CF-01`. The archived packager is already trigger-gated; no immediate migration (`CF-25`). |
| S-9 | Positive observations | Retain as audit evidence; no task. |

Fable missed the highest-impact public trust-boundary items: unauthenticated
public room creation (`CF-04`), broad private-LAN operator trust (`CF-09`), and
unlimited public WHIP requests (`CF-08`).

## Performance findings

| Fable ID | Status | Merged disposition |
| --- | --- | --- |
| P-1 | Confirmed risk, evidence first | `CF-19`. Profile the supported envelope before changing fanout architecture. |
| P-2 | Confirmed duplicate | `CF-11`. |
| P-3 | Confirmed duplicate | `CF-12`. |
| P-4 | Confirmed, deferred | `CF-21`/`CF-23`. Consolidate metrics ownership after correctness work. |
| P-5 | Reclassified as sizing evidence | `CF-19`. The arithmetic is a conservative ceiling, not measured resident memory. Publish numbers from target-host/churn runs. |
| P-6 | Confirmed maintainability risk | `CF-23`. No broad pre-release refactor. |
| P-7 | Confirmed duplicate | `CF-21`. |
| P-8 | Positive observations | Retain; no task. |

## Testing findings

| Fable ID | Status | Merged disposition |
| --- | --- | --- |
| T-1 | Partly confirmed | Lockfile and clean `dist` ordering are confirmed. The six lint failures are not currently reproducible and must be re-evaluated only after clean install. |
| T-2 | Confirmed duplicate | `CF-02`. |
| T-3 | Confirmed gap | `CF-15`. Add a default-config assertion after the live A/V decision. |
| T-4 | Confirmed duplicate | `CF-19`. Extract/test lifecycle decisions rather than attempting exhaustive JSX coverage. |
| T-5 | Confirmed duplicate | `CF-19`. Coverage thresholds include only four files. |
| T-6 | Confirmed external work | `CF-07`. |
| T-7 | Confirmed housekeeping | `CF-25`. Align or document the setup-node revision. |

Fable also missed the delayed tunnel-relay regression test (`CF-03`), packaged
worker/live-media evidence, and core semantic accessibility tests.

## Production-readiness and nice-to-have reconciliation

Fable's production order is superseded because it omitted the broken public
relay flow, public host authorization, WHIP admission, LAN trust boundary, and
readiness semantics. Its useful additions are retained in `CF-15`, `CF-16`,
`CF-18`, `CF-21`, `CF-22`, and `CF-24`.

Keep the preflight panel, stable-tunnel onboarding, support matrix, redacted
diagnostic bundle, viewer sharing affordance, and incremental lifecycle
extraction on the post-blocker roadmap. Defer PWA, recording, multi-presenter,
chat, E2EE, databases, multi-instance state, and packager migration until their
documented product/evidence triggers exist.
