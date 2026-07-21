# Nice-to-Haves

These are intentionally below the release blockers. They should not displace lockfile, relay, authorization, restart, readiness, accessibility, or external release-evidence work.

## High-impact nice-to-haves

### N-1 - Add a host preflight tailored to the selected sharing path

- **Severity:** Nice-to-have
- **Location:** Host setup flow in `src/HostView.jsx`; public URL/tunnel and TURN status APIs
- **Description:** Before going live, show capture permission, system-audio support, public-link state, direct-media reachability, TURN availability, estimated upload headroom, and whether relay fallback will be used.
- **Why it matters for production:** Hosts currently discover environment limitations after sharing a link, when recovery is socially and operationally expensive.
- **Recommended fix:** Run non-destructive checks on demand, present a simple ready/degraded/blocked summary, and link each failure to an actionable fix without exposing secrets.
- **Blocker before production:** No.
- **Related risks/dependencies:** Browser permission UX, external topology tests, metric privacy, false positives behind NAT.

### N-2 - Provide an exportable, redacted diagnostic bundle

- **Severity:** Nice-to-have
- **Location:** Host/status UI; server metrics and lifecycle logs
- **Description:** Let the operator download version/config capability summaries, recent lifecycle events, component health, and WebRTC statistics with tokens, room secrets, local paths, and IP details redacted.
- **Why it matters for production:** Media failures are environment-specific; structured evidence reduces support time and makes regressions reproducible.
- **Recommended fix:** Define a versioned JSON/text bundle, centralize redaction, include consent and a preview, and test it with seeded secret values.
- **Blocker before production:** No.
- **Related risks/dependencies:** Privacy policy, log retention, S-2 metrics authorization.

### N-3 - Expose supported capacity and current headroom in the host UI

- **Severity:** Nice-to-have
- **Location:** Host metrics panel; benchmark documentation; room/server limits
- **Description:** The server enforces room/viewer limits, but the host does not get a clear target-tested capacity envelope or early warning as CPU, outgoing bandwidth, or relay buffering approaches it.
- **Why it matters for production:** Operators can invite more viewers than the measured host/network can sustain even when hard server limits are not reached.
- **Recommended fix:** After D-3 establishes baselines, show the supported profile, current viewer/bitrate headroom, and actionable warnings based on measured thresholds.
- **Blocker before production:** No; the supported limit itself must still be documented.
- **Related risks/dependencies:** Target-host benchmarks, P-3, telemetry accuracy.

## Product polish

### N-4 - Let viewers choose an explicit latency/quality preference

- **Severity:** Nice-to-have
- **Location:** Viewer controls in `src/WatchView.jsx`; simulcast/consumer layer controls
- **Description:** The viewer has little control over the tradeoff among latency, resolution, and resilience.
- **Why it matters for production:** A remote viewer on a constrained connection may prefer stable lower quality, while a LAN viewer may prefer maximum detail.
- **Recommended fix:** Offer Auto, Low bandwidth, and Best quality presets backed by consumer layer/relay behavior and explain when a transport cannot honor a choice.
- **Blocker before production:** No.
- **Related risks/dependencies:** Simulcast availability, relay codec/container constraints, congestion-control testing.

### N-5 - Show room/link lifetime and rotation clearly

- **Severity:** Nice-to-have
- **Location:** Host share panel; room expiry/cleanup configuration
- **Description:** Hosts can copy capabilities and public URLs but do not receive a concise lifetime/rotation explanation or countdown.
- **Why it matters for production:** Users may assume a previously shared link is durable or may retain sensitive links longer than intended.
- **Recommended fix:** Display creation/expiry status, invalidate/copy-new controls, and a short explanation that server restart ends an in-memory room.
- **Blocker before production:** No, provided restart behavior is first made truthful.
- **Related risks/dependencies:** L-2, token lifecycle, clipboard privacy.

### N-6 - Improve in-product support and legal contact configuration

- **Severity:** Nice-to-have
- **Location:** Help, privacy, terms, and error routes
- **Description:** Static documents are present, but deployments do not have one configurable operator/support contact surfaced beside terminal errors and legal pages.
- **Why it matters for production:** Users need to know who operates the instance and where to report abuse, privacy concerns, or a failed session.
- **Recommended fix:** Add optional validated operator name/contact configuration, render it consistently, and keep it absent by default for personal deployments.
- **Blocker before production:** No; qualified legal review remains a separate blocker.
- **Related risks/dependencies:** Spam exposure, privacy/legal ownership, localization.

## Developer experience improvements

### N-7 - Generate protocol types and fixtures from shared runtime schemas

- **Severity:** Nice-to-have
- **Location:** Socket.IO event contracts across `src/` and `lib/socket.js`
- **Description:** Developers currently update payload construction, validation, tests, and documentation separately.
- **Why it matters for production:** Repetitive manual updates increase protocol drift and make edge-case fixtures inconsistent.
- **Recommended fix:** Adopt a lightweight schema module that generates/checks client/server types, validation, redacted examples, and compatibility fixtures.
- **Blocker before production:** No.
- **Related risks/dependencies:** A-3, bundle size, migration of legacy optional fields.

### N-8 - Add one configuration validator and generated deployment reference

- **Severity:** Nice-to-have
- **Location:** `.env.example`, startup environment parsing, service/packaging docs
- **Description:** Defaults, validation, security meaning, and documentation for environment variables are maintained in several places.
- **Why it matters for production:** Configuration drift creates deployments that start successfully but do not match their operator's intended trust or media profile.
- **Recommended fix:** Define each setting once with type, default, sensitivity, profile, and validation; fail fast for invalid required values and generate the reference table.
- **Blocker before production:** No, except required-component readiness must be fixed independently.
- **Related risks/dependencies:** Backward compatibility, secret redaction, D-5/D-8.

### N-9 - Create deterministic lifecycle trace fixtures

- **Severity:** Nice-to-have
- **Location:** Host/viewer/relay unit and integration tests
- **Description:** Race-heavy reconnect and fallback tests would benefit from a shared fake clock, scripted socket ordering, and compact transition traces.
- **Why it matters for production:** Deterministic traces make intermittent lifecycle failures easier to reproduce and review than long timer-driven logs.
- **Recommended fix:** Build fixtures for late join, duplicate events, disconnect/reconnect, worker replacement, stale generation, and cancellation; snapshot state transitions rather than implementation logs.
- **Blocker before production:** No; T-4's concrete regression test is a blocker.
- **Related risks/dependencies:** A-2 state-machine extraction, fake media primitives.

## Architecture or stack recommendations

### N-10 - Extract host, viewer, and relay state machines incrementally

- **Severity:** Nice-to-have
- **Location:** `src/HostView.jsx`, `src/WatchView.jsx`, `lib/socket.js`
- **Description:** Large components mix UI rendering with resource ownership and protocol transitions.
- **Why it matters for production:** Explicit state machines would make invariants reviewable and simplify future fallback/reconnect work.
- **Recommended fix:** Start with relay generation and server-restart transitions, preserve existing APIs, add transition-table tests, then move UI rendering onto derived state.
- **Blocker before production:** No; do not defer L-1/L-2 while waiting for a full refactor.
- **Related risks/dependencies:** Refactor regression risk, React concurrency, A-2.

### N-11 - Maintain a trigger-based successor-packaging prototype

- **Severity:** Nice-to-have
- **Location:** `docs/packaging-evaluation.md`; packaging scripts
- **Description:** The verified packager is archived, while an immediate migration would put native media behavior and signing at risk.
- **Why it matters for production:** A small maintained prototype reduces emergency migration cost without destabilizing the current release path.
- **Recommended fix:** Periodically test Node SEA or another maintained approach against explicit child-process, native module, FFmpeg/cloudflared, signing, startup, and size criteria; migrate only when it reaches parity or a security/platform trigger fires.
- **Blocker before production:** No.
- **Related risks/dependencies:** D-7, Node releases, T-8 packaged recovery coverage.

## Future roadmap ideas

### N-12 - Add opt-in recording with an explicit privacy and storage design

- **Severity:** Nice-to-have
- **Location:** New host/media feature; privacy/terms and storage configuration
- **Description:** Sessions are ephemeral and cannot currently be retained by the product.
- **Why it matters for production:** Recording can be valuable for presentations and support, but it changes consent, disk, retention, deletion, and legal obligations.
- **Recommended fix:** Only pursue with visible participant consent, disabled-by-default operation, quotas, retention/deletion controls, encrypted storage expectations, and failure-safe cleanup.
- **Blocker before production:** No.
- **Related risks/dependencies:** Privacy/legal review, disk exhaustion, codec/container compatibility.

### N-13 - Consider collaboration features only after the one-host media contract is stable

- **Severity:** Nice-to-have
- **Location:** Future product scope
- **Description:** Chat, reactions, multiple presenters, moderated rooms, scheduling, and persistent room history are natural extensions but add identity, abuse, retention, and synchronization requirements.
- **Why it matters for production:** These features could improve usefulness, yet adding them before the current trust/lifecycle boundaries are stable would multiply operational risk.
- **Recommended fix:** Validate demand one feature at a time; start with ephemeral reactions or moderated presenter handoff, and create a separate threat/privacy model before adding persistence or accounts.
- **Blocker before production:** No.
- **Related risks/dependencies:** S-1, A-5, moderation, accessibility, durable-state architecture.
