# Security Issues

Revalidated against commit `2ba6c09` on 2026-07-14.

Nextra binds to loopback by default. The remaining findings are conditional exposure or defense-in-depth concerns, not unconditional internet-facing blockers.

Legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low

---

## S-2 🟠 WHIP bearer tokens use plain HTTP when the listener is widened

- **Severity:** High when `WHIP_BIND_HOST` is exposed beyond the local host; not applicable to the loopback default
- **Blocker:** Conditional
- **Location:** WHIP side listener in `server.js`; bearer validation in `lib/whipRoutes.js`; `WHIP_BIND_HOST` in `config.js`

**Problem.** The OBS-compatible WHIP side listener uses HTTP because OBS does not reliably accept the application's self-signed local HTTPS certificate. Its bearer value is also the room host token. With the default `WHIP_BIND_HOST=127.0.0.1`, the token does not cross the network. If an operator binds WHIP to a LAN or public interface, the token and SDP travel without transport encryption.

**Impact.** A party able to observe that network path could reuse the host token and interfere with the room.

**Fix.** Keep the loopback default. Warn or require explicit acknowledgement for non-loopback WHIP, and document an encrypted reverse proxy or VPN as the supported remote-OBS posture. Consider separating/rotating the WHIP credential from the host reclaim token.

---

## S-6 🟢 CSP permits inline styles

- **Severity:** Low / Medium-low defense-in-depth
- **Blocker:** No
- **Location:** Helmet CSP directives and the unbuilt-client fallback in `server.js`

**Problem.** `style-src` includes `'unsafe-inline'`. This weakens style-injection protection if a separate HTML injection flaw is introduced. Scripts remain nonce-restricted, and the current inline styling is used by the server's unbuilt-client fallback page.

**Fix.** Move the fallback styling into a static stylesheet, verify the production and fallback paths, and then remove `'unsafe-inline'` if the resulting compatibility benefit justifies the change.

---

## S-10 🟢 FFmpeg defaults to resolution through `PATH`

- **Severity:** Low
- **Blocker:** No
- **Location:** `FFMPEG_PATH` in `config.js`; child-process creation in `lib/ffmpegRelay.js`

**Problem.** `FFMPEG_PATH` defaults to the bare command `ffmpeg`. A party already able to alter the service account's environment or place an earlier executable on `PATH` could substitute the binary.

The cloudflared resolver is more constrained: system command/cwd candidates are admitted only through an explicit path or `ALLOW_SYSTEM_CLOUDFLARED=1`, so it is not retained as the same default-path finding.

**Fix.** Recommend an absolute `FFMPEG_PATH` for unattended deployments and report the resolved binary/version at startup. This remains low risk for the intended single-user desktop posture.

---

## Trust-model notes that are not vulnerabilities

- The six-character CSPRNG room code is intentionally the viewer credential, and the documentation states that anyone with the code or link can attempt to join. An optional passphrase or approval lobby remains a product enhancement.
- Remote media control is disabled at server level by default, requires per-room host opt-in, admits only room viewers, invokes a fixed non-interpolated media-key command, and has room-wide plus per-viewer cooldowns. Its PowerShell/xdotool fallback is an explicitly constrained capability, not a current command-injection finding.

## Current assessment

No unconditional security blocker from the original audit remains. S-2 matters when an operator deliberately broadens the WHIP listener; S-6 and S-10 are defense-in-depth hardening.
