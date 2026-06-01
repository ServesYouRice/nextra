# Nextra

Vibe coded this into existence because the usual screen sharing apps were either limited or paid. If you notice mistakes or want to contribute, feel free to jump in.

TL;DR: there are 2 host modes:

1. Browser capture: easiest setup, direct from Chrome/Edge, lower requirements.
2. OBS ingest: better scenes, overlays, and hardware encoding.
   - H.264 is the stable default path and keeps relay fallback available.
   - AV1 is available for capable GPUs, but it is WebRTC-only and requires BYOK TURN.

You can grab `Nextra.exe` from [GitHub Releases](../../releases), run it, and start sharing. Install OBS only if you want the OBS workflow.

---

## Features

- **Browser capture** - share your screen directly from Chrome/Edge with system audio
- **OBS streaming** - use OBS Studio as the capture source via WHIP ingest, with auto-configuration over OBS WebSocket
- **AV1 OBS rooms** - switch capable NVIDIA, AMD, and Intel GPUs into AV1 for WebRTC-only playback
- **BYOK TURN for AV1** - room-scoped TURN credentials, optional session-only storage, and optional Cloudflare TURN autofill
- **Up to 4K @ 60 fps** - quality profiles adapt to host upload and viewer count
- **WebRTC + Relay playback** - browser capture and AV1 stay on WebRTC; H.264 OBS rooms can fall back to fMP4 relay
- **Public sharing** - built-in Cloudflare quick tunnel for internet viewers with no port forwarding
- **Remote media control** - viewers can pause/play media on the host machine when enabled by the host
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
cd P2Pvideo
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
   - **AV1 WebRTC-only**: enable **Use BYOK TURN (AV1)**. This requires an AV1-capable GPU, OBS auto-configuration, and a TURN config in the modal. Relay fallback is disabled for that room.
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
- AV1 rooms are WebRTC-only. Every viewer needs TURN-reachable connectivity and AV1 playback support in the browser.
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

- Cloudflare quick tunnels do not carry UDP. Without TURN, public viewers prefer relay when relay is allowed.
- AV1 OBS rooms disable relay entirely. If TURN is missing or the browser cannot play AV1, those viewers will fail instead of falling back.
- Only H.264 OBS rooms expose the **Switch to Relay Mode** button.
- The relay player stays near the live edge and auto-recovers from stalls.

---

## Internet Sharing

Packaged `Nextra.exe` automatically starts a Cloudflare quick tunnel and shows a **Public Link** once ready.

For source/dev:

- Set `AUTO_PUBLIC_TUNNEL=true` if you want the app to create a Cloudflare tunnel automatically.
- Ensure the `cloudflared` binary is in the project root or on PATH. Download it from [Cloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
- Or set `SHARE_BASE_URL` if you already have your own reverse proxy or public domain.
- Without either, the app stays local/LAN only.

Tunnel notes:

- Browser capture and OBS H.264 rooms can still serve public viewers without TURN because relay is available.
- OBS AV1 rooms need TURN for public viewers because Cloudflare quick tunnels block UDP and AV1 rooms do not have relay fallback.

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
| `WHIP_HTTP_PORT` | `3001` | HTTP port for WHIP endpoint |
| `FFMPEG_PATH` | `ffmpeg` | Path to FFmpeg binary |
| `FALLBACK_FRAGMENT_DURATION_MS` | `500` | fMP4 fragment duration in ms |
| `FALLBACK_AUDIO_BITRATE` | `192k` | Audio bitrate for relay remux |
| `MAX_FALLBACK_VIEWERS` | `50` | Max concurrent relay viewers |

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
- Cloudflare TURN autofill is only exposed to local/LAN hosts.
- The browser never receives the long-lived Cloudflare API token; it only gets short-lived TURN credentials.

### Public Sharing

| Variable | Default | Description |
|---|---|---|
| `AUTO_PUBLIC_TUNNEL` | `false` from source, `true` in packaged `Nextra.exe` | Auto-start Cloudflare tunnel |
| `SHARE_BASE_URL` | - | Your own public URL (skips tunnel) |
| `PUBLIC_TUNNEL_PROVIDER` | `cloudflared` | Tunnel provider |

### Rooms & Limits

| Variable | Default | Description |
|---|---|---|
| `MAX_VIEWERS_PER_ROOM` | `20` | Max WebRTC viewers per room |
| `MAX_ACTIVE_ROOMS` | `100` | Max active rooms before new hosts are rejected |
| `CREATE_ROOM_RATE_LIMIT_MAX` | `10` | Room creation attempts per IP per window |
| `JOIN_RATE_LIMIT_MAX` | `20` | Viewer join or auto-rejoin attempts per IP per window |
| `HOST_UPLOAD_MBPS` | `36` | Assumed host upload bandwidth |
| `RELAY_VIDEO_BITS_PER_SECOND` | `45000000` | Max relay video bitrate ceiling |
| `MAX_CONNECTIONS_PER_IP` | `60` | Rate limit: connections per IP |
| `SOCKET_PING_TIMEOUT_MS` | `60000` | Grace period before a quiet watcher socket is considered disconnected |
| `MEDIA_DEBUG_LOGS` | `false` | Verbose media-pipeline logging; keep off during normal streams |

See `.env.example` for the full list.

---

## Security and Privacy

- Public HTTPS tunnel links and WebRTC DTLS media encryption in transit
- Room-code based access with no user accounts
- Rate limiting and connection limits on signaling
- OBS WebSocket communication is localhost-only
- Remote media control is host-controllable per room
- Media is not persisted by Nextra
- Cloudflare TURN API tokens remain server-side; only short-lived TURN credentials are sent to the host UI
- `.env`, TLS keys, and binaries are gitignored

Important limits:

- Anyone with the room code or share link can attempt to join.
- Tunnel providers, TURN servers, ISPs, and network operators are external parties.
- Treat this as secure-by-default self-hosted software, not a zero-trust system.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| No public link | Wait a few seconds after startup. In dev, set `AUTO_PUBLIC_TUNNEL=true`. Ensure `cloudflared` exists in the project root or on PATH. |
| Viewers cannot connect | Check host firewall, keep the host app running, and verify whether the room expects TURN or relay. |
| OBS H.264 viewer is black | Try **Switch to Relay Mode** or refresh. H.264 rooms can fall back to relay. |
| AV1 room will not start | AV1 requires an AV1-capable GPU, **Use BYOK TURN (AV1)**, a valid TURN config, and OBS auto-configuration. |
| Public viewers cannot join an AV1 room | Cloudflare quick tunnels block UDP. AV1 rooms need TURN because relay fallback is disabled. |
| Viewer browser says AV1 is unsupported | Use an AV1-capable browser/device or switch the host back to H.264. |
| OBS auto-config fails | Make sure OBS is running and WebSocket is enabled in **Tools > WebSocket Server Settings**. H.264 rooms can fall back to manual WHIP; AV1 rooms cannot. |
| Audio missing | Ensure OBS is capturing audio in the Audio Mixer. For browser capture, use Chrome or Edge. |
| Buffering or stalls | Lower the quality profile or frame rate. H.264 rooms can use relay; AV1 rooms need a stable TURN-backed WebRTC path. |
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
npm run package      # build Nextra.exe + sha256
```

`npm run package` builds `Nextra.exe`, writes `Nextra.exe.sha256`, and bundles runtime dependencies.

If `cloudflared` is not available locally, secure download fallback is disabled by default. To allow it for packaging:

```bash
ALLOW_CLOUDFLARED_DOWNLOAD=1
CLOUDFLARED_DOWNLOAD_SHA256=<expected_sha256>
```

> Note: do not commit `Nextra.exe` to git. Distribute it via [GitHub Releases](../../releases).
