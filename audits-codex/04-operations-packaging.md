# Operations and Packaging Findings

## OP-01 — Quick Tunnel is treated as a production public path

Severity: High

Cloudflare describes Quick Tunnels as intended for testing and documents a 200 concurrent-request limit:

- https://developers.cloudflare.com/tunnel/setup/

The packaged application starts one automatically and presents the result as the primary public link. Quick Tunnel URLs also change after restart.

For production, support a named tunnel or custom reverse proxy with stable configuration. If the project remains a personal sharing tool, state the supported scale and availability expectations clearly.

## OP-02 — Tunnel subprocess supervision can hang or permanently fail

Severity: High

lib/tunnel.js:101-106 removes stdout/stderr data listeners after finding the public URL but leaves both child pipes open. Sufficient output can fill a pipe and block cloudflared.

lib/tunnel.js:72-84 also checks child.killed when deciding whether to send the force-kill fallback. That property becomes true when a signal is sent, not when the process exits, so a child that ignores SIGTERM may never receive the intended second-stage termination.

The server handles tunnel exit by changing status but does not restart with backoff.

Fix:

- Keep stdout and stderr drained for the child lifetime.
- Retain durable error and exit listeners.
- Track exitCode or an explicit exited promise.
- Escalate termination only after a real timeout.
- Restart with bounded exponential backoff.
- Notify the host when the public URL changes.
- Stop restarting after an explicit application shutdown.

## OP-03 — Packaging bypasses the full release gate

Severity: High

package.json:27 defines package as build plus package-app. update-nextra-exe.bat:27-31 likewise performs only build and packaging. Neither requires lint, tests, OSS preflight, or dependency audit.

This allowed packaging to remain mechanically possible while release:prep was failing on vulnerable dependencies.

Create one authoritative release command:

1. clean install
2. lint
3. unit and integration tests
4. production build
5. OSS/license check
6. root and nested dependency audits
7. Windows package
8. packaged smoke test
9. signing
10. checksums, SBOM, and provenance

## OP-04 — Local/PATH cloudflared trust is inconsistent

Severity: Medium

scripts/package-app.js verifies a downloaded cloudflared checksum, but can also bundle a binary found on PATH around :294-302. update-nextra-exe.bat explicitly enables the local project binary.

The checked local cloudflared.exe has a valid Authenticode signature, which is positive, but the packaging rule should enforce that rather than relying on a one-time manual check.

Pin an approved version and SHA-256, verify Authenticode publisher details on Windows, and fail packaging when the supplied binary does not match.

## OP-05 — Bundled cloudflared is behind the currently published release

Severity: Medium

The local binary reports 2026.2.0 and is started with --no-autoupdate. At audit time the upstream repository listed a newer 2026.6.0 release:

- https://github.com/cloudflare/cloudflared

Automated application releases should deliberately update, verify, and test the bundled tunnel client rather than inheriting a stale project-local binary.

## OP-06 — The executable is unsigned

Severity: High

Nextra.exe has a matching adjacent checksum but no Authenticode signature. A hash beside the artifact does not authenticate the publisher because an attacker can replace both files.

Sign the final immutable executable, timestamp the signature, publish the certificate identity, and verify the signature in the release workflow.

## OP-07 — Runtime logs have no size rotation

Severity: Medium

lib/startupRuntime.js prunes historical logs at startup, then duplicates stdout and stderr to files around :210-220. There is no active size-based rotation or retention enforcement while a process remains running.

A long-lived or noisy packaged instance can consume unbounded disk space.

Add:

- maximum file size
- generation count or age retention
- atomic rotation
- backpressure/error handling
- redaction rules for room codes, tokens, and ICE credentials

## OP-08 — No dedicated health and readiness contract

Severity: Medium

The project has metrics, but no minimal unauthenticated liveness endpoint or readiness endpoint that verifies required internal components.

Recommended semantics:

- /healthz: process event loop is alive
- /readyz: HTTP server, mediasoup worker/router, required port listeners, and configured dependencies are ready
- detailed diagnostics: authenticated/local-only

Readiness should fail during startup and graceful shutdown.

## OP-09 — restart.bat can terminate unrelated software

Severity: Medium

restart.bat:1-4 finds any listener on port 3000 and force-kills its PID before starting the server.

This is destructive when another application legitimately owns that port. Track Nextra's PID in a scoped file, validate the executable/command line before stopping it, or simply fail with an actionable port-in-use message.

## OP-10 — Release CI lacks Windows package coverage

Severity: High for binary releases

The current CI gate runs on Ubuntu and does not prove:

- package-app behavior on Windows
- Authenticode signing
- executable extraction and startup
- bundled cloudflared discovery
- Windows interface selection
- graceful shutdown and log placement

Add a Windows job and smoke-test the exact artifact that will be released. Pin third-party GitHub Actions by immutable commit SHA for stronger workflow supply-chain integrity.

## OP-11 — Version metadata is inconsistent

Severity: Medium

package.json declares 1.0.0 while repository tags include 1.01, 1.02, 1.1, 2.0.0, and 2.0.1.

This can break update comparisons, executable metadata, support reports, cache identifiers, and release automation. Adopt semantic versioning consistently and derive package/executable version metadata from the release tag.

## OP-12 — Nested proof-of-concept dependencies are outside the root gate

Severity: Medium

poc-mediasoup has its own package lock and a high-severity tar audit result. Root npm audit does not cover it.

Decide whether the proof of concept is:

- maintained and included in CI/audits
- archived with a clear non-production notice
- removed from the release repository

Do not silently leave an independently installable vulnerable package.

## OP-13 — No explicit fatal-error and supervision policy

Severity: Medium

The server has startup error handling and signal handlers, but no complete production policy for uncaught exceptions, unhandled rejections, mediasoup worker death, repeated FFmpeg failure, or tunnel failure.

Define which failures:

- isolate one room
- restart a subsystem
- mark readiness false
- gracefully terminate for an external supervisor

Document a supported supervisor such as Windows Service management, systemd, or a container orchestrator.

## OP-14 — License and corresponding-source artifacts are not packaged

Severity: High for distribution

scripts/package-app.js copies server.js, config.js, package metadata, lib, and dist, but does not include LICENSE, applicable third-party notices, or clear corresponding-source instructions.

Because the package declares GPL-3.0-only and bundles Apache-2.0 software, the release process should include a reviewed source and notice plan:

- https://www.gnu.org/licenses/gpl-3.0.html.en
- https://www.gnu.org/licenses/gpl-faq.en.html
- https://www.apache.org/legal/apply-license

This audit flags a process gap, not a legal conclusion. The final distribution should receive appropriate legal review.
