# Optional unattended service posture

Nextra remains a single-node, ephemeral application. An operator may run the source server under a supervisor, but this does not imply multi-instance support.

- Run exactly one replica. Rooms, host tokens, media objects, and WHEP/WHIP sessions are process memory and are intentionally lost on restart.
- Use systemd, Windows Service management, or a container restart policy to restart on non-zero exit. Send `SIGTERM`/`SIGINT` and allow the graceful-shutdown window before force-killing.
- Persist only operator configuration, TLS/reverse-proxy configuration, and logs. There is no room database to back up.
- Keep `/api/metrics` local; for scraping, enable the token-gated `/metrics` exporter and store its token in the supervisor secret store.
- Terminate public HTTPS at a maintained reverse proxy. Expose the WebRTC media plane deliberately and provide TURN according to the deployment topology; proxying HTTP alone does not make mediasoup's media listener reachable.
- Pin and monitor absolute FFmpeg/cloudflared executable paths. Validate `/readyz` after every restart and use `/healthz` only as a process-liveness signal.
- Roll back by restoring the prior executable/source revision and configuration together, then restart and verify `/readyz`. Active rooms will reconnect/recreate; they are not migratable state.

External persistence and sticky routing are deliberately absent. N-19 becomes actionable only for a committed multi-instance product, at which point session ownership, distributed admission, room credentials, media affinity, reconciliation, and failure semantics must be designed together.

A Dockerfile/Compose bundle is deliberately not published yet: host networking, UDP/TCP media exposure, GPU/FFmpeg support, TURN, writable paths, and platform support need a declared service target first. This document is the bounded supervisor contract for evaluation deployments, not a container support promise.
