# Packet 02 - Clean build contract and profile-aware readiness

Findings: CF-02 and CF-06. Prerequisite: Packet 01.

## Objective

Remove the integration suite's hidden reliance on an ignored `dist/` and make
`/readyz` accurately represent the supported source/service profile.

## Read first

- `package.json`, `tests/serverIntegration.test.js`
- static delivery, `/readyz`, WHIP/FFmpeg startup in `server.js`
- `docs/service-deployment.md`, README readiness text
- `scripts/smoke-packaged.ps1`

## Decision before editing

Record the minimal component contract. Packaged/personal always requires the SPA;
WHIP is required when enabled and part of the declared profile; FFmpeg/NVENC may
be degraded rather than fatal if fallback is optional. Do not invent a general
profile framework if a small explicit predicate is sufficient.

## Plan

1. Make the SPA integration test own its build prerequisite. Build before the
   integration suite or inject an isolated static fixture/path; never depend on
   root `dist/` already existing.
2. Test missing `dist`: SPA navigation returns the documented build-required
   response and production readiness is false.
3. Compute readiness from named component states, including `dist/index.html`
   and enabled required WHIP status.
4. Keep `/healthz` as liveness and return component details on readiness 503.
5. Update service/README claims and packaged smoke expectations.

## Invariants

- Development keeps the helpful build-required response and does not crash.
- Health and readiness remain distinct.
- Optional NVENC/FFmpeg optimizations do not accidentally make every profile unready.
- Tests never delete/mutate the user's root `dist/`.
- A stale build cannot satisfy a clean-checkout test.

## Acceptance criteria

- Server integration passes with root `dist/` absent.
- Missing production SPA yields readiness 503 and the expected SPA response.
- Required enabled WHIP failure yields readiness 503; disabled/optional behavior is documented.
- `/healthz` remains 200 while alive.
- `release:prep` passes from a fresh clone after Packet 01.

## Dispatch objective

```xml
<objective>
Make release preparation independent of a pre-existing root dist directory, then
make /readyz reflect the documented production/service component contract. Add
focused integration tests for missing SPA and enabled WHIP failure, preserve
/healthz liveness, and update only directly affected docs/scripts.
</objective>
```
