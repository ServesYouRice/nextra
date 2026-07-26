# Deployment and Release Risks

## D-1 - The committed revision cannot be installed or released cleanly

- **Severity:** High
- **Location:** `package-lock.json`; `.github/workflows/ci.yml`; `.github/workflows/release.yml`
- **Description:** Invalid lockfile JSON stops `npm ci`, production audit, packaging evaluation, SBOM generation, CI, and tagged release before meaningful work begins.
- **Why it matters for production:** There is no reproducible artifact or dependency chain from the repository tip.
- **Recommended fix:** Resolve T-1/T-3, run clean Linux and Windows pipelines, and release only the exact tested/signed artifact.
- **Blocker before production:** Yes.
- **Related risks/dependencies:** S-8, signing, npm registry availability.

## D-2 - Trusted signing, clean-machine validation, and legal approval are external blockers

- **Severity:** High
- **Location:** `.github/workflows/release.yml`; `REMAINING-WORK.md:12-35`; `LICENSE`, `SOURCE.md`, `THIRD_PARTY_NOTICES.md`
- **Description:** The workflow requires external signing secrets and validates Authenticode, but no tagged signed release/clean-host result is present. Distribution notices and corresponding-source process await qualified review.
- **Why it matters for production:** Windows trust/reputation and GPL/third-party obligations cannot be certified by repository code alone.
- **Recommended fix:** Assign release/legal owners, install protected signing credentials, run a tag, verify publisher/timestamp/download on a clean Windows VM, and approve the final SBOM/notices/source offer.
- **Blocker before production:** Yes.
- **Related risks/dependencies:** T-1, artifact publication, certificate rotation.

## D-3 - Target hardware, long-duration media, and real topology limits are unproven

- **Severity:** High
- **Location:** `REMAINING-WORK.md:36-80`; benchmark/churn docs
- **Description:** Required 1080p/1440p/4K load runs, 30-60 minute live churn, real OBS/FFmpeg, direct public media, strict NAT/TURN, and tunnel relay validation remain open.
- **Why it matters for production:** Desktop media performance is dominated by host GPU/driver/network behavior that unit tests cannot model.
- **Recommended fix:** Execute the existing matrices on the intended hardware and network classes, retain three passing runs, and turn measured limits into the supported deployment envelope.
- **Blocker before production:** Yes.
- **Related risks/dependencies:** P-3/P-6, L-1, external provider access.

## D-4 - Quick Tunnel is a convenience path, not a production availability boundary

- **Severity:** Medium
- **Location:** `.env.example:15-29`; `README.md:165-184`; `lib/tunnelSupervisor.js`
- **Description:** Packaged mode defaults to an automatic Cloudflare tunnel and retries failures, but the app has no stable-domain/SLA ownership, provider health integration, or viewer migration when the ephemeral hostname changes.
- **Why it matters for production:** A tunnel restart invalidates previously shared links, and HTTP tunnel availability does not expose the mediasoup UDP media plane. Public browser capture therefore depends heavily on the relay path that currently has L-1.
- **Recommended fix:** Position Quick Tunnel as best-effort personal sharing. For a supported service, use a named/stable tunnel or maintained reverse proxy, explicit TURN/media-plane design, health monitoring, and link-rotation UX.
- **Blocker before production:** Not for clearly labeled personal/best-effort use; yes for an availability claim.
- **Related risks/dependencies:** L-1, S-1, external network matrix.

## D-5 - Readiness does not reflect the supported component contract

- **Severity:** Medium
- **Location:** `server.js:961-977`, `server.js:980-1063`
- **Description:** `/readyz` can be 200 with no client build or failed enabled WHIP/fallback dependencies.
- **Why it matters for production:** Supervisors can route users to an instance whose core UI or OBS flow is unavailable.
- **Recommended fix:** Implement readiness profiles and fail source-production readiness when `dist` is missing; document whether WHIP/FFmpeg are required or degraded components.
- **Blocker before production:** Yes for supervised source/service deployments.
- **Related risks/dependencies:** L-7, T-2.

## D-6 - Deployment is single-replica and restart-destructive by design

- **Severity:** Medium
- **Location:** `docs/service-deployment.md`; in-memory registries in `lib/sessionRegistry.js` and `lib/rooms.js`
- **Description:** Rooms, host tokens, WHIP/WHEP resources, and media transports exist only in one process. Multiple replicas, rolling restarts, and transparent failover are unsupported.
- **Why it matters for production:** Any process restart ends active rooms; load balancing without affinity breaks signaling/media ownership.
- **Recommended fix:** Enforce/document exactly one supervised replica and maintenance windows. Only design external state, sticky routing, and room affinity if multi-instance hosting becomes a committed product target.
- **Blocker before production:** No for the documented personal/single-node target; yes for HA/multi-instance deployment.
- **Related risks/dependencies:** L-2, A-1, backup/rollback expectations.

## D-7 - The Windows packager is archived

- **Severity:** Medium
- **Location:** `docs/packaging-evaluation.md`; `scripts/package-app.js`; `caxa` dependency
- **Description:** The project deliberately retains `caxa` because current native/media behavior is verified, but the packager is archived and has no future maintenance/security guarantee.
- **Why it matters for production:** A future Node/native dependency or security change can force a migration under time pressure.
- **Recommended fix:** Keep the current verified path for this release, monitor advisories, and maintain a time-boxed Node SEA feasibility spike with the acceptance criteria already documented. Do not migrate before equivalent media/child/signing tests pass.
- **Blocker before production:** No once current packaging passes cleanly.
- **Related risks/dependencies:** T-8, Node major upgrades, mediasoup native loading.

## D-8 - Runtime dependencies can degrade supported OBS/public flows

- **Severity:** Medium
- **Location:** startup FFmpeg/cloudflared resolution in `server.js:1260-1300`; `.env.example`; packaging script
- **Description:** Missing FFmpeg disables OBS fallback; missing/failed cloudflared disables the default public link. Startup continues and readiness can remain green.
- **Why it matters for production:** Operators may believe the deployment is healthy until viewers need fallback or a host requests a public link.
- **Recommended fix:** Expose explicit component health and startup diagnostics, define required-versus-optional deployment profiles, alert on tunnel/FFmpeg loss, and pin absolute executable paths in managed deployments.
- **Blocker before production:** Conditional on advertised enabled features.
- **Related risks/dependencies:** D-5, packaging manifest/signature verification.

## D-9 - Artifact publication and rollback are mostly manual

- **Severity:** Low
- **Location:** `.github/workflows/release.yml`; `docs/service-deployment.md`; `update-nextra-exe.bat`
- **Description:** Tagged CI uploads an Actions artifact but does not create a durable GitHub Release, publish notes, test upgrade/downgrade, or automate rollback. The update batch file rebuilds locally rather than securely updating an installed binary.
- **Why it matters for production:** Users can struggle to identify the supported build, verify provenance, receive fixes, or return to a known-good version.
- **Recommended fix:** Publish signed executable/checksum/SBOM/source tag as a release, add versioned release notes and rollback instructions, retain prior signed artifacts, and design an updater only with signature verification and explicit consent.
- **Blocker before production:** No for a manually distributed pilot; important before broad distribution.
- **Related risks/dependencies:** Signing approval, release retention, update threat model.

## Recommended deployment order

1. Repair dependency/install/release reproducibility (D-1).
2. Fix public relay, host authorization, restart semantics, and readiness.
3. Obtain signed clean-machine and legal approval (D-2).
4. Complete target-host, churn, OBS, tunnel, AV1, and TURN evidence (D-3).
5. Declare the supported single-node/Quick-Tunnel contract and required component profile.
6. Publish the signed artifact with checksum/SBOM/source reference and rollback procedure.
