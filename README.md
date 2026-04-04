# Nextra

Vibe coded this into existence as other apps like Discord were always found lacking/required payment. If you notice any mistakes or want to contribute, feel free to do so.

TL;DR: 2 modes of streaming:
1. Everything through a browser from a local server (lower quality, can only stream either browser tabs or entire screen if you want to include audio but easy to start up/low requirements)
2. Stream through OBS, use a browser for management (you can set OBS up either automatically or manually but you have to install it as well, just go on their site) 

You can find the exe file in github releases on the right; just run that (potentially install OBS) and you are good to go.

---

## Features

- **Browser capture** — share your screen directly from Chrome/Edge with system audio
- **OBS streaming** — use OBS Studio as the capture source via WHIP ingest, with auto-configuration over OBS WebSocket
- **Up to 4K @ 60 fps** — quality profiles adapt to host upload and viewer count
- **WebRTC + Relay playback** — viewers get a direct WebRTC stream when possible, or an fMP4 relay when behind strict NAT / tunnels
- **Public sharing** — built-in Cloudflare quick tunnel for internet viewers (no port forwarding)
- **Remote media control** — viewers can pause/play media on the host machine (toggle per room)
- **GPU-aware encoder selection** — detects NVIDIA, AMD, and Intel GPUs for hardware-accelerated H.264 encoding in OBS
- **No accounts or sign-ups** — room-code based access

---

## Quick Start

### Host (Packaged)

1. Download `Nextra.exe` from [GitHub Releases](../../releases).
2. Run it. A browser tab opens to `https://localhost:3000/#host`.
3. Click **Start Sharing**.
4. Send viewers the **Public Link** (internet) or **Local Link** / room code (LAN).

### Host (From Source)

```bash
git clone <repo-url>
cd P2Pvideo
npm install
npm start
```

Open `https://localhost:3000/#host` and share your screen.

### Viewer

1. Open the link the host shared, or navigate to `https://<host>:3000/#watch`.
2. Enter the room code if needed.
3. Click play when prompted.

No install required for viewers.

---

## OBS Streaming

Use OBS Studio instead of browser screen capture for higher quality, custom scenes, and hardware encoding.

### Requirements

- OBS Studio 28+ (ships with WHIP output and WebSocket v5 built-in)
- FFmpeg on the server PATH (for the relay pipeline)

### Setup

1. On the host page, check **Use OBS (WHIP ingest)** before starting.
2. Choose your settings:
   - **Resolution / Frame rate** — determines the quality profile and recommended OBS output settings
   - **Apply recommended output settings** — auto-configures OBS encoder, bitrate, keyframe interval, and low-latency tuning via WebSocket
   - **Encoder** — H.264 (NVENC/AMF/QSV/x264), auto-detected from your GPU
   - **Tuning** — `Balanced`, `Crisp`, or `Max`, which scale bitrate and encoder effort
   - **Auto-start streaming in OBS** — begins streaming immediately after configuration
   - **WS password** — your OBS WebSocket password (leave empty if authentication is disabled in OBS)
3. Click **Start Sharing**. Nextra connects to OBS over WebSocket, configures everything, and starts the stream.

### How It Works

```
OBS  --WHIP-->  Nextra server  --mediasoup-->  FFmpeg  --fMP4-->  viewers (MSE)
                                    |
                                    +--WebRTC-->  viewers (direct, when available)
```

1. OBS streams to the WHIP endpoint (`http://<host>:3001/whip/broadcast/<room>`)
2. The server ingests the RTP stream via mediasoup
3. FFmpeg remuxes the video+audio into fragmented MP4
4. Fragments are pushed to viewers over Socket.IO for MSE playback
5. The host sees a preview of their own stream via the same relay pipeline

### OBS Auto-Configuration

When **Apply recommended output settings** is checked, Nextra sends these settings to OBS via WebSocket:

| Setting | Value |
|---|---|
| Output mode | Advanced |
| Video encoder | H.264 via the best available GPU encoder (NVENC / AMF / QSV / x264 fallback) |
| Video bitrate | Based on selected quality profile, frame rate, and tuning |
| Keyframe interval | 2 seconds |
| Software preset | Based on tuning for x264 |
| NVENC quality preset | Based on tuning (`p5`/`p6`) with full-resolution multipass |
| Output resolution | Matches quality profile (1080p / 1440p / 4K) |
| FPS | 30 or 60 |
| Audio bitrate | 256 kbps |
| Audio sample rate | 48 kHz |
| Rate control | CBR |
| H.264 profile | High |
| H.264 tune | zerolatency |
| B-frames | 0 (lowest latency) |
| Color space | BT.709, Full range |

### Manual OBS Setup (If Auto-Config Fails)

1. In OBS: **Settings > Stream > Service: WHIP**
2. Server: `http://<host-ip>:3001/whip/broadcast/<room-code>`
3. Bearer Token: copy from the host page
4. Recommended output settings: see the table above

---

## Playback Modes

| Mode | Transport | When Used |
|---|---|---|
| **WebRTC** | Direct peer-to-peer via mediasoup | Default for browser capture; best latency |
| **Relay** | fMP4 over Socket.IO + MSE | OBS rooms (default), tunnel viewers, or manual fallback |

- OBS rooms automatically use Relay mode since the WHIP stream doesn't produce a browser-consumable WebRTC track through tunnels.
- Viewers in Relay mode can click **Try WebRTC** to attempt a direct connection.
- The relay player keeps playback at the live edge with ~300ms margin and auto-recovers from stalls.

---

## Internet Sharing

Packaged `Nextra.exe` automatically starts a Cloudflare quick tunnel and shows a **Public Link** once ready.

For source/dev:

- `AUTO_PUBLIC_TUNNEL=true` is only needed for source/dev runs. Packaged `Nextra.exe` already enables it by default.
  - Requires `cloudflared` binary in the project root or on PATH. Download from [Cloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
- Or set `SHARE_BASE_URL` when behind your own reverse proxy/domain.
- Without either, the app stays local/LAN only.

---

## Quality Profiles

Recommended OBS bitrate targets below are for the stable H.264 relay path. The table shows the `Balanced` baseline; `Crisp` adds about 15% and `Max` adds about 30%, with tuned OBS output capped at 45 Mbps.

| Profile | Resolution | H.264 30fps | H.264 60fps |
|---|---|---|---|
| 1080p | 1920x1080 | 12 Mbps | 15 Mbps |
| 1440p | 2560x1440 | 18 Mbps | 24 Mbps |
| 4K | 3840x2160 | 30 Mbps | 40 Mbps |

- The default profile is auto-detected from the host's screen resolution.
- Browser/WebRTC profile caps are 1080p `8 / 12 Mbps`, 1440p `14 / 21 Mbps`, and 4K `26 / 36 Mbps`.
---

## Configuration

Copy `.env.example` to `.env` and edit as needed. Key options:

### Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTPS server port |
| `BIND_HOST` | `127.0.0.1` | Bind address |
| `HTTPS_CERT_DIR` | `./certs` | TLS certificate directory |

### OBS / WHIP

| Variable | Default | Description |
|---|---|---|
| `WHIP_ENABLED` | `true` | Enable WHIP ingest endpoint |
| `WHIP_HTTP_PORT` | `3001` | HTTP port for WHIP endpoint |
| `FFMPEG_PATH` | `ffmpeg` | Path to FFmpeg binary |
| `FALLBACK_FRAGMENT_DURATION_MS` | `500` | fMP4 fragment duration in ms |
| `FALLBACK_AUDIO_BITRATE` | `192k` | Audio bitrate for relay remux |
| `MAX_FALLBACK_VIEWERS` | `50` | Max concurrent relay viewers |

### Public Sharing

| Variable | Default | Description |
|---|---|---|
| `AUTO_PUBLIC_TUNNEL` | `false` from source, `true` in packaged `Nextra.exe` | Auto-start Cloudflare tunnel |
| `SHARE_BASE_URL` | — | Your own public URL (skips tunnel) |
| `PUBLIC_TUNNEL_PROVIDER` | `cloudflared` | Tunnel provider |

### Rooms & Limits

| Variable | Default | Description |
|---|---|---|
| `MAX_VIEWERS_PER_ROOM` | `20` | Max WebRTC viewers per room |
| `HOST_UPLOAD_MBPS` | `36` | Assumed host upload bandwidth |
| `RELAY_VIDEO_BITS_PER_SECOND` | `45000000` | Max relay video bitrate ceiling |
| `MAX_CONNECTIONS_PER_IP` | `60` | Rate limit: connections per IP |

See `.env.example` for the full list.

---

## Security and Privacy

- HTTPS + WebRTC transport encryption in transit
- Room-code based access (no user accounts)
- Rate limiting and connection limits on signaling
- OBS WebSocket communication is localhost-only (no network exposure)
- Remote media control is host-controllable per room
- Media is not persisted by Nextra
- `.env`, TLS keys, and binaries are gitignored

**Important limits:**

- Anyone with the room code/link can attempt to join.
- Tunnel providers, TURN servers, ISPs, and network operators are external parties.
- Treat this as secure-by-default self-hosted software, not a zero-trust system.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| No public link | Wait a few seconds after startup. In dev, set `AUTO_PUBLIC_TUNNEL=true`. Ensure `cloudflared` binary exists. |
| Viewers can't connect | Check host firewall. Keep host app running. Try the relay link. |
| Black screen (host, OBS mode) | Wait for OBS to connect — the preview appears once the WHIP stream is active. |
| Black screen (viewer) | Click **Try WebRTC** or refresh. Check that relay mode is active. |
| Audio missing | Ensure OBS is capturing audio (check Audio Mixer). For browser capture, use Chrome/Edge. |
| OBS auto-config fails | Check OBS is running and WebSocket is enabled (Tools > WebSocket Server Settings). Retry from the host page. |
| Buffering / stalls | Reduce quality profile. Ensure stable network. The player auto-recovers from stalls. |
| App closes immediately | Check `%LOCALAPPDATA%\Nextra\logs\startup-latest.log`. |
| Poor quality | Lower resolution/framerate. Use wired connection. Reduce host desktop load. |

---

## Architecture

```
Browser (Host)                    Server                         Browser (Viewer)
+--------------+     HTTPS      +----------------+    WebRTC    +--------------+
| Screen/OBS   | ------------> | mediasoup SFU   | ----------> | Video player |
| capture      |    WebSocket   |                |              |              |
+--------------+               | FFmpeg relay    | -- fMP4 --> | MSE player   |
                                | (OBS mode)      |   Socket.IO |              |
OBS Studio                     |                |              +--------------+
+--------------+     WHIP      | WHIP endpoint   |
| Scenes/NDI   | ------------> | (port 3001)     |
| Encoder      |    HTTP/RTP   |                |
+--------------+               +----------------+
```

---

## For Developers

```bash
npm install          # install dependencies
npm start            # start dev server
npm run lint         # lint code
npm run build        # production build
npm run package      # build Nextra.exe + sha256
```

`npm run package` builds `Nextra.exe`, writes `Nextra.exe.sha256`, and bundles runtime dependencies.

If `cloudflared` is not available locally, secure download fallback is disabled by default. To allow it for packaging:

```bash
ALLOW_CLOUDFLARED_DOWNLOAD=1
CLOUDFLARED_DOWNLOAD_SHA256=<expected_sha256>
```

> **Note:** Do not commit `Nextra.exe` to git. Distribute via [GitHub Releases](../../releases).
