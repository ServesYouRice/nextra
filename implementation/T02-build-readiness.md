# T02 — Clean build and truthful readiness

Depends on T01.
Findings: CF-02, CF-06.

<goal>
Make tests and release preparation independent of an ignored pre-existing
`dist/`, and make `/readyz` report the components required by the active profile.
</goal>

<read>
`package.json`, `server.js`, `tests/serverIntegration.test.js`,
`scripts/smoke-packaged.ps1`, and the readiness/operations text in `README.md`.
</read>

<do>
1. Reproduce the server integration and `release:prep` behavior with root `dist/`
   absent. Tests must create/own their prerequisite; never delete a user's build.
2. Add focused coverage for missing `dist/index.html`: production readiness is
   503 and SPA navigation returns the documented build-required response.
3. Compute readiness from named states: HTTP, Socket.IO, mediasoup worker, SPA,
   and WHIP when that component is enabled and required by the profile.
4. Keep `/healthz` as process liveness. Return component details on readiness 503.
5. Update only the affected README and packaged-smoke expectations.
</do>

<accept>
- A clean checkout can run the integration/release sequence without stale `dist/`.
- Missing SPA or required WHIP is unready; disabled optional fallback is not.
- `/healthz` remains 200 while the process is alive.
</accept>

<checks>
Run the focused server integration and readiness tests, then `npm run release:prep`.
</checks>

<stop>
Block if the supported deployment profile cannot be derived from existing config;
ask one question naming the conflicting modes.
</stop>
