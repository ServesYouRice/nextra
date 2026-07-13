# Security Issues

Revalidated against the current working tree on 2026-07-13.

Nextra binds to loopback by default. The remaining findings matter only when an operator broadens that posture.

Legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low

---

## S-2 🟠 WHIP bearer tokens use plain HTTP when `WHIP_BIND_HOST` is widened

- **Severity:** High when exposed beyond the host; not applicable to the loopback default
- **Blocker:** Conditional
- **Location:** the WHIP HTTP listener in `server.js`; bearer validation in `lib/whipRoutes.js`; `WHIP_BIND_HOST` in `config.js`

**Problem.** OBS WHIP uses a separate plain-HTTP listener because OBS does not reliably accept the app's self-signed HTTPS certificate. The bearer value is the room host token. With the default `WHIP_BIND_HOST=127.0.0.1`, it never crosses the network. If an operator changes the bind host to a LAN/public interface, the bearer token and SDP travel without transport encryption.

**Impact.** A client able to observe that network path could reuse the host token to interfere with the room.

**Fix.** Keep the loopback default. Add a startup warning or refusal for non-loopback WHIP unless the operator explicitly acknowledges the risk, and document an encrypted reverse proxy or VPN as the supported remote-OBS setup.

---

## S-6 🟡 CSP still permits inline styles

- **Severity:** Medium-low
- **Blocker:** No
- **Location:** Helmet CSP directives in `server.js`

**Problem.** `style-src` includes `'unsafe-inline'`. That weakens the protection CSP provides if an HTML/style injection bug is introduced elsewhere.

**Fix.** Verify the production UI and the unbuilt-client fallback without inline-style permission, move the fallback page styling into a static stylesheet if necessary, then remove `'unsafe-inline'`.

---

## S-10 🟢 FFmpeg may be resolved through `PATH`

- **Severity:** Low
- **Blocker:** No
- **Location:** `FFMPEG_PATH` in `config.js`; process creation in `lib/ffmpegRelay.js`

**Problem.** `FFMPEG_PATH` defaults to the bare command `ffmpeg`, so it is resolved through the process environment. An attacker who can already alter the service account's `PATH` or place an earlier executable could substitute the binary.

**Fix.** Recommend or require an absolute `FFMPEG_PATH` for unattended deployments and verify the selected binary at startup. This is low risk for the intended single-user desktop posture.

---

## Current assessment

No unconditional internet-exposure blocker from the original security audit remains. S-2 becomes important only when WHIP is deliberately bound beyond loopback; S-6 and S-10 are defense-in-depth hardening.
