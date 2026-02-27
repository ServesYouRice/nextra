# Nextra

Nextra is a low-latency screen-sharing app.
One person hosts a stream, and others join from a browser.
Vibe coded this into existence as other apps like Discord were always found lacking. If you notice any mistakes or want to contribute, feel free to do so. 

## What You Need

- Host: Windows machine running `Nextra.exe`
- Viewers: any modern browser (no install)
- Internet sharing: included by default in release builds (auto tunnel)

## Host Guide (Fast Path)

1. Run `Nextra.exe`. You can find it in the GitHub Releases.
2. Open `https://localhost:3000/#host`.
3. Click `Start Sharing`.
4. Copy either:
   - `Public Link` for internet viewers, or
   - `Local Link` / room code for same-network viewers.
5. Keep Nextra running while streaming.

## Viewer Guide

1. Open the host's link, or go to `https://localhost:3000/#watch`.
2. Enter the room code if needed.
3. Click watch/play when prompted.

No install is required for viewers.

## Internet Sharing (Default Behavior)

Nextra tries internet sharing automatically on startup (Cloudflare quick tunnel).

- If successful: host sees a `Public Link` and can share it immediately.
- If unavailable: app still works in local/LAN mode.

## Quality Expectations

Nextra targets high quality (up to 1080p/60 when conditions allow), but real quality depends on:

- Host upload bandwidth
- Viewer download bandwidth
- CPU/GPU/browser limits
- NAT/firewall path (direct vs relay)

## Security and Privacy

Nextra includes practical protections, but no software can promise perfect security.

Current model:

- HTTPS + WebRTC transport encryption in transit
- Room-code based access (no user accounts)
- Rate limiting and connection limits on signaling
- Strict default proxy/header trust settings
- `.env`, TLS keys, binaries ignored by default in source workflow
- Media is not persisted by Nextra itself

Important limits:

- Anyone with the room code/link can attempt to join.
- Tunnel providers, TURN servers, ISPs, and network operators are external parties.
- You should treat this as secure-by-default self-hosted software, not as a zero-trust classified system.

## Troubleshooting

- No public link:
  - Wait a few seconds after startup.
  - If still missing, share local link/room code (LAN) or configure manual `SHARE_BASE_URL`.
- Viewers cannot connect:
  - Confirm host firewall allows app traffic.
  - Keep host app running.
- Poor quality:
  - Reduce host desktop load.
  - Lower expected resolution/framerate.
  - Use wired connection for host when possible.

## For Maintainers (Minimal)

```bash
npm install
npm run lint
npm run build
npm run package
```

`npm run package` builds a release `Nextra.exe` and bundles runtime dependencies for end users.

> **Note on Distribution:** Do not commit the generated `Nextra.exe` to the Git repository. Instead, distribute it to users via **GitHub Releases**.
