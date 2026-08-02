<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/brand/nextra-primary-logo.png">
  <img src="public/brand/nextra-primary-logo-light.png" alt="Nextra" width="420">
</picture>

**Self-hosted, low-latency screen sharing from your browser or OBS.**

</div>

---

Vibe coded this into existence because the usual screen sharing apps were either limited or paid. If you notice mistakes or want to contribute, feel free to jump in.

TL;DR: there are 2 host modes:

1. Browser capture: easiest setup, direct from Chrome/Edge, lower requirements.
2. OBS ingest: better scenes, overlays, and hardware encoding.
   - H.264 is the stable default path and keeps relay fallback available.
   - AV1 is available when OBS can set and verify an AV1 encoder, but it is WebRTC-only and requires BYOK TURN.

You can grab `Nextra.exe` from [GitHub Releases](../../releases), run it, and start sharing. Install OBS only if you want the OBS workflow.

---

## Features

- **Browser capture** - share your screen directly from Chrome/Edge with system audio
- **OBS streaming** - use OBS Studio as the capture source via WHIP ingest, with auto-configuration over OBS WebSocket
- **AV1 OBS rooms** - try bounded NVIDIA, AMD, and Intel encoder candidates and keep the first one OBS verifies for WebRTC-only playback
- **BYOK TURN for AV1** - room-scoped TURN credentials, optional session-only storage, and optional Cloudflare TURN autofill
- **Up to 4K @ 60 fps** - quality profiles adapt to host upload and viewer count
- **WebRTC + Relay playback** - browser capture and AV1 stay on WebRTC; H.264 OBS rooms can fall back to fMP4 relay
- **Personal public sharing** - built-in Cloudflare Quick Tunnel for convenient, best-effort links; not a production availability contract
- **Remote media control** - viewers can pause/play media on the host machine when enabled by the host
- **Status dashboard** - local server metrics for rooms, WebRTC viewers, relay viewers, WHEP viewers, and runtime counters
- **No accounts or sign-ups** - room-code based access

---

## Quick Start

### Host (Packaged)

1. Download `Nextra.exe` from [GitHub Releases](../../releases).
2. Run it and open `http://127.0.0.1:3000/#host`.
3. Click **Start Sharing** for browser capture, or enable **Use OBS (WHIP ingest)** first if you want OBS mode.
4. Send viewers the **Public Link** for internet viewing or the **Local Link** / room code for LAN viewing.

### Host (From Source)

```bash
git clone <repo-url>
cd nextra
npm install
npm run build        # build the client (required before npm start)
npm start
```

Open `http://127.0.0.1:3000/#host` and choose either browser capture or OBS mode.

### Viewer

1. Open the link the host shared, or navigate to `http://<host>:3000/#watch` for LAN viewing.
2. Enter the room code if needed.
3. Click **Watch Stream** when prompted.

No install is required for viewers.

### Tested browsers

Nextra makes no general "any modern browser" claim. The table records only the
paths this repository tests end to end (`npm run test:e2e`, Playwright Chromium
and mobile Chrome projects). Untested browsers are not blocked: the client
feature-detects WebRTC receive codecs and Media Source Extensions instead of
sniffing the browser name, so an unsupported browser gets an explicit message.

| Role and path | Desktop Chrome / Edge | Mobile Chrome | Other browsers |
| --- | --- | --- | --- |
| Host, browser capture | Tested | Not supported (no screen capture) | Not tested; `systemAudio` capture is Chromium-only |
| Host, OBS (WHIP) | Tested | Not supported | Not tested |
| Viewer, WebRTC | Tested | Tested | Not tested |
| Viewer, relay (H.264/WebM) | Tested | Not tested | Not tested |

Layout and keyboard flows are checked at 320, 375, 640, 900, 1024, 1280, 1440,
1600, and 2560 px viewport widths, and the host page is checked for vertical fit
at 1366x768 and 1280x720. No WCAG conformance level is claimed.

The host page changes shape at two widths: below 1280 px the OBS settings card
moves under the room settings card instead of beside it, and below 900 px the
settings column moves under the video stage.

---

## OBS Streaming

Use OBS Studio instead of browser screen capture for higher quality, custom scenes, and hardware encoding.

### Requirements

- OBS Studio 28+ with WHIP output and WebSocket v5
- FFmpeg on the server PATH for H.264 relay playback
- A TURN service if you want AV1 OBS rooms to work for remote or tunnel viewers
- Optional server-side Cloudflare TURN credentials if you want the host modal to autofill short-lived TURN values

### Setup

1. On the host page, enable **Use OBS (WHIP ingest)**.
2. Choose your OBS path:
   - **Stable H.264**: leave **Use BYOK TURN (AV1)** off. This keeps relay fallback available and is the best compatibility path.
   - **AV1 WebRTC-only**: enable **Use BYOK TURN (AV1)**. This requires an AV1 encoder that OBS can verify, OBS auto-configuration, and a TURN config in the modal. Relay fallback is disabled for that room.
3. Choose your settings:
   - **Resolution / Frame rate** - determines the quality profile and recommended OBS output settings
   - **Apply recommended output settings** - auto-configures OBS output over WebSocket; required for AV1 mode
   - **Tuning** - `Balanced`, `Crisp`, or `Max`
   - **Auto-start streaming in OBS** - starts the WHIP stream after configuration
   - **WS password** - your OBS WebSocket password, or blank if OBS auth is disabled
   - **BYOK TURN modal** - for AV1 rooms, provide TURN URLs plus either a shared secret or static username/password
4. Click **Start Sharing**. Nextra creates the room, configures OBS, and starts the WHIP stream.

### H.264 vs AV1

| Mode | Best For | Relay Fallback | TURN Requirement |
|---|---|---|---|
| **OBS H.264** | Mixed viewer devices, tunnel viewers, maximum compatibility | Yes | Optional but recommended for strict NAT |
| **OBS AV1 + BYOK TURN** | Capable GPUs and browsers, lowest-latency OBS playback | No | Required |

- H.264 rooms can still use direct WebRTC when it works, and viewers can switch into relay mode when needed.
- Relay playback starts a fresh recorder generation when its audience changes from zero to one, so late viewers receive current initialization data and a decodable frame without restarting viewers already connected.
- AV1 rooms are WebRTC-only. Every viewer's loaded WebRTC receive RTP capabilities must include `video/AV1`, and the server must expose a reachable media plane (`PUBLIC_IP` plus non-loopback `RTC_LISTEN_IP`). MP4/MSE support does not prove WebRTC AV1 support. A generic external TURN service does not make a loopback-only mediasoup listener public.
- Room-scoped TURN credentials override any global TURN setting for that room only and are cleared when the room ends.

### How It Works

```text
H.264 OBS:
OBS --WHIP--> Nextra server --mediasoup--> viewers (WebRTC)
                                 |
                                 +--> FFmpeg relay --> viewers (fMP4 / MSE)

AV1 OBS:
OBS --WHIP--> Nextra server --mediasoup--> viewers (WebRTC only, with TURN)
```

### OBS Auto-Configuration

When **Apply recommended output settings** is checked, Nextra sends these settings to OBS via WebSocket:

| Setting | Value |
|---|---|
| Output mode | Advanced |
| Video encoder | Best available H.264 or AV1 hardware encoder for the selected room mode |
| Video bitrate | Based on selected quality profile, frame rate, and tuning |
| Keyframe interval | 2 seconds |
| Rate control | CBR |
| NVENC preset | Tuning-driven `p5` / `p6` with full-resolution multipass |
| x264 preset | Applied only in H.264 rooms |
| Output resolution | Matches the selected profile (1080p / 1440p / 4K) |
| FPS | 30 or 60 |
| Audio bitrate | 256 kbps |
| Audio sample rate | 48 kHz |
| Color space | BT.709, Full range |

Additional H.264-only tuning:

- High profile
- `zerolatency` tune
- 0 B-frames
- Simple Output page mirrored when OBS exposes a compatible H.264 encoder

### Manual OBS Setup

Manual WHIP setup is mainly for the H.264 path. AV1 rooms still require OBS auto-configuration so the app can switch the encoder to AV1 before the room starts.

1. In OBS, open **Settings > Stream** and choose **Service: WHIP**.
2. Server: `http://<host-ip>:3001/whip/broadcast/<room-code>`
3. Bearer Token: copy it from the host page
4. If the room is H.264, use the recommended settings above.
5. If the room is AV1, keep AV1 selected in OBS output and make sure the BYOK TURN modal was completed first.

---

## Playback Modes

| Mode | Transport | When Used |
|---|---|---|
| **WebRTC** | Direct mediasoup playback | Browser capture, AV1 OBS rooms, and H.264 OBS rooms when the direct path works |
| **Relay** | fMP4 over Socket.IO + MSE | H.264 OBS rooms, tunnel viewers without TURN, or manual fallback |
| **WHEP** | Standards-based WebRTC egress | Optional external-player playback when `WHEP_ENABLED=true` |

- Cloudflare quick tunnels do not carry UDP. Without TURN, public viewers prefer relay when relay is allowed.
- AV1 OBS rooms disable relay entirely. If TURN is missing or the browser cannot play AV1, those viewers will fail instead of falling back.
- Only H.264 OBS rooms expose the **Switch to Relay Mode** button.
- The relay player stays near the live edge and auto-recovers from stalls.
- When WHEP is enabled, the host page shows an **External Player (WHEP)** copy link at `/whep/watch/<room-code>` for GStreamer, web-based WHEP players, or custom WebRTC clients.

---

## Internet Sharing

Packaged `Nextra.exe` automatically starts a Cloudflare quick tunnel and shows a **Public Link** once ready.

Quick Tunnels are a convenience path for personal/testing use: URLs change, availability is not guaranteed, and Cloudflare documents a concurrent-request limit. Production deployments should configure a named tunnel or reverse proxy for HTTP plus a separately reachable WebRTC media plane, or use H.264 relay-only public playback.

For source/dev:

- Set `AUTO_PUBLIC_TUNNEL=true` if you want the app to create a Cloudflare tunnel automatically.
- Ensure the `cloudflared` binary is in the project root or on PATH. Download it from [Cloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
- For a stable named tunnel, set both `CLOUDFLARED_TUNNEL_TOKEN` and `SHARE_BASE_URL`; configure the tunnel's public hostname to forward to Nextra. The token is passed to `cloudflared` through its environment, not its command line.
- Or set `SHARE_BASE_URL` if you already have your own reverse proxy or public domain.
- Without either, the app stays local/LAN only.

Tunnel notes:

- Browser capture and OBS H.264 rooms can still serve public viewers without TURN because relay is available.
- OBS AV1 rooms require a publicly reachable mediasoup media address; TURN credentials alone cannot expose a loopback-only media listener. The UI disables public AV1 when that topology is not configured.

---

## Status Dashboard

Open `http://127.0.0.1:3000/#status` on the host machine to see active rooms, WebRTC viewers, relay viewers, WHEP viewers, mediasoup consumers, relay throughput, and socket runtime counters. The page refreshes every 5 seconds and handles restricted or unavailable metrics with a friendly error state.

The JSON metrics and readiness responses also report `fallbackRelay.nvencProbe`. The probe is warmed in the background during startup; `probing` does not make the service unready because the relay can use libx264 when NVENC is unavailable. For capacity tests, record `/api/metrics` repeatedly and correlate room/viewer topology with `process.cpuUsageMicroseconds`, `process.eventLoopDelayMs`, `mediaWorker.resourceUsage`, memory, relay throughput, and signaling acknowledgement latency measured by the load client. CPU counters are cumulative, so calculate the change between samples over the sample interval.

Sensitive JSON metrics at `/api/metrics` use the operator boundary: loopback and explicitly trusted LAN clients are allowed, while other clients must send `X-Nextra-Operator-Token`. The Prometheus/OpenMetrics endpoint at `/metrics` keeps its separate `METRICS_TOKEN` bearer capability.

---

## Quality Profiles

Recommended OBS bitrate targets below are for the stable H.264 relay path. The table shows the `Balanced` baseline; `Crisp` adds about 15% and `Max` adds about 30%, with tuned OBS output capped at 45 Mbps.

| Profile | Resolution | H.264 30fps | H.264 60fps |
|---|---|---|---|
| 1080p | 1920x1080 | 12 Mbps | 15 Mbps |
| 1440p | 2560x1440 | 18 Mbps | 24 Mbps |
| 4K | 3840x2160 | 30 Mbps | 40 Mbps |

- The default profile is auto-detected from the host screen resolution.
- Browser/WebRTC profile caps are 1080p `8 / 12 Mbps`, 1440p `14 / 21 Mbps`, and 4K `26 / 36 Mbps`.
- AV1 rooms currently use the same resolution, FPS, and tuning envelopes; the table above remains the compatibility baseline for H.264 relay rooms.

---

## Configuration

Copy `.env.example` to `.env` and edit as needed. Key options:

### Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Browser server port |
| `BIND_HOST` | `127.0.0.1` | Bind address |
| `OPEN_BROWSER` | `false` from source, `true` in packaged `Nextra.exe` | Open the host page automatically on startup or duplicate launch |
| `LOCAL_HTTPS` | `false` | Serve the local app over self-signed HTTPS instead of HTTP |
| `HTTPS_CERT_DIR` | `./certs` | TLS certificate directory when `LOCAL_HTTPS=true` |

### OBS / WHIP

| Variable | Default | Description |
|---|---|---|
| `WHIP_ENABLED` | `true` | Enable WHIP ingest endpoint |
| `PUBLIC_WHIP_ENABLED` | `false` | Also mount WHIP on the main/public server; the dedicated loopback endpoint remains available when this is off |
| `PUBLIC_WHIP_RATE_LIMIT_MAX` | `5` | Public WHIP start attempts per IP per window |
| `PUBLIC_WHIP_MAX_PENDING_STARTS` | `2` | Global cap on concurrent public WHIP startups before SDP/media allocation |
| `WHIP_HTTP_PORT` | `3001` | HTTP port for WHIP endpoint |
| `WHIP_BIND_HOST` | `127.0.0.1` | Bind address for the plaintext OBS-compatible WHIP endpoint |
| `WHIP_ALLOW_INSECURE_REMOTE` | `false` | Explicitly acknowledge a non-loopback plaintext WHIP bind; use only behind an encrypted VPN or TLS reverse proxy |
| `FFMPEG_PATH` | `ffmpeg` | Path to FFmpeg; use an absolute trusted path for unattended deployments |
| `FALLBACK_FRAGMENT_DURATION_MS` | `500` | fMP4 fragment duration in ms |
| `FALLBACK_AUDIO_BITRATE` | `192k` | Audio bitrate for relay remux |
| `FALLBACK_AUDIO_OFFSET_MS` | `1500` | Delay OBS relay audio to keep fMP4 playback in sync |
| `MAX_FALLBACK_VIEWERS` | `50` | Max concurrent relay viewers |
| `MAX_FALLBACK_PIPELINES` | `2` | Max simultaneous FFmpeg fallback pipelines on one server |

### WHEP

| Variable | Default | Description |
|---|---|---|
| `WHEP_ENABLED` | `false` | Enable standards-based WHEP viewer egress at `/whep/watch/<room-code>` |
| `WHEP_RATE_LIMIT_MAX` | `5` | Max WHEP session creation attempts per IP per window |
| `WHEP_RATE_LIMIT_WINDOW_MS` | `60000` | WHEP rate-limit window in ms |
| `WHEP_MAX_GLOBAL_SESSIONS` | `30` | Max concurrent WHEP sessions across the server |

### TURN / AV1

| Variable | Default | Description |
|---|---|---|
| `TURN_URL` | - | Global TURN URLs used when a room does not provide its own TURN config |
| `TURN_SECRET` | - | Shared secret for ephemeral TURN credentials |
| `TURN_USERNAME` | - | Static TURN username when not using shared-secret auth |
| `TURN_CREDENTIAL` | - | Static TURN credential when not using shared-secret auth |
| `CLOUDFLARE_TURN_KEY_ID` | - | Optional Cloudflare TURN key id for the AV1 BYOK modal autofill |
| `CLOUDFLARE_TURN_API_TOKEN` | - | Server-side Cloudflare API token used to mint short-lived TURN credentials |
| `CLOUDFLARE_TURN_TTL_SECONDS` | `21600` | TTL for generated Cloudflare TURN credentials |

Notes:

- `TURN_URL` can contain multiple comma-separated `turn:` or `turns:` URLs.
- Cloudflare TURN autofill uses the operator boundary; remote operators send `X-Nextra-Operator-Token`.
- The browser never receives the long-lived Cloudflare API token; it only gets short-lived TURN credentials.

### Public Sharing

| Variable | Default | Description |
|---|---|---|
| `AUTO_PUBLIC_TUNNEL` | `false` from source, `true` in packaged `Nextra.exe` | Auto-start Cloudflare tunnel |
| `CLOUDFLARED_TUNNEL_TOKEN` | - | Run a stable named Cloudflare tunnel; requires `SHARE_BASE_URL` |
| `SHARE_BASE_URL` | - | Public URL for a named tunnel or your own reverse proxy |
| `PUBLIC_TUNNEL_PROVIDER` | `cloudflared` | Tunnel provider |

### Rooms & Limits

| Variable | Default | Description |
|---|---|---|
| `MAX_VIEWERS_PER_ROOM` | `10` | Conservative direct WebRTC viewer limit; raise only after load testing |
| `MAX_ACTIVE_ROOMS` | `10` | Conservative single-worker room limit; raise only after load testing |
| `CREATE_ROOM_RATE_LIMIT_MAX` | `10` | Room creation attempts per IP per window |
| `JOIN_RATE_LIMIT_MAX` | `20` | Viewer join or auto-rejoin attempts per IP per window |
| `HOST_UPLOAD_MBPS` | `36` | Assumed host upload bandwidth |
| `RELAY_VIDEO_BITS_PER_SECOND` | `45000000` | Max relay video bitrate ceiling |
| `RELAY_FLUSH_INTERVAL_MS` | `300` | Relay socket flush interval in ms |
| `RELAY_SOCKET_MAX_BUFFERED_BYTES` | `16777216` | Per-viewer relay send-buffer cap before slow viewers are skipped/kicked |
| `MAX_CONNECTIONS_PER_IP` | `60` | Rate limit: connections per IP |
| `SOCKET_PING_TIMEOUT_MS` | `60000` | Grace period before a quiet watcher socket is considered disconnected |
| `METRICS_BROADCAST_INTERVAL_MS` | `5000` | Room metrics broadcast interval |
| `ALLOW_REMOTE_MEDIA_CONTROL` | `false` | Permit hosts to opt viewers into remote Play/Pause keyboard control |
| `OPERATOR_TOKEN` | - | At least 32 high-entropy characters; required for remote room creation, sensitive JSON metrics, and TURN minting |
| `TRUSTED_LAN_CIDRS` | - | Comma-separated explicit operator IPs or IPv4 CIDRs; private addresses are not trusted automatically |
| `ALLOW_INSECURE_TRUSTED_LAN_RELAY` | `false` | Permit plaintext Socket.IO relay bytes only on `TRUSTED_LAN_CIDRS`; WebRTC DTLS does not protect relay payloads |
| `METRICS_TOKEN` | - | Bearer capability for `/metrics` when OpenMetrics is enabled |
| `ENABLE_OPENMETRICS` | `false` | Enable token-gated Prometheus/OpenMetrics output at `/metrics`; requires `METRICS_TOKEN` |
| `LOG_LEVEL` | `info` | Minimum server log level: `debug`, `info`, `warn`, or `error` |
| `LOG_FORMAT` | text | Set to `json` for structured JSON logs with HTTP request correlation fields |
| `MEDIA_DEBUG_LOGS` | `false` | Verbose media-pipeline logging; keep off during normal streams |

See `.env.example` for the full list.

---

## Security and Privacy

- Public HTTPS tunnel links and WebRTC DTLS media encryption in transit
- Room-code based access with no user accounts; hosts may opt into an additional room passphrase
- Rate limiting and connection limits on signaling
- OBS WebSocket communication is localhost-only
- Remote media control is host-controllable per room
- Media is not persisted by Nextra
- Cloudflare TURN API tokens remain server-side; only short-lived TURN credentials are sent to the host UI
- Room creation is loopback-only by default. Remote hosts need the operator capability; public viewers never receive host authority.
- Rotate `OPERATOR_TOKEN` by replacing it and restarting Nextra. Existing in-memory rooms keep their room-scoped host tokens until the restart ends them.
- On HTTP, Socket.IO WebM/fMP4 relay payloads are plaintext. Leave insecure relay disabled except on a declared trusted home LAN; use HTTPS for every other non-loopback path.
- `.env`, TLS keys, and binaries are gitignored

Important limits:

- By default, anyone with the room code or share link can attempt to join. Hosts can set an optional passphrase in the host **Settings** panel; browser viewers are prompted after entering the code, while WHEP clients send `Authorization: Bearer <passphrase>`. Only a salted scrypt hash is kept in ephemeral room state.
- Passphrase hashing runs asynchronously. Pending room creations count toward `MAX_ACTIVE_ROOMS`, and an existing room remains active unless its fully prepared replacement succeeds.
- **Allow recovery after reload** stores the room code and reclaim token in tab-scoped session storage and preserves an opted-in room for the host reconnect grace (30 seconds by default). This only reclaims a room from the same running server process; a process replacement ends every in-memory room. OBS remains attached during same-process recovery; browser capture requires clicking **Resume Sharing** and selecting a screen again. Explicit stop still ends the room immediately.
- Every Local/Public viewer link names one in-memory room. Explicit Host stop or a Nextra process restart retires that link; starting again creates a new room code and link. Joined viewers can copy the canonical current link, but protected-room passphrases are never embedded in it.
- Tunnel providers, TURN servers, ISPs, and network operators are external parties.
- Treat this as secure-by-default self-hosted software, not a zero-trust system.

Operational security:

- A quick tunnel pointing at self-signed local HTTPS may need cloudflared's local-origin `--no-tls-verify`; this relaxes only cloudflared-to-Nextra certificate verification, so never use it for an unrelated upstream.
- Alert when `/readyz` is non-ready, the media-worker PID changes unexpectedly, relay restart/error counters rise, or the tunnel remains in an error/backoff state.
- Run under a single-process supervisor. Unexpected unhandled rejections and uncaught exceptions log a shutdown reason and exit non-zero; mediasoup worker death replaces the process. Either event ends all in-memory rooms.
- Rotate logs outside the process, restrict file access, and redact room codes, bearer capabilities, public capability URLs, TURN credentials, and request headers before sharing diagnostics.
- The Host page's **Troubleshooting diagnostics** export downloads an allowlisted JSON snapshot of readiness, safe configuration flags, topology counts, runtime utilization, and current errors. It excludes room codes, room/public links, credentials, authorization headers, and raw room lists; review the file before sharing it outside your organization.
- Store `OPERATOR_TOKEN`, `METRICS_TOKEN`, TURN secrets, tunnel tokens, and OBS credentials in protected environment/service-secret storage, never in command history, URLs, source control, or client storage.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| No public link | Wait a few seconds after startup. In dev, set `AUTO_PUBLIC_TUNNEL=true`. Ensure `cloudflared` exists in the project root or on PATH. |
| Host preflight blocks startup | Follow the path-specific message: Browser hosting needs desktop capture support on localhost/HTTPS; OBS needs the WHIP listener ready; AV1 additionally needs valid TURN credentials, OBS auto-configuration, and a reachable public media address when sharing publicly. Tunnel startup/failure is only a warning when the local/LAN room can still run. |
| Viewers cannot connect | Check host firewall, keep the host app running, and verify whether the room expects TURN or relay. |
| OBS H.264 viewer is black | Try **Switch to Relay Mode** or refresh. H.264 rooms can fall back to relay. |
| AV1 room will not start | AV1 requires an AV1-capable GPU, **Use BYOK TURN (AV1)**, a valid TURN config, and OBS auto-configuration. |
| Public viewers cannot join an AV1 room | Configure `PUBLIC_IP` and a non-loopback `RTC_LISTEN_IP`, plus suitable ICE/TURN connectivity, or use H.264 relay mode. |
| Viewer browser says AV1 is unsupported | Its loaded WebRTC receive capabilities do not include `video/AV1`; use a compatible browser/device or switch the host back to H.264. |
| OBS auto-config fails | Make sure OBS is running and WebSocket is enabled in **Tools > WebSocket Server Settings**. H.264 rooms can fall back to manual WHIP; AV1 rooms cannot. |
| Audio missing | Ensure OBS is capturing audio in the Audio Mixer. For browser capture, use Chrome or Edge. |
| Buffering or stalls | Lower the quality profile or frame rate. H.264 rooms can use relay; AV1 rooms need a stable TURN-backed WebRTC path. |

## Operations and supported scale

The default limits are intentionally conservative for one desktop process: 10 rooms, 10 direct viewers per room, and 2 simultaneous FFmpeg fallback pipelines. They are safety limits, not a benchmark guarantee. Raise them only after measuring CPU, memory, relay throughput, and event-loop delay on the target host through the local `/api/metrics` endpoint.

Maintainers and operators can use `npm run benchmark:runtime` with a real room/media topology and `npm run churn:runtime` for optional hardware-specific capacity and long-running room/transport validation. The benchmark requires a named `webrtc`, `relay`, or `mixed` scenario and rejects runs that do not contain the expected producers/consumers or active relay bytes. Its JSON summary records the machine/runtime identity and remaining headroom against every configured threshold. These measurements are not required for an open-source release and must not be presented as portable results unless they were actually observed on the named target host.

With the matching live topology already open, representative commands are:

```powershell
# Browser/WebRTC host with five actively consuming viewers
npm run benchmark:runtime -- --scenario=webrtc --label=1080p60-5-viewers --require-consumers=5 --duration-ms=300000

# OBS H.264 room with five viewers already switched to Relay mode
npm run benchmark:runtime -- --scenario=relay --label=1080p60-h264-relay-5-viewers --require-relay-viewers=5 --require-fallback-pipelines=1 --min-relay-bytes=1048576 --duration-ms=300000
```

Run each profile on the deployment hardware, keep the complete JSON output with the profile name, and increase the conservative limits only when signalling, event-loop, CPU, memory, and relay-byte checks all retain acceptable headroom. A run with sockets but no flowing media fails topology validation rather than becoming a capacity claim.

For a loopback-only test server using Nextra's self-signed local HTTPS certificate, `--allow-insecure-tls` disables Socket.IO certificate verification for that benchmark run; Node's HTTPS fetches also require `NODE_TLS_REJECT_UNAUTHORIZED=0`. Never use either setting against a remote or untrusted host. The JSON result records when Socket.IO TLS verification was disabled.

Production supervision means exactly one replica; a restart ends all in-memory rooms. Keep the verified `caxa` Windows package until it fails its gate or a supported platform change requires a replacement.

- `/healthz` is an unauthenticated process-liveness check.
- `/readyz` returns 200 only when every component required by the active profile is ready: HTTP, Socket.IO, the mediasoup worker, the production SPA bundle, and WHIP when enabled. Development marks the Vite-served SPA as external; disabled WHIP and optional FFmpeg/NVENC fallback do not block readiness. A 503 response includes each component's required flag, state, and WHIP startup error when present.
- An uncaught exception or mediasoup worker death terminates/restarts the process. Run production deployments under a supervisor such as Windows Service management, systemd, or a container restart policy.
- Repeated FFmpeg failure is isolated to its room. Tunnel failures use bounded exponential restart backoff and do not stop LAN service.

Version tags with or without the historical `v` prefix run the complete Windows CI
gate, package the executable, generate a SHA-256 checksum, smoke-test the exact
unsigned artifact, and publish or refresh its GitHub Release automatically. The
release notes identify the unsigned status, tested browser scope, checksum, and
tagged corresponding source. Pull-request CI runs the same packaging and smoke path
without publishing it. Windows may warn when launching an unsigned executable. The
packaged smoke replaces the mediasoup worker, waits for the replacement process,
proves a short decoded-frame Host/view flow in Chromium, shuts the app down, and
fails on leftover caxa extraction or cloudflared processes.
| App closes immediately | Check `%LOCALAPPDATA%\\Nextra\\logs\\startup-latest.log`. |
| Poor quality | Lower resolution/framerate, use a wired connection, and reduce host desktop load. |

---

## Architecture

```text
Browser (Host)                    Server                         Browser (Viewer)
+--------------+    HTTP(S)     +----------------+    WebRTC    +--------------+
| Screen/OBS   | ------------> | mediasoup SFU  | ----------> | Video player |
| capture      |    WebSocket   |                |             |              |
+--------------+               | FFmpeg relay    | -- fMP4 --> | MSE player   |
                               | (H.264 OBS)     |   Socket.IO |              |
OBS Studio                     |                |             +--------------+
+--------------+     WHIP      | WHIP endpoint   |
| Scenes/NDI   | ------------> | (port 3001)     |
| Encoder      |    HTTP/RTP   |                |
+--------------+               +----------------+
```

FFmpeg relay is H.264-only. AV1 OBS rooms stay on mediasoup/WebRTC with room-scoped TURN.

---

## For Developers

```bash
npm install          # install dependencies
npm run dev          # development: hot reload (client + server)
npm run build        # build the client into dist/
npm start            # run the production server (serves dist/; build first)
npm run lint         # lint code
npm test             # unit and real server/subprocess integration tests
npm run test:e2e     # Chromium decoded-frame and browser lifecycle tests
npm run package      # build Nextra.exe + sha256
```

`npm run package` builds `Nextra.exe`, writes `Nextra.exe.sha256`, and bundles runtime dependencies.

Remote Play/Pause control uses the native Windows media-key fallback by default and
`xdotool` on Linux. The dynamically detected `@nut-tree-fork/nut-js` integration is
optional and is not part of the supported default installation.

If `cloudflared` is not available locally, packaging downloads the exact immutable
release declared in `scripts/cloudflared-manifest.json`. Packaging rejects the
asset unless both its pinned SHA-256 and Authenticode signature validate.

> Note: do not commit `Nextra.exe` to git. Distribute it via [GitHub Releases](../../releases).
